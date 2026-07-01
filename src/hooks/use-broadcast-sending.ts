'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { toNFC } from '@/lib/text/unicode';
import { useAuth } from '@/hooks/use-auth';
import { Contact, MessageTemplate } from '@/types';
import type { ParsedContactRow } from '@/lib/contacts/parse-contact-csv';
import {
  resolveImportTagIds,
  assignImportedContactTags,
  type ContactTagAssignment,
} from '@/lib/contacts/resolve-import-tags';
import {
  resolveImportCustomFieldIds,
  assignImportedContactCustomValues,
  type ContactCustomFieldAssignment,
} from '@/lib/contacts/resolve-import-custom-fields';

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

export interface AudienceConfig {
  type: 'all' | 'tags' | 'custom_field' | 'csv';
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: ParsedContactRow[];
  /** Contacts carrying any of these tags are subtracted from the result. */
  excludeTagIds?: string[];
}

/**
 * Variable mapping — each template placeholder (by key, usually "1",
 * "2", …) is resolved at send time. `field` maps to a built-in contact
 * field (name/phone/email/company); `custom_field` maps to a
 * contact_custom_values.value row keyed by the custom_fields.id stored
 * in `value`.
 */
export type VariableMapping =
  | { type: 'static'; value: string }
  | { type: 'field'; value: string; fallback?: string }
  | { type: 'custom_field'; value: string; fallback?: string };

interface BroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  /**
   * Media URL for an IMAGE/VIDEO/DOCUMENT header. Required at send
   * time for media-header templates — Meta rejects the send without
   * it. Passed through as `messageParams.headerMediaUrl`; the builder
   * falls back to the template's stored URL only when this is empty.
   */
  headerMediaUrl?: string;
  /**
   * When set, updates this existing broadcast row (e.g. a draft) to
   * status='sending' instead of creating a new row.
   */
  existingBroadcastId?: string;
}

export interface ResendFailedResult {
  resent: number;
  stillFailed: number;
}

interface UseBroadcastSendingReturn {
  createAndSendBroadcast: (payload: BroadcastPayload) => Promise<string>;
  /**
   * Re-sends only the `failed` recipients of an already-sent broadcast.
   * Pass `recipientIds` to resend a specific subset (the per-row retry
   * icon); omit it to resend every failed recipient (the header button).
   * Goes through the same /api/whatsapp/broadcast endpoint, batch size,
   * and inter-batch delay as the original send, so it shares that
   * route's per-recipient retry/backoff and the module-level rate-limit
   * bucket other in-flight broadcasts are also subject to.
   */
  resendFailedRecipients: (
    broadcastId: string,
    recipientIds?: string[],
  ) => Promise<ResendFailedResult>;
  isProcessing: boolean;
  progress: number;
}

/**
 * Meta rate-limit buffer. Each batch is sent to /api/whatsapp/broadcast
 * which adds a 250 ms gap between individual sends server-side. The
 * inter-batch pause here gives Meta (and our server) a breather between
 * API calls so we stay well under their 40 msg/s Cloud API threshold
 * even on low-quality-rated accounts.
 *
 * Effective rate: 5 msgs × (API_latency + 250 ms) ≈ 5 msgs in ~1.75 s,
 * then +2 s pause → ~1.7 msgs/s sustained. Adjusting these two constants
 * is the only knob needed to trade speed for safety.
 */
const SEND_BATCH_SIZE = 5;
const SEND_BATCH_DELAY_MS = 2000;

/** `broadcast_recipients` inserts are independent of the send rate. */
const INSERT_BATCH_SIZE = 200;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BroadcastApiResult {
  phone: string;
  status: 'sent' | 'failed';
  whatsapp_message_id?: string;
  error?: string;
}

/** contactId → (customFieldId → value). */
type CustomValueIndex = Map<string, Map<string, string>>;

/**
 * Per-contact resolution of custom-field placeholders. Static and
 * built-in-field mappings resolve synchronously; custom fields read
 * from a pre-built index to avoid N+1 queries during the send loop.
 */
