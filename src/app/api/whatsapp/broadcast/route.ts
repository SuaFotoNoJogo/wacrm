import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder'
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

/**
 * Minimum gap between consecutive sends inside a batch — smooths the
 * burst so we stay ~4 msgs/s, well below Meta's 40 msg/s threshold.
 */
const PER_MESSAGE_DELAY_MS = 250

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

// ── Shared rate-limit backoff ────────────────────────────────────────────────
// Module-level so ALL concurrent broadcast requests from this process
// share the same bucket. When any send hits Meta's 130429, every other
// in-flight broadcast respects the same backoff before its next message,
// preventing a pile-up of rejected calls during the cooldown window.
//
// Single-process only — multi-instance deploys need Redis (same swap as
// rate-limit.ts). The logic is intentionally simple: no locks, no
// promises. A tiny race window on `rlBackoffMs` is acceptable because the
// consequence is sending one extra message slightly too early, not data
// loss.

let rlBackoffMs = 0       // current sleep duration; 0 = no active limit
let rlLastHitAt  = 0       // wall-clock ms of the most recent 130429

const RL_INITIAL_MS     = 2_000   // first backoff: 2 s
const RL_MAX_MS         = 64_000  // cap: 64 s  (2^5 × 2)
const RL_RESET_AFTER_MS = 60_000  // decay to 0 after 60 s with no new hit
const RL_MAX_RETRIES    = 4       // attempts per recipient before giving up

/** Call when Meta returns 130429. Doubles the shared backoff and returns it. */
function onRateLimitHit(): number {
  rlLastHitAt  = Date.now()
  rlBackoffMs  = rlBackoffMs === 0
    ? RL_INITIAL_MS
    : Math.min(rlBackoffMs * 2, RL_MAX_MS)
  return rlBackoffMs
}

/** Returns the current shared backoff, decaying it to 0 if stale. */
function currentBackoffMs(): number {
  if (rlBackoffMs > 0 && Date.now() - rlLastHitAt > RL_RESET_AFTER_MS) {
    rlBackoffMs = 0
  }
  return rlBackoffMs
}

/**
 * Errors from Meta that are transient and safe to retry with backoff.
 *   130429  — Cloud API temporary rate limit
 *   (#2)    — "Service temporarily unavailable" (Meta server-side blip)
 *   [2]     — same, after our code-prefix formatting in throwMetaError
 *   131000  — "Something went wrong" (generic Meta server error, usually transient)
 *   [131000]— same after code-prefix formatting
 */
function isRetriableError(msg: string): boolean {
  return (
    msg.includes('130429') ||
    msg.includes('(#2)')   ||
    msg.includes('[2]')    ||
    msg.includes('131000')
  )
}

interface SendArgs {
  phoneNumberId: string
  accessToken: string
  templateName: string
  language: string
  template: Parameters<typeof sendTemplateMessage>[0]['template']
  messageParams: Parameters<typeof sendTemplateMessage>[0]['messageParams']
  params: string[]
}

/**
 * Try to send to each phone variant in order. Returns the messageId on
 * success, or throws the last error if no variant succeeded.
 * "Recipient not in allowed list" moves to the next variant;
 * any other error (including 130429) is re-thrown immediately so the
 * caller can apply backoff and retry the whole attempt.
 */
async function trySendVariants(variants: string[], args: SendArgs): Promise<string> {
  let lastErr = 'No variants available'
  for (const variant of variants) {
    try {
      const result = await sendTemplateMessage({ ...args, to: variant })
      return result.messageId
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      if (!isRecipientNotAllowedError(msg)) throw err  // propagate (inc. 130429)
      lastErr = msg
    }
  }
  throw new Error(lastErr)
}

interface BroadcastResult {
  phone: string
  status: 'sent' | 'failed'
  whatsapp_message_id?: string
  error?: string
}

/**
 * Two input shapes are accepted:
 *
 *   NEW (preferred — supports per-recipient variable substitution):
 *     {
 *       recipients: Array<{ phone: string; params: string[] }>,
 *       template_name, template_language
 *     }
 *
 *   LEGACY (all phones receive the same params — kept so existing
 *   callers don't break):
 *     {
 *       phone_numbers: string[],
 *       template_params: string[],
 *       template_name, template_language
 *     }
 *
 * Previous implementation only supported the legacy shape, and the
 * sending hook was forced to ship every batch with `templateParams[0]`
 * — meaning every recipient got contact-0's personalization. The new
 * shape is what actually fixes that.
 */
interface NewRecipient {
  phone: string
  /** Body variable values, one per {{N}}. Legacy field. */
  params?: string[]
  /**
   * Structured per-send values (header text variable, media URL
   * override, URL/COPY_CODE button values). When set, takes
   * precedence over `params` for the body too — see
   * sendTemplateMessage for the merge rules.
   */
  messageParams?: SendTimeParams
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Per-user broadcast budget. Note: this limits how often a user
    // can *start* a campaign, not how many messages go out inside
    // one — the fan-out loop below runs without additional gating.
    const limit = checkRateLimit(`broadcast:${user.id}`, RATE_LIMITS.broadcast)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    // Resolve the caller's account_id. whatsapp_config + templates
    // + broadcasts are all account-scoped post-multi-user, so the
    // old `.eq('user_id', user.id)` filters miss every row created
    // by a teammate.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const body = await request.json()
    const {
      recipients: newRecipients,
      phone_numbers,
      template_name,
      template_language,
      template_params,
    } = body

