"use client"

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  ArrowLeft,
  ChevronDown,
  Plus,
  Trash2,
  GripVertical,
  MessageSquare,
  FileText,
  Tag,
  TagIcon,
  UserCheck,
  PencilLine,
  Briefcase,
  Hourglass,
  GitBranch,
  Layers,
  Webhook,
  CircleSlash,
  Zap,
  Loader2,
  ArrowDown,
  ArrowUp,
  ExternalLink,
  MousePointerClick,
  Phone,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type {
  AccountMember,
  AutomationStepType,
  AutomationTriggerType,
  CustomField,
  KeywordMatchTriggerConfig,
  MessageTemplate,
  SwitchCase,
  SwitchOperator,
  Tag as TagRecord,
} from "@/types"
import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"

// ------------------------------------------------------------
// Types (builder-local — mirror the flattened rows we POST)
// ------------------------------------------------------------

export interface BuilderStep {
  /** Client id; the API assigns real UUIDs server-side. */
  cid: string
  step_type: AutomationStepType
  step_config: Record<string, unknown>
  branches?: Record<string, BuilderStep[]>
}

export interface BuilderInitial {
  id?: string
  name: string
  description: string
  trigger_type: AutomationTriggerType
  trigger_config: Record<string, unknown>
  is_active: boolean
  steps: BuilderStep[]
}

// ------------------------------------------------------------
// Step metadata — one source of truth for icon + label + border color
// ------------------------------------------------------------

interface StepMeta {
  label: string
  icon: typeof Zap
  /** Left-border accent color per spec. */
  border: string
}

const STEP_META: Record<AutomationStepType, StepMeta> = {
  send_message: { label: "Send Message", icon: MessageSquare, border: "border-l-primary" },
  send_template: { label: "Send Template", icon: FileText, border: "border-l-primary" },
  send_interactive: { label: "Message with Buttons", icon: MousePointerClick, border: "border-l-primary" },
  add_tag: { label: "Add Tag", icon: Tag, border: "border-l-primary" },
  remove_tag: { label: "Remove Tag", icon: TagIcon, border: "border-l-primary" },
  assign_conversation: { label: "Assign Conversation", icon: UserCheck, border: "border-l-primary" },
  update_contact_field: { label: "Update Contact Field", icon: PencilLine, border: "border-l-primary" },
  create_deal: { label: "Create Deal", icon: Briefcase, border: "border-l-primary" },
  wait: { label: "Wait", icon: Hourglass, border: "border-l-border" },
  condition: { label: "Condition (If/Else)", icon: GitBranch, border: "border-l-amber-500" },
  switch: { label: "Switch (Route by field)", icon: Layers, border: "border-l-violet-500" },
  send_webhook: { label: "Send Webhook", icon: Webhook, border: "border-l-primary" },
  close_conversation: { label: "Close Conversation", icon: CircleSlash, border: "border-l-primary" },
}

const ADDABLE_STEPS: AutomationStepType[] = [
  "send_message",
  "send_template",
  "send_interactive",
  "add_tag",
  "remove_tag",
  "assign_conversation",
  "update_contact_field",
  "create_deal",
  "wait",
  "condition",
  "switch",
  "send_webhook",
  "close_conversation",
]

const TRIGGER_OPTIONS: { value: AutomationTriggerType; label: string; hint: string }[] = [
  { value: "new_message_received", label: "New Message Received", hint: "Any incoming message" },
  {
    value: "first_inbound_message",
    label: "First Message from Contact",
    hint: "First time this contact ever messages you (works for manually-added contacts too)",
  },
  { value: "keyword_match", label: "Keyword Match", hint: "Message contains specific keyword(s)" },
  { value: "new_contact_created", label: "New Contact Created", hint: "When a contact is auto-created from an incoming message" },
  { value: "conversation_assigned", label: "Conversation Assigned", hint: "When assigned to an agent" },
  { value: "tag_added", label: "Tag Added", hint: "When a tag is added to a contact" },
  { value: "time_based", label: "Time-Based", hint: "On a recurring schedule" },
]

function cid(): string {
  return (
    "c_" +
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36))
  )
}

function blankConfig(type: AutomationStepType): Record<string, unknown> {
  switch (type) {
    case "send_message":
      return { text: "" }
    case "send_template":
      return { template_name: "", language: "en_US" }
    case "send_interactive":
      return { text: "", buttons: [{ title: "" }] }
    case "add_tag":
    case "remove_tag":
      return { tag_id: "" }
    case "assign_conversation":
      return { mode: "round_robin" }
    case "update_contact_field":
      return { field: "name", value: "" }
    case "create_deal":
      return { pipeline_id: "", stage_id: "", title: "", value: 0 }
    case "wait":
      return { amount: 1, unit: "hours" }
    case "condition":
      return { subject: "tag_presence", operand: "", value: "" }
    case "switch": {
      const id = `case_${Date.now()}`
      return { cases: [{ id, field_key: "name", operator: "equals", value: "" }] }
    }
    case "send_webhook":
      return { url: "", headers: {}, body_template: "" }
    case "close_conversation":
      return {}
    default:
      return {}
  }
}

// ------------------------------------------------------------
// Account resources (tags, members, approved templates)
//
// Loaded once at the builder root and shared via context so the
// tag / agent / template pickers below can offer existing resources
// by name instead of asking the user to paste raw UUIDs. Every picker
// falls back to a raw input when its list is empty (fresh account or
// an older deployment), so an automation is always authorable.
// ------------------------------------------------------------

interface AutomationResources {
  tags: TagRecord[]
  members: AccountMember[]
  templates: MessageTemplate[]
  customFields: CustomField[]
}

const ResourcesContext = createContext<AutomationResources>({
  tags: [],
  members: [],
  templates: [],
  customFields: [],
})

function useResources(): AutomationResources {
  return useContext(ResourcesContext)
}