function resolveOneVariable(
  v: VariableMapping,
  contact: Contact,
  customValues?: Map<string, string>,
): string {
  if (v.type === 'static') return v.value;
  if (v.type === 'field') {
    const fieldMap: Record<string, string | undefined> = {
      name: contact.name,
      phone: contact.phone,
      email: contact.email,
      company: contact.company,
    };
    return fieldMap[v.value] ?? v.fallback ?? '';
  }
  // custom_field
  return customValues?.get(v.value) ?? v.fallback ?? '';
}

export function resolveVariables(
  variables: Record<string, VariableMapping>,
  contact: Contact,
  customValues?: Map<string, string>,
): string[] {
  const keys = Object.keys(variables);
  // Numbered keys ({{1}}, {{2}}…): sort numerically.
  const allNumeric = keys.every((k) => Number.isFinite(Number(k)));
  if (allNumeric) {
    keys.sort((a, b) => Number(a) - Number(b));
  }
  return keys.map((key) => resolveOneVariable(variables[key], contact, customValues));
}

/**
 * For templates with named variables ({{nome_cliente}}), Meta requires
 * each parameter to carry a `parameter_name` field. Returns an array of
 * { value, paramName } pairs preserving the order of first appearance in
 * the template body, which is the order the caller built `variables` in.
 */
export function resolveNamedVariables(
  variables: Record<string, VariableMapping>,
  contact: Contact,
  customValues?: Map<string, string>,
): { value: string; paramName: string }[] {
  return Object.keys(variables).map((key) => ({
    value: resolveOneVariable(variables[key], contact, customValues),
    paramName: key,
  }));
}

/**
 * Bulk-fetch contact_custom_values for a set of contacts. Returns an
 * index keyed by contact_id → field_id → value.
 */
async function fetchCustomValueIndex(
  supabase: ReturnType<typeof createClient>,
  contactIds: string[],
): Promise<CustomValueIndex> {
  const index: CustomValueIndex = new Map();
  if (contactIds.length === 0) return index;

  // Supabase PostgREST caps the .in(...) IN-clause roughly at 1000
  // values. Page through to stay safe.
  const PAGE = 500;
  for (let i = 0; i < contactIds.length; i += PAGE) {
    const slice = contactIds.slice(i, i + PAGE);
    const { data } = await supabase
      .from('contact_custom_values')
      .select('contact_id, custom_field_id, value')
      .in('contact_id', slice);

    for (const row of data ?? []) {
      const bucket = index.get(row.contact_id) ?? new Map<string, string>();
      bucket.set(row.custom_field_id, row.value ?? '');
      index.set(row.contact_id, bucket);
    }
  }
  return index;
}