    // Normalize to a list of {phone, params} regardless of shape.
    let recipients: NewRecipient[]
    if (Array.isArray(newRecipients) && newRecipients.length > 0) {
      recipients = newRecipients
    } else if (Array.isArray(phone_numbers) && phone_numbers.length > 0) {
      const shared: string[] = Array.isArray(template_params)
        ? template_params
        : []
      recipients = phone_numbers.map((phone: string) => ({
        phone,
        params: shared,
      }))
    } else {
      return NextResponse.json(
        {
          error:
            'Provide either `recipients` (preferred) or `phone_numbers` — must be a non-empty array',
        },
        { status: 400 }
      )
    }

    if (!template_name) {
      return NextResponse.json(
        { error: 'template_name is required' },
        { status: 400 }
      )
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        {
          error:
            'WhatsApp not configured. Please set up your WhatsApp integration first.',
        },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)

    // Load the template row once so sendTemplateMessage can build
    // header + button components on each iteration. Loading inside
    // the loop would N+1 against Supabase for every recipient.
    // Guard against a malformed local row crashing every send in
    // the loop with the same opaque TypeError — fail loudly once.
    const { data: rawTemplateRow } = await supabase
      .from('message_templates')
      .select('*')
      .eq('account_id', accountId)
      .eq('name', template_name)
      .eq('language', template_language || 'en_US')
      .maybeSingle()
    if (rawTemplateRow && !isMessageTemplate(rawTemplateRow)) {
      return NextResponse.json(
        {
          error:
            'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
        },
        { status: 500 },
      )
    }
    const templateRow = rawTemplateRow ?? null

    const results: BroadcastResult[] = []
    let sentCount = 0
    let failedCount = 0

    const sendArgs: SendArgs = {
      phoneNumberId: config.phone_number_id,
      accessToken,
      templateName: template_name,
      language: template_language || 'en_US',
      template: templateRow ?? undefined,
      messageParams: undefined,
      params: [],
    }

    for (let ri = 0; ri < recipients.length; ri++) {
      const recipient = recipients[ri]

      // Fixed spacing between messages (smooths burst rate).
      if (ri > 0) await sleep(PER_MESSAGE_DELAY_MS)

      // If another concurrent broadcast already triggered a rate limit,
      // respect the shared backoff before even attempting this message.
      const preBackoff = currentBackoffMs()
      if (preBackoff > 0) await sleep(preBackoff)

      const sanitized = sanitizePhoneForMeta(recipient.phone)
      if (!isValidE164(sanitized)) {
        results.push({ phone: recipient.phone, status: 'failed', error: 'Invalid phone number format' })
        failedCount++
        continue
      }

      const variants = phoneVariants(sanitized)
      const args: SendArgs = {
        ...sendArgs,
        messageParams: recipient.messageParams,
        params: recipient.params ?? [],
      }

      let sentMessageId: string | null = null
      let lastError: string | null = null

      // Outer loop: retry on 130429 with progressive backoff.
      for (let attempt = 0; attempt <= RL_MAX_RETRIES; attempt++) {
        try {
          sentMessageId = await trySendVariants(variants, args)
          lastError = null
          break
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error'
          lastError = msg

          if (isRetriableError(msg) && attempt < RL_MAX_RETRIES) {
            const backoff = onRateLimitHit()
            console.warn(
              `[broadcast] retriable error (attempt ${attempt + 1}/${RL_MAX_RETRIES + 1}), ` +
              `backing off ${backoff / 1000}s — ${msg} (recipient: ${recipient.phone})`
            )
            await sleep(backoff)
            // loop continues with attempt + 1
          } else {
            // Non-rate-limit error, or retries exhausted.
            if (isRetriableError(msg)) {
              console.error(
                `[broadcast] retriable error — retries exhausted after ${RL_MAX_RETRIES} attempts, ` +
                `giving up on ${recipient.phone}: ${msg}`
              )
            }
            break
          }
        }
      }

      if (sentMessageId) {
        results.push({ phone: recipient.phone, status: 'sent', whatsapp_message_id: sentMessageId })
        sentCount++
      } else {
        console.error(`[broadcast] failed to send to ${recipient.phone}:`, lastError)
        results.push({ phone: recipient.phone, status: 'failed', error: lastError || 'Unknown error' })
        failedCount++
      }
    }

    return NextResponse.json({
      success: true,
      total: recipients.length,
      sent: sentCount,
      failed: failedCount,
      results,
    })
  } catch (error) {
    console.error('Error in WhatsApp broadcast POST:', error)
    return NextResponse.json(
      { error: 'Failed to process broadcast' },
      { status: 500 }
    )
  }
}