function ResourcesProvider({ children }: { children: ReactNode }) {
  const [tags, setTags] = useState<TagRecord[]>([])
  const [members, setMembers] = useState<AccountMember[]>([])
  const [templates, setTemplates] = useState<MessageTemplate[]>([])
  const [customFields, setCustomFields] = useState<CustomField[]>([])

  useEffect(() => {
    let cancelled = false
    const supabase = createClient()

    // Tags, templates and custom fields come straight from the DB — RLS
    // scopes them to the caller's account. Only APPROVED templates can
    // actually be sent (anything else 400s at send time), matching the
    // broadcast picker.
    void (async () => {
      const [tagsRes, templatesRes, customFieldsRes] = await Promise.all([
        supabase.from("tags").select("*").order("name"),
        supabase
          .from("message_templates")
          .select("*")
          .eq("status", "APPROVED")
          .order("name"),
        supabase.from("custom_fields").select("*").order("field_name"),
      ])
      if (cancelled) return
      setTags((tagsRes.data as TagRecord[] | null) ?? [])
      setTemplates((templatesRes.data as MessageTemplate[] | null) ?? [])
      setCustomFields((customFieldsRes.data as CustomField[] | null) ?? [])
    })()

    // Members go through the API so we inherit its email-visibility
    // rules (agents/viewers don't see emails). Unreachable on older
    // deployments → pickers fall back to a raw agent-id input.
    void (async () => {
      try {
        const res = await fetch("/api/account/members", { cache: "no-store" })
        if (!res.ok) return
        const json = (await res.json()) as { members?: AccountMember[] }
        if (!cancelled) setMembers(json.members ?? [])
      } catch {
        // Members endpoint absent — caller falls back to raw input.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <ResourcesContext.Provider value={{ tags, members, templates, customFields }}>
      {children}
    </ResourcesContext.Provider>
  )
}

const SELECT_CLASS =
  "w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"

/** Tag dropdown by name + color, storing the tag's id. Falls back to a
 *  raw id input when no tags exist yet. */
function TagSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const { tags } = useResources()
  if (tags.length === 0) {
    return (
      <Input
        placeholder="Tag id"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-muted text-foreground"
      />
    )
  }
  const selected = tags.find((t) => t.id === value)
  return (
    <div className="flex items-center gap-2">
      <span
        className="h-3 w-3 shrink-0 rounded-full border border-border"
        style={{ backgroundColor: selected?.color ?? "transparent" }}
        aria-hidden
      />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={SELECT_CLASS}
      >
        <option value="">Select a tag…</option>
        {tags.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
        {/* Preserve a saved tag that's since been deleted so editing an
            existing automation doesn't silently drop it. */}
        {value && !selected && (
          <option value={value}>{value} (unknown tag)</option>
        )}
      </select>
    </div>
  )
}

/** Contact-field dropdown for "Update Contact Field": built-in columns plus
 *  any account custom fields (stored as `custom:<id>`). A saved custom field
 *  that's since been deleted is preserved as a labelled option so editing an
 *  existing automation doesn't silently drop it. */
function ContactFieldSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const { customFields } = useResources()
  const customValue = value.startsWith("custom:") ? value : ""
  const knownCustom =
    customValue && customFields.some((f) => `custom:${f.id}` === customValue)
  return (
    <select
      value={value || "name"}
      onChange={(e) => onChange(e.target.value)}
      className={SELECT_CLASS}
    >
      <option value="name">Name</option>
      <option value="email">Email</option>
      <option value="company">Company</option>
      {customFields.length > 0 && (
        <optgroup label="Custom fields">
          {customFields.map((f) => (
            <option key={f.id} value={`custom:${f.id}`}>
              {f.field_name}
            </option>
          ))}
        </optgroup>
      )}
      {customValue && !knownCustom && (
        <option value={customValue}>{customValue} (unknown field)</option>
      )}
    </select>
  )
}

/** Agent dropdown by name, storing the member's user_id. Falls back to
 *  a raw id input when the member list is unavailable. */
function AgentSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const { members } = useResources()
  if (members.length === 0) {
    return (
      <Input
        placeholder="Agent id"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-muted text-foreground"
      />
    )
  }
  const selected = members.find((m) => m.user_id === value)
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={SELECT_CLASS}
    >
      <option value="">Select an agent…</option>
      {members.map((m) => (
        <option key={m.user_id} value={m.user_id}>
          {m.full_name || m.email || m.user_id}
        </option>
      ))}
      {value && !selected && (
        <option value={value}>{value} (unknown agent)</option>
      )}
    </select>
  )
}

/** Template dropdown showing approved templates by name + language.
 *  When a template is selected, shows body preview, variable inputs,
 *  and a button list so the author can confirm which buttons will be sent. */
function SendTemplateFields({
  templateName,
  language,
  variables,
  onChange,
}: {
  templateName: string
  language: string
  variables?: Record<string, string>
  onChange: (patch: {
    template_name: string
    language: string
    variables?: Record<string, string>
  }) => void
}) {
  const { templates } = useResources()

  // Encode name + language in the option value so two templates that
  // share a name across languages stay distinct.
  const toValue = (name: string, lang: string) => `${name}::${lang}`
  const current = templateName ? toValue(templateName, language) : ""

  const selected = templates.find(
    (t) => toValue(t.name, t.language ?? "en_US") === current,
  )

  // Extract all {{N}} or {{name}} placeholders from the body in order.
  const bodyPlaceholders: string[] = selected?.body_text
    ? [...new Set(selected.body_text.match(/\{\{[\w]+\}\}/g) ?? [])]
    : []

  function updateVar(key: string, val: string) {
    onChange({
      template_name: templateName,
      language,
      variables: { ...(variables ?? {}), [key]: val },
    })
  }

  if (templates.length === 0) {
    return (
      <>
        <FieldBlock label="Template name">
          <Input
            value={templateName}
            onChange={(e) =>
              onChange({ template_name: e.target.value, language, variables })
            }
            className="bg-muted text-foreground"
          />
        </FieldBlock>
        <FieldBlock label="Language">
          <Input
            value={language}
            onChange={(e) =>
              onChange({ template_name: templateName, language: e.target.value, variables })
            }
            className="bg-muted text-foreground"
          />
        </FieldBlock>
      </>
    )
  }

  const hasMatch = templates.some(
    (t) => toValue(t.name, t.language ?? "en_US") === current,
  )

  return (
    <>
      <FieldBlock label="Template">
        <select
          value={current}
          onChange={(e) => {
            const [name, lang] = e.target.value.split("::")
            onChange({ template_name: name ?? "", language: lang ?? "", variables: {} })
          }}
          className={SELECT_CLASS}
        >
          <option value="">Select a template…</option>
          {templates.map((t) => {
            const lang = t.language ?? "en_US"
            const btns = t.buttons ?? []
            const hasCta = btns.some((b) => b.type === "URL" || b.type === "PHONE_NUMBER")
            return (
              <option key={t.id} value={toValue(t.name, lang)}>
                {t.name} ({lang}){hasCta ? " 🔗" : ""}
              </option>
            )
          })}
          {current && !hasMatch && (
            <option value={current}>
              {templateName} ({language || "unknown"}) — not in approved list
            </option>
          )}
        </select>
      </FieldBlock>

      {selected && (
        <>
          {/* Body preview */}
          <FieldBlock label="Preview">
            <div className="rounded-md bg-[#0e1a12] p-2.5">
              <p className="whitespace-pre-wrap text-xs text-primary/90 leading-relaxed">
                {selected.body_text}
              </p>
              {selected.footer_text && (
                <p className="mt-1 text-[10px] text-muted-foreground">{selected.footer_text}</p>
              )}
            </div>
          </FieldBlock>

          {/* Variable inputs */}
          {bodyPlaceholders.length > 0 && (
            <FieldBlock label="Variáveis">
              <div className="space-y-2">
                {bodyPlaceholders.map((placeholder) => {
                  const key = placeholder.replace(/^\{\{|\}\}$/g, "")
                  return (
                    <div key={key}>
                      <label className="mb-0.5 block text-[10px] text-muted-foreground font-mono">
                        {placeholder}
                      </label>
                      <Input
                        value={variables?.[key] ?? ""}
                        onChange={(e) => updateVar(key, e.target.value)}
                        placeholder={`Valor fixo ou {{ contact.name }}, {{ contact.phone }}…`}
                        className="bg-muted text-foreground text-xs h-7"
                      />
                    </div>
                  )
                })}
                <p className="text-[10px] text-muted-foreground">
                  Use <code className="text-primary">{"{{ contact.name }}"}</code>,{" "}
                  <code className="text-primary">{"{{ contact.phone }}"}</code>,{" "}
                  <code className="text-primary">{"{{ contact.email }}"}</code> para dados do contato.
                </p>
              </div>
            </FieldBlock>
          )}

          {/* Buttons preview */}
          {(selected.buttons ?? []).length > 0 && (
            <FieldBlock label="Botões incluídos">
              <div className="space-y-1">
                {(selected.buttons ?? []).map((btn, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 rounded-md border border-border bg-muted px-2.5 py-1.5 text-xs"
                  >
                    {btn.type === "URL" ? (
                      <ExternalLink className="h-3 w-3 shrink-0 text-blue-400" />
                    ) : btn.type === "PHONE_NUMBER" ? (
                      <Phone className="h-3 w-3 shrink-0 text-green-400" />
                    ) : (
                      <MousePointerClick className="h-3 w-3 shrink-0 text-primary" />
                    )}
                    <span className="text-foreground font-medium">{btn.text}</span>
                    {btn.type === "URL" && (
                      <span className="ml-auto text-[10px] text-muted-foreground truncate max-w-[120px]">
                        {btn.url}
                      </span>
                    )}
                    {btn.type === "PHONE_NUMBER" && (
                      <span className="ml-auto text-[10px] text-muted-foreground">
                        {btn.phone_number}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </FieldBlock>
          )}
        </>
      )}
    </>
  )
}

/** Message with quick-reply buttons (interactive message).
 *  Works within the 24-hour conversation window — no template approval needed.
 *  Buttons are tappable labels; when tapped the recipient's button text is sent
 *  back as a message and can trigger keyword-match automations. */
function SendInteractiveFields({
  text,
  header,
  footer,
  buttons,
  onChange,
}: {
  text: string
  header: string
  footer: string
  buttons: { title: string; id?: string; url?: string }[]
  onChange: (patch: Record<string, unknown>) => void
}) {
  const MAX_BUTTONS = 3
  const hasUrlButton = buttons.some((b) => b.url)

  function updateButton(index: number, patch: Partial<{ title: string; url: string | undefined }>) {
    const next = buttons.map((b, i) => (i === index ? { ...b, ...patch } : b))
    onChange({ text, header, footer, buttons: next })
  }

  function addButton() {
    if (buttons.length >= MAX_BUTTONS) return
    onChange({ text, header, footer, buttons: [...buttons, { title: "" }] })
  }

  function removeButton(index: number) {
    onChange({ text, header, footer, buttons: buttons.filter((_, i) => i !== index) })
  }

  return (
    <>
      <FieldBlock label="Message text">
        <Textarea
          value={text}
          onChange={(e) => onChange({ text: e.target.value, header, footer, buttons })}
          placeholder={"Olá! Como posso ajudar?\n\nUse {{ contact.name }} para personalizar."}
          className="min-h-24 bg-muted text-foreground"
        />
      </FieldBlock>

      <FieldBlock label="Header (optional)">
        <Input
          value={header}
          onChange={(e) => onChange({ text, header: e.target.value, footer, buttons })}
          placeholder="Título curto (máx. 60 caracteres)"
          maxLength={60}
          className="bg-muted text-foreground"
        />
      </FieldBlock>

      <FieldBlock label="Footer (optional)">
        <Input
          value={footer}
          onChange={(e) => onChange({ text, header, footer: e.target.value, buttons })}
          placeholder="Nota de rodapé (máx. 60 caracteres)"
          maxLength={60}
          className="bg-muted text-foreground"
        />
      </FieldBlock>

      <FieldBlock label={`Buttons (${buttons.length}/${MAX_BUTTONS})`}>
        <div className="space-y-3">
          {buttons.map((btn, i) => (
            <div key={i} className="space-y-1">
              <div className="flex items-center gap-1.5">
                <Input
                  value={btn.title}
                  onChange={(e) => updateButton(i, { title: e.target.value })}
                  placeholder="Texto do botão (máx. 20 chars)"
                  maxLength={20}
                  className="bg-muted text-foreground text-sm"
                />
                {buttons.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeButton(i)}
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {/* URL field: enabled only for the button that already has a URL,
                  or for any button when no other button has a URL yet. */}
              <div className="flex items-center gap-1.5">
                <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                <Input
                  value={btn.url ?? ""}
                  onChange={(e) => updateButton(i, { url: e.target.value || undefined })}
                  placeholder="URL do botão (opcional, ex: https://…)"
                  className="bg-muted text-foreground text-xs h-7"
                  disabled={hasUrlButton && !btn.url}
                />
              </div>
            </div>
          ))}
          {buttons.length < MAX_BUTTONS && !hasUrlButton && (
            <button
              type="button"
              onClick={addButton}
              className="flex items-center gap-1 text-xs text-primary hover:text-primary/80"
            >
              <Plus className="h-3 w-3" />
              Add button
            </button>
          )}
        </div>
        {hasUrlButton ? (
          <p className="mt-1.5 text-[10px] text-muted-foreground">
            Botão com URL abre o link no navegador do contato. Apenas um botão com URL por mensagem.
          </p>
        ) : (
          <p className="mt-1.5 text-[10px] text-muted-foreground">
            Botões sem URL enviam o texto de volta como mensagem e podem acionar automações de <strong>Keyword Match</strong>.
          </p>
        )}
      </FieldBlock>
    </>
  )
}

// ------------------------------------------------------------
// Main builder component
// ------------------------------------------------------------

export function AutomationBuilder({ initial }: { initial: BuilderInitial }) {
  const router = useRouter()
  const isEditing = !!initial.id
  const [state, setState] = useState<BuilderInitial>(initial)
  const [saving, setSaving] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  function patchTop<K extends keyof BuilderInitial>(key: K, value: BuilderInitial[K]) {
    setState((s) => ({ ...s, [key]: value }))
  }

  // --- Step tree mutations (immutable) ---

  function updateStep(path: StepPath, updater: (s: BuilderStep) => BuilderStep) {
    setState((s) => ({ ...s, steps: mapAtPath(s.steps, path, updater) }))
  }

  function addStepAt(parent: ParentScope, index: number, type: AutomationStepType) {
    let initialBranches: Record<string, BuilderStep[]> | undefined
    if (type === "condition") {
      initialBranches = { yes: [], no: [] }
    } else if (type === "switch") {
      const cfg = blankConfig(type) as { cases: Array<{ id: string }> }
      const firstCaseId = cfg.cases[0]?.id ?? `case_${Date.now()}`
      initialBranches = { [firstCaseId]: [], default: [] }
    }
    const node: BuilderStep = {
      cid: cid(),
      step_type: type,
      step_config: blankConfig(type),
      branches: initialBranches,
    }
    setState((s) => ({ ...s, steps: insertAt(s.steps, parent, index, node) }))
    setExpandedId(node.cid)
  }

  function deleteStepAt(path: StepPath) {
    setState((s) => ({ ...s, steps: removeAt(s.steps, path) }))
  }

  function moveStepAt(path: StepPath, direction: -1 | 1) {
    setState((s) => ({ ...s, steps: moveAt(s.steps, path, direction) }))
  }

  async function save() {
    setSaving(true)
    try {
      const payload = {
        name: state.name || "Untitled automation",
        description: state.description || null,
        trigger_type: state.trigger_type,
        trigger_config: state.trigger_config,
        is_active: state.is_active,
        steps: toApiSteps(state.steps),
      }

      const res = isEditing
        ? await fetch(`/api/automations/${initial.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch(`/api/automations`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          })

      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        // If the server blocked activation with validation issues,
        // surface the first concrete problem so the user can fix it
        // without opening DevTools for the full array.
        const firstIssue: { path?: string; message?: string } | undefined =
          body?.issues?.[0]
        if (firstIssue?.message) {
          toast.error(firstIssue.message, {
            description: firstIssue.path ? `at ${firstIssue.path}` : undefined,
          })
        } else {
          toast.error(body?.error ?? "Save failed")
        }
        return
      }
      toast.success(isEditing ? "Automation saved" : "Automation created")
      if (!isEditing && body?.automation?.id) {
        router.replace(`/automations/${body.automation.id}/edit`)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-background">
      {/* Top bar. At sub-sm widths the "Active" label is hidden and the
          switch moves to the right of the save button, so the name input
          gets maximum width. */}
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-border bg-card/80 px-3 py-3 sm:gap-3 sm:px-4">
        <button
          type="button"
          onClick={() => router.push("/automations")}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Back to automations"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <input
          value={state.name}
          onChange={(e) => patchTop("name", e.target.value)}
          placeholder="Untitled automation"
          className="min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 text-sm font-semibold text-foreground placeholder:text-muted-foreground focus:bg-muted focus:outline-none sm:text-base"
        />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="hidden sm:inline">Active</span>
          <Switch
            checked={state.is_active}
            onCheckedChange={(v) => patchTop("is_active", !!v)}
            aria-label="Active"
          />
        </div>
        <Button
          onClick={save}
          disabled={saving}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {isEditing ? "Save" : "Save Draft"}
        </Button>
      </header>

      {/* Canvas */}
      <div className="relative flex-1 overflow-y-auto">
        <div className="absolute inset-0 bg-[radial-gradient(circle,var(--border)_1px,transparent_1px)] [background-size:20px_20px] pointer-events-none" />
        <div className="relative mx-auto flex max-w-2xl flex-col items-center gap-0 px-4 py-10">
          <ResourcesProvider>
            <TriggerCard
              type={state.trigger_type}
              config={state.trigger_config}
              onTypeChange={(t) => patchTop("trigger_type", t)}
              onConfigChange={(c) => patchTop("trigger_config", c)}
            />
            <StepList
              steps={state.steps}
              parentPath={[]}
              expandedId={expandedId}
              setExpandedId={setExpandedId}
              updateStep={updateStep}
              addStepAt={addStepAt}
              deleteStepAt={deleteStepAt}
              moveStepAt={moveStepAt}
            />
          </ResourcesProvider>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------
// Trigger card
// ------------------------------------------------------------

function TriggerCard({
  type,
  config,
  onTypeChange,
  onConfigChange,
}: {
  type: AutomationTriggerType
  config: Record<string, unknown>
  onTypeChange: (t: AutomationTriggerType) => void
  onConfigChange: (c: Record<string, unknown>) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    // Card width: full on mobile, fixed 320px on sm+. The canvas wrapper
    // (max-w-2xl + px-4) keeps this tidy on tablet/desktop.
    <div className="z-10 w-full max-w-[320px] sm:w-80">
      <div className="rounded-lg border border-border border-l-4 border-l-blue-500 bg-card shadow-lg">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-3 px-4 py-3 text-left"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-blue-500/10 text-blue-400">
            <Zap className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-wide text-blue-300">Trigger</div>
            <div className="truncate text-sm font-medium text-foreground">
              {TRIGGER_OPTIONS.find((o) => o.value === type)?.label ?? type}
            </div>
          </div>
          <ChevronDown
            className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")}
          />
        </button>
        {open && (
          <div className="space-y-3 border-t border-border px-4 py-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Trigger type
              </label>
              <select
                value={type}
                onChange={(e) => onTypeChange(e.target.value as AutomationTriggerType)}
                className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
              >
                {TRIGGER_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {TRIGGER_OPTIONS.find((o) => o.value === type)?.hint}
              </p>
            </div>
            {type === "keyword_match" && (
              <KeywordMatchConfig
                config={config as unknown as KeywordMatchTriggerConfig}
                onChange={onConfigChange}
              />
            )}
            {type === "tag_added" && (
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Tag
                </label>
                <TagSelect
                  value={(config.tag_id as string) ?? ""}
                  onChange={(v) => onConfigChange({ ...config, tag_id: v })}
                />
              </div>
            )}
            {type === "time_based" && (
              <Input
                placeholder="Cron expression or HH:mm"
                value={(config.schedule as string) ?? ""}
                onChange={(e) =>
                  onConfigChange({ ...config, schedule: e.target.value })
                }
                className="bg-muted text-foreground"
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function KeywordMatchConfig({
  config,
  onChange,
}: {
  config: KeywordMatchTriggerConfig
  onChange: (c: Record<string, unknown>) => void
}) {
  const keywords = config?.keywords ?? []
  // Keep a local draft string so the comma and trailing space aren't
  // stripped on every keystroke (which made multi-word, comma-separated
  // entry like "SEO, search engine optimization" impossible to type).
  // We only parse into the keywords array on blur, then re-display the
  // cleaned, rejoined form. Seeded once on mount; this component remounts
  // when the trigger type changes, so the seed stays in sync.
  const [draft, setDraft] = useState(keywords.join(", "))

  // Persist the default the <select> displays. The dropdown falls back to
  // "contains" for display, but leaving it untouched would otherwise omit
  // match_type from the saved config — and activation validation then
  // rejected it (trigger.match_type). Seed once on mount; the component
  // remounts when the trigger type changes, matching the keywords draft.
  useEffect(() => {
    if (config?.match_type == null) {
      onChange({ ...config, match_type: "contains" })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function commit() {
    const parsed = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    setDraft(parsed.join(", "))
    onChange({ ...config, keywords: parsed })
  }

  return (
    <div className="space-y-2">
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">
          Keywords (comma-separated)
        </label>
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              commit()
            }
          }}
          placeholder="e.g. pricing, demo request, talk to sales"
          className="bg-muted text-foreground"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">
          Match type
        </label>
        <select
          value={config?.match_type ?? "contains"}
          onChange={(e) => onChange({ ...config, match_type: e.target.value as "exact" | "contains" })}
          className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:outline-none"
        >
          <option value="contains">Contains</option>
          <option value="exact">Exact</option>
        </select>
      </div>
    </div>
  )
}

// ------------------------------------------------------------
// Step list + card + connectors
// ------------------------------------------------------------

type ParentScope =
  | { kind: "root" }
  | { kind: "branch"; parentCid: string; branch: string }

type StepPath = (
  | { kind: "root"; index: number }
  | { kind: "branch"; parentCid: string; branch: string; index: number }
)[]

interface StepListProps {
  steps: BuilderStep[]
  parentPath: StepPath
  expandedId: string | null
  setExpandedId: (id: string | null) => void
  updateStep: (path: StepPath, updater: (s: BuilderStep) => BuilderStep) => void
  addStepAt: (parent: ParentScope, index: number, type: AutomationStepType) => void
  deleteStepAt: (path: StepPath) => void
  moveStepAt: (path: StepPath, direction: -1 | 1) => void
}

function StepList(props: StepListProps) {
  const { steps, parentPath, ...rest } = props
  const parentScope: ParentScope =
    parentPath.length === 0
      ? { kind: "root" }
      : (() => {
          const last = parentPath[parentPath.length - 1]
          if (last.kind !== "branch") return { kind: "root" } as const
          return { kind: "branch", parentCid: last.parentCid, branch: last.branch } as const
        })()

  return (
    <div className="flex flex-col items-center">
      <AddButton onPick={(t) => props.addStepAt(parentScope, 0, t)} />
      {steps.map((step, idx) => (
        <StepRenderer
          key={step.cid}
          step={step}
          index={idx}
          total={steps.length}
          parentScope={parentScope}
          parentPath={parentPath}
          {...rest}
        />
      ))}
    </div>
  )
}

function StepRenderer({
  step,
  index,
  total,
  parentScope,
  parentPath,
  ...props
}: {
  step: BuilderStep
  index: number
  total: number
  parentScope: ParentScope
  parentPath: StepPath
} & Omit<StepListProps, "steps" | "parentPath">) {
  // When inside a branch, parentPath ends with a scope-marker element whose
  // index is a placeholder. Replace it with the actual child index instead
  // of appending a third element (which would make mapAtPath unable to find
  // the step because walkBranches would recurse one level too deep).
  const path: StepPath =
    parentScope.kind === "root"
      ? [...parentPath, { kind: "root" as const, index }]
      : [
          ...parentPath.slice(0, -1),
          { kind: "branch" as const, parentCid: parentScope.parentCid, branch: parentScope.branch, index },
        ]
  const meta = STEP_META[step.step_type]
  const Icon = meta.icon
  const expanded = props.expandedId === step.cid
  const isCondition = step.step_type === "condition"
  const isSwitch = step.step_type === "switch"
  // Card widths on mobile fill the full canvas column (max-w-2xl px-4
  // still keeps them reasonable). On sm+ the original fixed widths
  // come back so the flow visual stays recognisable.
  const width = (isCondition || isSwitch)
    ? "w-full max-w-[400px] sm:w-[400px]"
    : "w-full max-w-[320px] sm:w-80"

  return (
    <>
      <div className={cn("z-10 flex flex-col", width)}>
        <div
          className={cn(
            "rounded-lg border border-border border-l-4 bg-card shadow-lg",
            meta.border,
          )}
        >
          <button
            type="button"
            onClick={() => props.setExpandedId(expanded ? null : step.cid)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left"
          >
            <GripVertical className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden />
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Icon className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {isCondition ? "Condition" : isSwitch ? "Switch" : step.step_type === "wait" ? "Wait" : "Action"}
              </div>
              <div className="truncate text-sm font-medium text-foreground">{meta.label}</div>
              <div className="truncate text-[11px] text-muted-foreground">{previewFor(step)}</div>
            </div>
            <ChevronDown
              className={cn("h-4 w-4 text-muted-foreground transition-transform", expanded && "rotate-180")}
            />
          </button>
          {expanded && (
            <div className="border-t border-border px-4 py-3">
              <StepEditor
                step={step}
                onChange={(next) => props.updateStep(path, () => next)}
              />
              <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={index === 0}
                    aria-label="Move up"
                    onClick={() => props.moveStepAt(path, -1)}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={index === total - 1}
                    aria-label="Move down"
                    onClick={() => props.moveStepAt(path, 1)}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => props.deleteStepAt(path)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </Button>
              </div>
            </div>
          )}
        </div>

        {isCondition && (
          <ConditionBranches step={step} parentPath={path} {...props} />
        )}
        {isSwitch && (
          <SwitchBranches step={step} parentPath={path} {...props} />
        )}
      </div>

      {/* Branching steps (condition/switch) have no linear "continue" path —
          adding the trailing connector here would produce a spurious output. */}
      {!isCondition && !isSwitch && (
        <AddButton
          onPick={(t) => props.addStepAt(parentScope, index + 1, t)}
        />
      )}
    </>
  )
}

function ConditionBranches({
  step,
  parentPath,
  ...props
}: {
  step: BuilderStep
  parentPath: StepPath
} & Omit<StepListProps, "steps" | "parentPath">) {
  const yes = step.branches?.["yes"] ?? []
  const no = step.branches?.["no"] ?? []
  // Build the child scope by appending a branch marker. The scope the
  // StepList uses is driven by the LAST element of parentPath, so the
  // tail's `index` doesn't matter — it's replaced per child during walks.
  const yesPath: StepPath = [
    ...parentPath,
    { kind: "branch", parentCid: step.cid, branch: "yes", index: 0 },
  ]
  const noPath: StepPath = [
    ...parentPath,
    { kind: "branch", parentCid: step.cid, branch: "no", index: 0 },
  ]
  return (
    // Stack Yes/No vertically on mobile — two columns at 375px would
    // cram each branch to ~170px which is too narrow for the nested
    // cards. Two-column grid returns on sm+.
    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
      <BranchColumn label="Yes" color="text-primary">
        <StepList {...props} steps={yes} parentPath={yesPath} />
      </BranchColumn>
      <BranchColumn label="No" color="text-rose-400">
        <StepList {...props} steps={no} parentPath={noPath} />
      </BranchColumn>
    </div>
  )
}

function SwitchBranches({
  step,
  parentPath,
  ...props
}: {
  step: BuilderStep
  parentPath: StepPath
} & Omit<StepListProps, "steps" | "parentPath">) {
  const { customFields } = useResources()
  const cases = (step.step_config.cases ?? []) as SwitchCase[]

  function fieldLabel(fieldKey: string): string {
    if (fieldKey.startsWith("custom:")) {
      const id = fieldKey.slice("custom:".length)
      return customFields.find((f) => f.id === id)?.field_name ?? fieldKey
    }
    return fieldKey
  }

  const allBranches = [
    ...cases.map((c) => ({
      id: c.id,
      label: `${fieldLabel(c.field_key)} ${c.operator} "${c.value}"`,
      color: "text-violet-400",
    })),
    { id: "default", label: "Default", color: "text-muted-foreground" },
  ]

  return (
    // Full-bleed: center the branch columns using the full viewport width so
    // they are not constrained by the 400 px card container.
    <div
      className="mt-3 flex flex-wrap justify-center gap-4"
      style={{ width: "100vw", marginLeft: "calc(-50vw + 50%)" }}
    >
      {allBranches.map(({ id, label, color }) => {
        const branchSteps = step.branches?.[id] ?? []
        const branchPath: StepPath = [
          ...parentPath,
          { kind: "branch", parentCid: step.cid, branch: id, index: 0 },
        ]
        return (
          <div key={id} className="flex flex-col items-center w-[300px]">
            <BranchColumn label={label} color={color}>
              <StepList {...props} steps={branchSteps} parentPath={branchPath} />
            </BranchColumn>
          </div>
        )
      })}
    </div>
  )
}

function BranchColumn({
  label,
  color,
  children,
}: {
  label: string
  color: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center">
      <div className={cn("mb-2 text-[11px] font-semibold uppercase", color)}>{label}</div>
      {children}
    </div>
  )
}

function AddButton({ onPick }: { onPick: (t: AutomationStepType) => void }) {
  return (
    <div className="relative flex flex-col items-center">
      <div className="h-4 w-[2px] bg-border" aria-hidden />
      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-dashed border-border bg-background text-muted-foreground transition-colors hover:border-primary hover:bg-primary/10 hover:text-primary data-[popup-open]:border-primary data-[popup-open]:bg-primary/20 data-[popup-open]:text-primary"
          aria-label="Add step"
        >
          <Plus className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-80 min-w-56 overflow-y-auto border-border bg-popover"
        >
          {ADDABLE_STEPS.map((t) => {
            const Icon = STEP_META[t].icon
            return (
              <DropdownMenuItem key={t} onClick={() => onPick(t)}>
                <Icon className="h-4 w-4" />
                {STEP_META[t].label}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="h-4 w-[2px] bg-border" aria-hidden />
    </div>
  )
}

// ------------------------------------------------------------
// Switch case editor
// ------------------------------------------------------------

function SwitchCaseEditor({
  step,
  onChange,
}: {
  step: BuilderStep
  onChange: (s: BuilderStep) => void
}) {
  const { customFields } = useResources()
  const cases = ((step.step_config.cases ?? []) as SwitchCase[])

  function addCase() {
    const id = `case_${Date.now()}`
    const newCase: SwitchCase = { id, field_key: "name", operator: "equals", value: "" }
    onChange({
      ...step,
      step_config: { ...step.step_config, cases: [...cases, newCase] },
      branches: { ...(step.branches ?? {}), [id]: [] },
    })
  }

  function removeCase(id: string) {
    const { [id]: _removed, ...rest } = step.branches ?? {}
    onChange({
      ...step,
      step_config: { ...step.step_config, cases: cases.filter((c) => c.id !== id) },
      branches: rest,
    })
  }

  function updateCase(id: string, patch: Partial<SwitchCase>) {
    onChange({
      ...step,
      step_config: {
        ...step.step_config,
        cases: cases.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      },
    })
  }

  return (
    <div className="space-y-3">
      {cases.map((c, i) => (
        <div key={c.id} className="rounded-md border border-border bg-muted/50 p-2 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase text-muted-foreground">
              Case {i + 1}
            </span>
            {cases.length > 1 && (
              <button
                type="button"
                onClick={() => removeCase(c.id)}
                className="text-muted-foreground hover:text-destructive"
                aria-label="Remove case"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="grid grid-cols-[1fr_auto_1fr] gap-1.5 items-center">
            <select
              value={c.field_key}
              onChange={(e) => updateCase(c.id, { field_key: e.target.value })}
              className={SELECT_CLASS}
            >
              <option value="name">Name</option>
              <option value="email">Email</option>
              <option value="company">Company</option>
              <option value="phone">Phone</option>
              {customFields.length > 0 && (
                <optgroup label="Custom fields">
                  {customFields.map((f) => (
                    <option key={f.id} value={`custom:${f.id}`}>
                      {f.field_name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <select
              value={c.operator}
              onChange={(e) => updateCase(c.id, { operator: e.target.value as SwitchOperator })}
              className={SELECT_CLASS}
            >
              <option value="equals">equals</option>
              <option value="contains">contains</option>
              <option value="not_equals">not equals</option>
            </select>
            <Input
              value={c.value}
              onChange={(e) => updateCase(c.id, { value: e.target.value })}
              placeholder="Value…"
              className="bg-muted text-foreground"
            />
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={addCase}
        className="flex items-center gap-1 text-xs text-primary hover:text-primary/80"
      >
        <Plus className="h-3 w-3" />
        Add case
      </button>
      <p className="text-[10px] text-muted-foreground">
        Cases are evaluated top-to-bottom. The first match wins. The <strong>Default</strong> branch runs when none match.
      </p>
    </div>
  )
}

// ------------------------------------------------------------
// Per-step config editor
// ------------------------------------------------------------

function StepEditor({
  step,
  onChange,
}: {
  step: BuilderStep
  onChange: (s: BuilderStep) => void
}) {
  const cfg = step.step_config
  const set = (patch: Record<string, unknown>) =>
    onChange({ ...step, step_config: { ...cfg, ...patch } })

  switch (step.step_type) {
    case "send_message":
      return (
        <FieldBlock label="Message text">
          <Textarea
            value={(cfg.text as string) ?? ""}
            onChange={(e) => set({ text: e.target.value })}
            placeholder="Hi! Thanks for reaching out…"
            className="min-h-24 bg-muted text-foreground"
          />
        </FieldBlock>
      )
    case "send_template":
      return (
        <SendTemplateFields
          templateName={(cfg.template_name as string) ?? ""}
          language={(cfg.language as string) ?? ""}
          variables={(cfg.variables as Record<string, string> | undefined) ?? {}}
          onChange={(patch) => set(patch)}
        />
      )
    case "send_interactive":
      return (
        <SendInteractiveFields
          text={(cfg.text as string) ?? ""}
          header={(cfg.header as string | undefined) ?? ""}
          footer={(cfg.footer as string | undefined) ?? ""}
          buttons={(cfg.buttons as { title: string; id?: string }[]) ?? [{ title: "" }]}
          onChange={(patch) => set(patch)}
        />
      )
    case "add_tag":
    case "remove_tag":
      return (
        <FieldBlock label="Tag">
          <TagSelect
            value={(cfg.tag_id as string) ?? ""}
            onChange={(v) => set({ tag_id: v })}
          />
        </FieldBlock>
      )
    case "assign_conversation":
      return (
        <>
          <FieldBlock label="Mode">
            <select
              value={(cfg.mode as string) ?? "round_robin"}
              onChange={(e) => set({ mode: e.target.value })}
              className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            >
              <option value="round_robin">Round-robin</option>
              <option value="specific">Specific agent</option>
            </select>
          </FieldBlock>
          {cfg.mode === "specific" && (
            <FieldBlock label="Agent">
              <AgentSelect
                value={(cfg.agent_id as string) ?? ""}
                onChange={(v) => set({ agent_id: v })}
              />
            </FieldBlock>
          )}
        </>
      )
    case "update_contact_field":
      return (
        <>
          <FieldBlock label="Field">
            <ContactFieldSelect
              value={(cfg.field as string) ?? "name"}
              onChange={(v) => set({ field: v })}
            />
          </FieldBlock>
          <FieldBlock label="Value">
            <Input
              value={(cfg.value as string) ?? ""}
              onChange={(e) => set({ value: e.target.value })}
              placeholder="Text or {{ vars.x }} / {{ message.text }}"
              className="bg-muted text-foreground"
            />
          </FieldBlock>
        </>
      )
    case "create_deal":
      return (
        <>
          <FieldBlock label="Pipeline id">
            <Input
              value={(cfg.pipeline_id as string) ?? ""}
              onChange={(e) => set({ pipeline_id: e.target.value })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label="Stage id">
            <Input
              value={(cfg.stage_id as string) ?? ""}
              onChange={(e) => set({ stage_id: e.target.value })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label="Title">
            <Input
              value={(cfg.title as string) ?? ""}
              onChange={(e) => set({ title: e.target.value })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label="Value">
            <Input
              type="number"
              value={(cfg.value as number) ?? 0}
              onChange={(e) => set({ value: Number(e.target.value) })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
        </>
      )
    case "wait":
      return (
        <div className="grid grid-cols-2 gap-2">
          <FieldBlock label="Amount">
            <Input
              type="number"
              min={1}
              value={(cfg.amount as number) ?? 1}
              onChange={(e) => set({ amount: Math.max(1, Number(e.target.value)) })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label="Unit">
            <select
              value={(cfg.unit as string) ?? "hours"}
              onChange={(e) => set({ unit: e.target.value })}
              className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            >
              <option value="minutes">Minutes</option>
              <option value="hours">Hours</option>
              <option value="days">Days</option>
            </select>
          </FieldBlock>
        </div>
      )
    case "condition":
      return (
        <>
          <FieldBlock label="Subject">
            <select
              value={(cfg.subject as string) ?? "tag_presence"}
              onChange={(e) => set({ subject: e.target.value })}
              className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            >
              <option value="tag_presence">Tag presence</option>
              <option value="contact_field">Contact field</option>
              <option value="message_content">Message content</option>
              <option value="time_of_day">Time of day</option>
            </select>
          </FieldBlock>
          <FieldBlock label="Operand">
            <Input
              placeholder={
                cfg.subject === "time_of_day"
                  ? "HH:mm-HH:mm"
                  : cfg.subject === "contact_field"
                  ? "name / email / company"
                  : cfg.subject === "tag_presence"
                  ? "tag id"
                  : ""
              }
              value={(cfg.operand as string) ?? ""}
              onChange={(e) => set({ operand: e.target.value })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          {(cfg.subject === "contact_field" || cfg.subject === "message_content") && (
            <FieldBlock label="Value">
              <Input
                value={(cfg.value as string) ?? ""}
                onChange={(e) => set({ value: e.target.value })}
                className="bg-muted text-foreground"
              />
            </FieldBlock>
          )}
        </>
      )
    case "switch":
      return (
        <SwitchCaseEditor
          step={step}
          onChange={onChange}
        />
      )
    case "send_webhook":
      return (
        <>
          <FieldBlock label="URL">
            <Input
              value={(cfg.url as string) ?? ""}
              onChange={(e) => set({ url: e.target.value })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label="Body template (JSON)">
            <Textarea
              value={(cfg.body_template as string) ?? ""}
              onChange={(e) => set({ body_template: e.target.value })}
              className="min-h-20 bg-muted font-mono text-xs text-foreground"
            />
          </FieldBlock>
        </>
      )
    case "close_conversation":
      return (
        <p className="text-xs text-muted-foreground">
          Sets the conversation status to &quot;closed&quot;. No configuration needed.
        </p>
      )
    default:
      return null
  }
}

function FieldBlock({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="mb-2 last:mb-0">
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}

function previewFor(step: BuilderStep): string {
  switch (step.step_type) {
    case "send_message":
      return (step.step_config.text as string) || "no text yet"
    case "send_template":
      return (step.step_config.template_name as string) || "pick a template"
    case "send_interactive": {
      const btns = (step.step_config.buttons as { title: string }[] | undefined) ?? []
      const labels = btns.map((b) => b.title).filter(Boolean).join(" / ")
      return labels ? `[${labels}] ${(step.step_config.text as string) || ""}`.trim() : ((step.step_config.text as string) || "no text yet")
    }
    case "wait":
      return `${step.step_config.amount ?? "?"} ${step.step_config.unit ?? ""}`
    case "condition":
      return `when ${step.step_config.subject ?? "?"}`
    case "switch": {
      const cases = (step.step_config.cases as Array<{ field_key?: string; value?: string }> | undefined) ?? []
      return cases.length > 0
        ? `${cases.length} case${cases.length > 1 ? "s" : ""} + default`
        : "no cases yet"
    }
    case "send_webhook":
      return (step.step_config.url as string) || "no url"
    default:
      return ""
  }
}

// ------------------------------------------------------------
// Tree mutation helpers
// ------------------------------------------------------------

function insertAt(
  steps: BuilderStep[],
  parent: ParentScope,
  index: number,
  node: BuilderStep,
): BuilderStep[] {
  if (parent.kind === "root") {
    const copy = [...steps]
    copy.splice(index, 0, node)
    return copy
  }
  return steps.map((s) => {
    if (s.cid !== parent.parentCid || !s.branches) return s
    const list = [...(s.branches[parent.branch] ?? [])]
    list.splice(index, 0, node)
    return { ...s, branches: { ...s.branches, [parent.branch]: list } }
  })
}

function mapAtPath(
  steps: BuilderStep[],
  path: StepPath,
  updater: (s: BuilderStep) => BuilderStep,
): BuilderStep[] {
  if (path.length === 0) return steps
  const head = path[0]
  const rest = path.slice(1)

  if (head.kind === "root") {
    return steps.map((s, i) => {
      if (i !== head.index) return s
      return rest.length === 0
        ? updater(s)
        : { ...s, branches: walkBranches(s.branches, rest, updater) }
    })
  }
  return steps.map((s) => {
    if (s.cid !== head.parentCid || !s.branches) return s
    const bucket = s.branches[head.branch] ?? []
    const updated = bucket.map((child, i) => {
      if (i !== head.index) return child
      return rest.length === 0
        ? updater(child)
        : { ...child, branches: walkBranches(child.branches, rest, updater) }
    })
    return { ...s, branches: { ...s.branches, [head.branch]: updated } }
  })
}

function walkBranches(
  branches: BuilderStep["branches"],
  path: StepPath,
  updater: (s: BuilderStep) => BuilderStep,
): BuilderStep["branches"] {
  if (!branches) return branches
  const head = path[0]
  if (head.kind !== "branch") return branches
  const bucket = branches[head.branch] ?? []
  const rest = path.slice(1)
  const updated = bucket.map((child, i) => {
    if (i !== head.index) return child
    return rest.length === 0
      ? updater(child)
      : { ...child, branches: walkBranches(child.branches, rest, updater) }
  })
  return { ...branches, [head.branch]: updated }
}

function removeAt(steps: BuilderStep[], path: StepPath): BuilderStep[] {
  if (path.length === 0) return steps
  const head = path[0]
  const rest = path.slice(1)
  if (head.kind === "root") {
    if (rest.length === 0) return steps.filter((_, i) => i !== head.index)
    return steps.map((s, i) =>
      i !== head.index ? s : { ...s, branches: removeFromBranches(s.branches, rest) },
    )
  }
  return steps.map((s) => {
    if (s.cid !== head.parentCid || !s.branches) return s
    const bucket = s.branches[head.branch] ?? []
    const next =
      rest.length === 0
        ? bucket.filter((_, i) => i !== head.index)
        : bucket.map((child, i) =>
            i !== head.index
              ? child
              : { ...child, branches: removeFromBranches(child.branches, rest) },
          )
    return { ...s, branches: { ...s.branches, [head.branch]: next } }
  })
}

function removeFromBranches(
  branches: BuilderStep["branches"],
  path: StepPath,
): BuilderStep["branches"] {
  if (!branches) return branches
  const head = path[0]
  if (head.kind !== "branch") return branches
  const rest = path.slice(1)
  const bucket = branches[head.branch] ?? []
  const next =
    rest.length === 0
      ? bucket.filter((_, i) => i !== head.index)
      : bucket.map((child, i) =>
          i !== head.index
            ? child
            : { ...child, branches: removeFromBranches(child.branches, rest) },
        )
  return { ...branches, [head.branch]: next }
}

function moveAt(
  steps: BuilderStep[],
  path: StepPath,
  direction: -1 | 1,
): BuilderStep[] {
  if (path.length === 0) return steps
  const head = path[0]
  const rest = path.slice(1)
  const swap = <T,>(arr: T[], i: number) => {
    const j = i + direction
    if (j < 0 || j >= arr.length) return arr
    const copy = [...arr]
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
    return copy
  }
  if (head.kind === "root") {
    if (rest.length === 0) return swap(steps, head.index)
    return steps.map((s, i) =>
      i !== head.index ? s : { ...s, branches: moveInBranches(s.branches, rest, direction) },
    )
  }
  return steps.map((s) => {
    if (s.cid !== head.parentCid || !s.branches) return s
    const bucket = s.branches[head.branch] ?? []
    const next = rest.length === 0 ? swap(bucket, head.index) : bucket
    return { ...s, branches: { ...s.branches, [head.branch]: next } }
  })
}

function moveInBranches(
  branches: BuilderStep["branches"],
  path: StepPath,
  direction: -1 | 1,
): BuilderStep["branches"] {
  if (!branches) return branches
  const head = path[0]
  if (head.kind !== "branch") return branches
  const rest = path.slice(1)
  const bucket = branches[head.branch] ?? []
  const swap = <T,>(arr: T[], i: number) => {
    const j = i + direction
    if (j < 0 || j >= arr.length) return arr
    const copy = [...arr]
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
    return copy
  }
  const next = rest.length === 0 ? swap(bucket, head.index) : bucket
  return { ...branches, [head.branch]: next }
}

// ------------------------------------------------------------
// Serialize builder tree → API payload (flattened shape)
// ------------------------------------------------------------

interface ApiStep {
  step_type: string
  step_config: Record<string, unknown>
  branches?: Record<string, ApiStep[]>
}

export function toApiSteps(steps: BuilderStep[]): ApiStep[] {
  return steps.map((s) => ({
    step_type: s.step_type,
    step_config: s.step_config,
    branches: s.branches
      ? Object.fromEntries(
          Object.entries(s.branches).map(([k, v]) => [k, toApiSteps(v)])
        )
      : undefined,
  }))
}

/**
 * Convert server-returned step tree (from loadStepsTree) into the
 * builder-local shape with client ids.
 */
export interface ServerStepNode {
  id: string
  step_type: string
  step_config: Record<string, unknown>
  branches: Record<string, ServerStepNode[]>
}

export function fromServerSteps(nodes: ServerStepNode[]): BuilderStep[] {
  return nodes.map((n) => {
    let branches: BuilderStep["branches"]
    if (n.step_type === "condition" || n.step_type === "switch") {
      branches = n.branches
        ? Object.fromEntries(Object.entries(n.branches).map(([k, v]) => [k, fromServerSteps(v)]))
        : {}
      if (n.step_type === "switch") {
        const cases = (n.step_config?.cases as Array<{ id: string }> | undefined) ?? []
        for (const c of cases) {
          if (!branches[c.id]) branches[c.id] = []
        }
        if (!branches["default"]) branches["default"] = []
      }
    }
    return {
      cid: cid(),
      step_type: n.step_type as AutomationStepType,
      step_config: n.step_config ?? {},
      branches,
    }
  })
}