export function useBroadcastSending(): UseBroadcastSendingReturn {
  const { accountId, canEditSettings } = useAuth();
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  async function resolveAudience(audience: AudienceConfig): Promise<Contact[]> {
    const supabase = createClient();

    let contacts: Contact[] = [];

    if (audience.type === 'all') {
      const { data, error } = await supabase.from('contacts').select('*');
      if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
      contacts = data ?? [];
    } else if (
      audience.type === 'tags' &&
      audience.tagIds &&
      audience.tagIds.length > 0
    ) {
      const { data: contactTags, error: tagError } = await supabase
        .from('contact_tags')
        .select('contact_id')
        .in('tag_id', audience.tagIds);

      if (tagError)
        throw new Error(`Failed to fetch contact tags: ${tagError.message}`);

      if (contactTags && contactTags.length > 0) {
        const uniqueContactIds = [
          ...new Set(contactTags.map((ct) => ct.contact_id)),
        ];
        const { data, error } = await supabase
          .from('contacts')
          .select('*')
          .in('id', uniqueContactIds);
        if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
        contacts = data ?? [];
      }
    } else if (audience.type === 'custom_field' && audience.customField) {
      contacts = await resolveCustomFieldAudience(supabase, audience.customField);
    } else if (audience.type === 'csv' && audience.csvContacts) {
      contacts = await upsertCsvContacts(supabase, audience.csvContacts);
    }

    // Apply exclude tags (works across all contact-derived audience
    // types). CSV contacts are synthetic so exclusion doesn't apply.
    if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
      const { data: excludeRows } = await supabase
        .from('contact_tags')
        .select('contact_id')
        .in('tag_id', audience.excludeTagIds);
      const excludedIds = new Set((excludeRows ?? []).map((r) => r.contact_id));
      contacts = contacts.filter((c) => !excludedIds.has(c.id));
    }

    return contacts;
  }

  /**
   * CSV uploads arrive as parsed rows, not DB rows. Before we can insert
   * broadcast_recipients (whose contact_id FKs contacts.id), we need real
   * contacts.id UUIDs. So: look up each CSV phone in the account's
   * contacts table; insert any that don't exist (with name/email/company);
   * resolve + assign any tags and custom field values the CSV carried
   * (same resolution helpers the full Contacts import uses); return the
   * resolved set.
   *
   * Pre-existing implementation synthesized `csv-N` strings as
   * contact_id, which failed the UUID cast on insert — every CSV
   * broadcast silently created zero recipients. It also only carried
   * phone/name, silently dropping email/company/tags/custom fields from
   * the CSV.
   */
  async function upsertCsvContacts(
    supabase: ReturnType<typeof createClient>,
    csvRows: ParsedContactRow[],
  ): Promise<Contact[]> {
    if (csvRows.length === 0) return [];

    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      throw new Error('You are not signed in.');
    }
    if (!accountId) {
      throw new Error('Your profile is not linked to an account.');
    }

    // De-duplicate by phone within the CSV (users can paste duplicates).
    const uniqueByPhone = new Map<string, ParsedContactRow>();
    for (const row of csvRows) {
      if (row.phone) uniqueByPhone.set(row.phone, row);
    }
    const phones = [...uniqueByPhone.keys()];

    // Single round-trip lookup of existing contacts in this account.
    const { data: existing, error: lookupErr } = await supabase
      .from('contacts')
      .select('*')
      .eq('account_id', accountId)
      .in('phone', phones);
    if (lookupErr) {
      throw new Error(`Failed to look up CSV contacts: ${lookupErr.message}`);
    }

    const byPhone = new Map<string, Contact>();
    for (const c of (existing ?? []) as Contact[]) {
      if (c.phone) byPhone.set(c.phone, c);
    }

    // Insert only missing contacts, in one batch per 200 rows (PostgREST
    // has a default payload cap — 200 keeps individual requests small).
    const missing = phones
      .filter((p) => !byPhone.has(p))
      .map((phone) => {
        const row = uniqueByPhone.get(phone)!;
        return {
          user_id: user.id,
          account_id: accountId,
          phone,
          name: row.name || null,
          email: row.email || null,
          company: row.company || null,
        };
      });

    const INSERT_CHUNK = 200;
    for (let i = 0; i < missing.length; i += INSERT_CHUNK) {
      const chunk = missing.slice(i, i + INSERT_CHUNK);
      const { data: inserted, error: insertErr } = await supabase
        .from('contacts')
        .insert(chunk)
        .select();
      if (insertErr) {
        throw new Error(`Failed to create CSV contacts: ${insertErr.message}`);
      }
      for (const c of (inserted ?? []) as Contact[]) {
        if (c.phone) byPhone.set(c.phone, c);
      }
    }

    // Resolve + assign tags (admin+ may auto-create missing ones — same
    // rule the Contacts import screen uses). Applied to every matched
    // row, not just newly-created contacts: uploading a CSV to build a
    // broadcast audience is itself a tagging action for pre-existing
    // contacts too.
    const allTagNames = phones.flatMap((p) => uniqueByPhone.get(p)!.tagNames);
    if (allTagNames.length > 0) {
      const { tagIdByKey } = await resolveImportTagIds(supabase, {
        accountId,
        userId: user.id,
        tagNames: allTagNames,
        canCreateTags: canEditSettings,
      });
      const tagAssignments: ContactTagAssignment[] = phones
        .map((p) => {
          const row = uniqueByPhone.get(p)!;
          const contact = byPhone.get(p);
          return contact && row.tagNames.length > 0
            ? { contactId: contact.id, tagNames: row.tagNames }
            : null;
        })
        .filter((a): a is ContactTagAssignment => a !== null);
      await assignImportedContactTags(supabase, tagAssignments, tagIdByKey);
    }

    // Resolve + assign custom field values. Not auto-created — a CSV
    // header that doesn't match an existing custom field is silently
    // skipped, same as the Contacts import screen.
    const customFieldNames = [
      ...new Set(
        phones.flatMap((p) => Object.keys(uniqueByPhone.get(p)!.customFieldValues)),
      ),
    ];
    if (customFieldNames.length > 0) {
      const { fieldIdByName } = await resolveImportCustomFieldIds(supabase, {
        accountId,
        fieldNames: customFieldNames,
      });
      const customFieldAssignments: ContactCustomFieldAssignment[] = [];
      for (const p of phones) {
        const row = uniqueByPhone.get(p)!;
        const contact = byPhone.get(p);
        if (!contact) continue;
        for (const [fieldName, value] of Object.entries(row.customFieldValues)) {
          const fieldId = fieldIdByName.get(fieldName);
          if (fieldId) {
            customFieldAssignments.push({ contactId: contact.id, fieldId, value });
          }
        }
      }
      await assignImportedContactCustomValues(supabase, customFieldAssignments);
    }

    // Preserve input order so analytics roughly matches the CSV order.
    return phones
      .map((p) => byPhone.get(p))
      .filter((c): c is Contact => Boolean(c));
  }

  async function resolveCustomFieldAudience(
    supabase: ReturnType<typeof createClient>,
    filter: CustomFieldFilter,
  ): Promise<Contact[]> {
    const { fieldId, operator } = filter;
    const value = toNFC(filter.value);

    // Standard contact fields (name, email, phone, company) are stored in
    // the contacts table directly. Custom fields go through contact_custom_values.
    if (fieldId.startsWith('__contact_')) {
      const rawCol = fieldId.replace('__contact_', '');
      // phone_normalized contains only digits, making phone searches resilient
      // to formatting differences (+55, spaces, dashes in the raw phone column).
      const col = rawCol === 'phone' ? 'phone_normalized' : rawCol;
      let q = supabase.from('contacts').select('*');
      if (operator === 'is') q = q.eq(col, value);
      else if (operator === 'is_not') q = q.neq(col, value);
      else q = q.ilike(col, `%${value}%`);
      const { data, error } = await q;
      if (error) throw new Error(`Contact field filter failed: ${error.message}`);
      return data ?? [];
    }

    let query = supabase
      .from('contact_custom_values')
      .select('contact_id')
      .eq('custom_field_id', fieldId);

    if (operator === 'is') query = query.eq('value', value);
    else if (operator === 'is_not') query = query.neq('value', value);
    else if (operator === 'contains') query = query.ilike('value', `%${value}%`);

    const { data: matches, error: matchErr } = await query;
    if (matchErr)
      throw new Error(`Custom-field filter failed: ${matchErr.message}`);

    const contactIds = [...new Set((matches ?? []).map((m) => m.contact_id))];
    if (contactIds.length === 0) return [];

    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .in('id', contactIds);
    if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
    return data ?? [];
  }

  async function resendFailedRecipients(
    broadcastId: string,
    recipientIds?: string[],
  ): Promise<ResendFailedResult> {
    setIsProcessing(true);
    setProgress(0);
    const supabase = createClient();

    try {
      const { data: broadcastRow, error: broadcastErr } = await supabase
        .from('broadcasts')
        .select('template_name, template_language, template_variables')
        .eq('id', broadcastId)
        .single();
      if (broadcastErr || !broadcastRow) {
        throw new Error('Broadcast not found.');
      }

      const { data: templateData, error: templateErr } = await supabase
        .from('message_templates')
        .select('*')
        .eq('name', broadcastRow.template_name)
        .eq('language', broadcastRow.template_language)
        .single();
      if (templateErr || !templateData) {
        throw new Error(`Template "${broadcastRow.template_name}" not found.`);
      }
      const template = templateData as MessageTemplate;

      let recipientsQuery = supabase
        .from('broadcast_recipients')
        .select('*, contact:contacts(*)')
        .eq('broadcast_id', broadcastId)
        .eq('status', 'failed');
      if (recipientIds && recipientIds.length > 0) {
        recipientsQuery = recipientsQuery.in('id', recipientIds);
      }
      const { data: recipients, error: recipientsErr } = await recipientsQuery;
      if (recipientsErr) {
        throw new Error(`Failed to load failed recipients: ${recipientsErr.message}`);
      }
      if (!recipients || recipients.length === 0) {
        return { resent: 0, stillFailed: 0 };
      }

      const variables = (broadcastRow.template_variables ?? {}) as Record<
        string,
        VariableMapping
      >;
      const contactIds = recipients
        .map((r) => r.contact?.id)
        .filter((id): id is string => Boolean(id));
      const customValueIndex = await fetchCustomValueIndex(supabase, contactIds);

      const variableKeys = Object.keys(variables);
      const hasNamedVars =
        variableKeys.length > 0 &&
        variableKeys.some((k) => !Number.isFinite(Number(k)));

      // Media-header templates get no stored URL to reuse on a resend —
      // the server falls back to the template's own stored URL when
      // messageParams.headerMediaUrl is omitted (see meta-api.ts).

      let resent = 0;
      let stillFailed = 0;
      const total = recipients.length;

      for (let i = 0; i < recipients.length; i += SEND_BATCH_SIZE) {
        const batch = recipients.slice(i, i + SEND_BATCH_SIZE);

        const apiRecipients = batch
          .filter((r) => r.contact?.phone)
          .map((r) => {
            const contact = r.contact!;
            const customValues = customValueIndex.get(contact.id);

            if (hasNamedVars) {
              const bodyNamed = resolveNamedVariables(variables, contact, customValues);
              return {
                phone: contact.phone as string,
                params: [] as string[],
                messageParams: { bodyNamed },
              };
            }

            return {
              phone: contact.phone as string,
              params: resolveVariables(variables, contact, customValues),
            };
          });

        if (apiRecipients.length > 0) {
          try {
            const res = await fetch('/api/whatsapp/broadcast', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                recipients: apiRecipients,
                template_name: template.name,
                template_language: template.language ?? 'en_US',
              }),
            });

            const data = await res.json();
            if (!res.ok) {
              throw new Error(data.error || 'Broadcast API request failed');
            }

            const resultsByPhone = new Map<string, BroadcastApiResult>();
            for (const r of (data.results ?? []) as BroadcastApiResult[]) {
              resultsByPhone.set(r.phone, r);
            }

            for (const recipient of batch) {
              const phone = recipient.contact?.phone;
              const result = phone ? resultsByPhone.get(phone) : undefined;

              if (!result) {
                stillFailed++;
                await supabase
                  .from('broadcast_recipients')
                  .update({
                    status: 'failed',
                    error_message: 'No phone number on contact',
                  })
                  .eq('id', recipient.id);
                continue;
              }

              if (result.status === 'sent') {
                resent++;
                await supabase
                  .from('broadcast_recipients')
                  .update({
                    status: 'sent',
                    sent_at: new Date().toISOString(),
                    whatsapp_message_id: result.whatsapp_message_id ?? null,
                    error_message: null,
                  })
                  .eq('id', recipient.id);
              } else {
                stillFailed++;
                await supabase
                  .from('broadcast_recipients')
                  .update({
                    status: 'failed',
                    error_message: result.error ?? 'Unknown error',
                  })
                  .eq('id', recipient.id);
              }
            }
          } catch (err) {
            for (const recipient of batch) {
              stillFailed++;
              await supabase
                .from('broadcast_recipients')
                .update({
                  status: 'failed',
                  error_message: err instanceof Error ? err.message : 'Unknown error',
                })
                .eq('id', recipient.id);
            }
          }
        }

        setProgress(Math.round(((i + batch.length) / total) * 100));

        // Same inter-batch pacing as the original send, so a resend
        // running concurrently with another broadcast's send loop
        // contends for Meta's rate limit the same way both were
        // designed to.
        if (i + SEND_BATCH_SIZE < recipients.length) {
          await sleep(SEND_BATCH_DELAY_MS);
        }
      }

      return { resent, stillFailed };
    } finally {
      setIsProcessing(false);
    }
  }

  async function createAndSendBroadcast(payload: BroadcastPayload): Promise<string> {
    setIsProcessing(true);
    setProgress(0);

    const supabase = createClient();

    try {
      // ── Step 0: Resolve current user ──────────────────────────────
      // broadcasts.user_id is NOT NULL + guarded by RLS
      // (auth.uid() = user_id). Without this, the INSERT below was
      // silently failing with 23502 / 42501 — the wizard would
      // no-op with no feedback.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) {
        throw new Error('You are not signed in.');
      }
      if (!accountId) {
        throw new Error('Your profile is not linked to an account.');
      }

      // ── Step 1: Resolve audience contacts ─────────────────────────
      setProgress(5);
      const contacts = await resolveAudience(payload.audience);

      if (contacts.length === 0) {
        throw new Error('No contacts found for this audience.');
      }

      // ── Step 2: Create or update broadcast row ────────────────────
      setProgress(10);
      let broadcastId: string;

      if (payload.existingBroadcastId) {
        const { error: updateError } = await supabase
          .from('broadcasts')
          .update({
            status: 'sending',
            total_recipients: contacts.length,
            sent_count: 0,
            delivered_count: 0,
            read_count: 0,
            replied_count: 0,
            failed_count: 0,
          })
          .eq('id', payload.existingBroadcastId);
        if (updateError) {
          throw new Error(`Failed to update broadcast: ${updateError.message}`);
        }
        broadcastId = payload.existingBroadcastId;
      } else {
        const { data: newBroadcast, error: broadcastError } = await supabase
          .from('broadcasts')
          .insert({
            user_id: user.id,
            account_id: accountId,
            name: payload.name,
            template_name: payload.template.name,
            template_language: payload.template.language ?? 'en_US',
            template_variables: payload.variables,
            audience_filter: {
              type: payload.audience.type,
              tagIds: payload.audience.tagIds,
              customField: payload.audience.customField,
              excludeTagIds: payload.audience.excludeTagIds,
            },
            status: 'sending',
            total_recipients: contacts.length,
            sent_count: 0,
            delivered_count: 0,
            read_count: 0,
            replied_count: 0,
            failed_count: 0,
          })
          .select()
          .single();
        if (broadcastError || !newBroadcast) {
          throw new Error(
            `Failed to create broadcast: ${broadcastError?.message ?? 'unknown error'}`,
          );
        }
        broadcastId = newBroadcast.id;
      }

      // ── Step 3: Insert recipient rows ─────────────────────────────
      setProgress(20);
      const recipientRows = contacts.map((contact) => ({
        broadcast_id: broadcastId,
        contact_id: contact.id,
        status: 'pending' as const,
      }));

      for (let i = 0; i < recipientRows.length; i += INSERT_BATCH_SIZE) {
        const batch = recipientRows.slice(i, i + INSERT_BATCH_SIZE);
        const { error: recipientError } = await supabase
          .from('broadcast_recipients')
          .insert(batch);
        if (recipientError) {
          // Previous impl logged and marched on — the broadcast then ran
          // with an incomplete recipient set, so webhook status updates
          // couldn't find some rows and the aggregate counts drifted.
          // Flip the broadcast to failed so the user sees the problem
          // immediately, then throw to abort the send loop.
          await supabase
            .from('broadcasts')
            .update({
              status: 'failed',
              failed_count: contacts.length,
            })
            .eq('id', broadcastId);
          throw new Error(
            `Failed to insert recipient batch ${i / INSERT_BATCH_SIZE + 1}: ${recipientError.message}`,
          );
        }
      }

      // ── Step 4: Fetch recipients (joined contact) + preload custom values
      setProgress(30);
      const { data: recipients, error: recipientsFetchError } = await supabase
        .from('broadcast_recipients')
        .select('*, contact:contacts(*)')
        .eq('broadcast_id', broadcastId);

      if (recipientsFetchError || !recipients) {
        throw new Error('Failed to fetch broadcast recipients');
      }

      // One bulk fetch of custom values for every contact in this
      // broadcast, avoiding N+1 during the send loop.
      const contactIds = recipients
        .map((r) => r.contact?.id)
        .filter((id): id is string => Boolean(id));
      const customValueIndex = await fetchCustomValueIndex(
        supabase,
        contactIds,
      );

      let failedCount = 0;
      const totalRecipients = recipients.length;

      // Media-header templates (image/video/document) require a media
      // URL on every send. Collected in the personalize step and applied
      // to all recipients; falls back to the template's stored URL on the
      // server when omitted.
      const headerType = payload.template.header_type;
      const isMediaHeader =
        headerType === 'image' ||
        headerType === 'video' ||
        headerType === 'document';
      const headerMediaUrl = payload.headerMediaUrl?.trim();
      const sharedMessageParams =
        isMediaHeader && headerMediaUrl ? { headerMediaUrl } : undefined;

      // Detect whether this template uses named ({{nome_cliente}}) or
      // positional ({{1}}) variables. Named templates require parameter_name
      // on each body parameter per Meta's Cloud API spec.
      const variableKeys = Object.keys(payload.variables);
      const hasNamedVars =
        variableKeys.length > 0 &&
        variableKeys.some((k) => !Number.isFinite(Number(k)));

      for (let i = 0; i < recipients.length; i += SEND_BATCH_SIZE) {
        const batch = recipients.slice(i, i + SEND_BATCH_SIZE);

        const apiRecipients = batch
          .filter((r) => r.contact?.phone)
          .map((r) => {
            const contact = r.contact!;
            const customValues = customValueIndex.get(contact.id);

            if (hasNamedVars) {
              const bodyNamed = resolveNamedVariables(
                payload.variables,
                contact,
                customValues,
              );
              return {
                phone: contact.phone as string,
                params: [] as string[],
                messageParams: { ...sharedMessageParams, bodyNamed },
              };
            }

            return {
              phone: contact.phone as string,
              params: resolveVariables(payload.variables, contact, customValues),
              ...(sharedMessageParams ? { messageParams: sharedMessageParams } : {}),
            };
          });

        if (apiRecipients.length === 0) continue;

        try {
          const res = await fetch('/api/whatsapp/broadcast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              recipients: apiRecipients,
              template_name: payload.template.name,
              template_language: payload.template.language ?? 'en_US',
            }),
          });

          const data = await res.json();

          if (!res.ok) {
            throw new Error(data.error || 'Broadcast API request failed');
          }

          const resultsByPhone = new Map<string, BroadcastApiResult>();
          for (const r of (data.results ?? []) as BroadcastApiResult[]) {
            resultsByPhone.set(r.phone, r);
          }

          for (const recipient of batch) {
            const phone = recipient.contact?.phone;
            const result = phone ? resultsByPhone.get(phone) : undefined;

            if (!result) {
              failedCount++;
              await supabase
                .from('broadcast_recipients')
                .update({
                  status: 'failed',
                  error_message: 'No phone number on contact',
                })
                .eq('id', recipient.id);
              continue;
            }

            if (result.status === 'sent') {
              await supabase
                .from('broadcast_recipients')
                .update({
                  status: 'sent',
                  sent_at: new Date().toISOString(),
                  whatsapp_message_id: result.whatsapp_message_id ?? null,
                  error_message: null,
                })
                .eq('id', recipient.id);
            } else {
              failedCount++;
              await supabase
                .from('broadcast_recipients')
                .update({
                  status: 'failed',
                  error_message: result.error ?? 'Unknown error',
                })
                .eq('id', recipient.id);
            }
          }
        } catch (err) {
          for (const recipient of batch) {
            failedCount++;
            await supabase
              .from('broadcast_recipients')
              .update({
                status: 'failed',
                error_message: err instanceof Error ? err.message : 'Unknown error',
              })
              .eq('id', recipient.id);
          }
        }

        const progressPct =
          30 + Math.round(((i + batch.length) / totalRecipients) * 60);
        setProgress(progressPct);

        if (i + SEND_BATCH_SIZE < recipients.length) {
          await sleep(SEND_BATCH_DELAY_MS);
        }
      }

      // ── Step 5: Finalize status ───────────────────────────────────
      // Aggregate counts are maintained by the DB trigger (migration
      // 003); we only flip the final status here.
      setProgress(95);
      const finalStatus = failedCount === totalRecipients ? 'failed' : 'sent';
      await supabase
        .from('broadcasts')
        .update({ status: finalStatus })
        .eq('id', broadcastId);

      setProgress(100);
      return broadcastId;
    } finally {
      setIsProcessing(false);
    }
  }

  return { createAndSendBroadcast, resendFailedRecipients, isProcessing, progress };
}
