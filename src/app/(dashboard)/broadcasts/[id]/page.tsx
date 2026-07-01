'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Broadcast, BroadcastRecipient, RecipientStatus, MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { useBroadcastSending, AudienceConfig, VariableMapping } from '@/hooks/use-broadcast-sending';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  ArrowLeft,
  Loader2,
  Users,
  Send,
  CheckCheck,
  Eye,
  AlertCircle,
  MessageCircle,
  Filter,
  Download,
  ChevronDown,
  Trash2,
  RotateCw,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  getBroadcastStatus,
  getRecipientStatus,
} from '@/lib/broadcast-status';

interface StatCardProps {
  label: string;
  value: number;
  total: number;
  icon: React.ReactNode;
  color: string;
}

function StatCard({ label, value, total, icon, color }: StatCardProps) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${color}`}>
          {icon}
        </div>
        <span className="text-xs text-muted-foreground">{pct}%</span>
      </div>
      <p className="mt-3 text-2xl font-bold text-foreground">{value.toLocaleString()}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

interface FunnelStep {
  label: string;
  value: number;
  color: string;
}

/**
 * Pure-CSS funnel chart: decreasing-width rounded bars.
 * Width is relative to the largest step (typically Sent) so we
 * always render a full bar at the top and proportional tails.
 */
function FunnelChart({ steps }: { steps: FunnelStep[] }) {
  const max = Math.max(...steps.map((s) => s.value), 1);
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-4 text-sm font-medium text-foreground">Funnel</h3>
      <div className="space-y-2">
        {steps.map((step) => {
          const pctOfMax = Math.max(5, Math.round((step.value / max) * 100));
          const pctOfSent =
            steps[0].value > 0
              ? Math.round((step.value / steps[0].value) * 100)
              : 0;
          return (
            <div key={step.label} className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-xs text-muted-foreground">
                {step.label}
              </span>
              <div className="relative h-7 flex-1 rounded-full bg-muted">
                <div
                  className={`h-7 rounded-full ${step.color} transition-[width] duration-500`}
                  style={{ width: `${pctOfMax}%` }}
                />
                <span className="absolute inset-0 flex items-center px-3 text-xs font-medium text-foreground">
                  {step.value.toLocaleString()}
                  <span className="ml-2 text-muted-foreground/80">
                    ({pctOfSent}%)
                  </span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const RECIPIENT_STATUSES: readonly RecipientStatus[] = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
  'failed',
];

/**
 * CSV export helper — RFC 4180 quoting. Quote every field so
 * commas/newlines/quotes round-trip cleanly.
 */
function toCsv(rows: string[][]): string {
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return rows.map((r) => r.map(escape).join(',')).join('\n');
}

function downloadBlob(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function BroadcastDetailPage() {
  const params = useParams();
  const router = useRouter();
  const broadcastId = params.id as string;
  const { createAndSendBroadcast, resendFailedRecipients, isProcessing, progress } =
    useBroadcastSending();

  const [broadcast, setBroadcast] = useState<Broadcast | null>(null);
  const [recipients, setRecipients] = useState<BroadcastRecipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<RecipientStatus | 'all'>(
    'all',
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Tracks which resend is in flight ('all' or a specific recipient id) so
  // the header button and the per-row icon can show their own spinner
  // instead of both lighting up whenever `isProcessing` is true.
  const [resendTarget, setResendTarget] = useState<string | 'all' | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const supabase = createClient();

      const { data: bc, error: bcError } = await supabase
        .from('broadcasts')
        .select('*')
        .eq('id', broadcastId)
        .single();

      if (bcError) throw bcError;
      setBroadcast(bc);

      const { data: recs, error: recsError } = await supabase
        .from('broadcast_recipients')
        .select('*, contact:contacts(*)')
        .eq('broadcast_id', broadcastId)
        .order('created_at', { ascending: false });

      if (recsError) throw recsError;
      setRecipients(recs ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load broadcast');
    } finally {
      setLoading(false);
    }
  }, [broadcastId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  async function handleSendDraft() {
    if (!broadcast) return;
    const supabase = createClient();

    const { data: templateData, error: templateError } = await supabase
      .from('message_templates')
      .select('*')
      .eq('name', broadcast.template_name)
      .eq('language', broadcast.template_language)
      .single();

    if (templateError || !templateData) {
      toast.error(`Template "${broadcast.template_name}" não encontrado.`);
      return;
    }

    const af = (broadcast.audience_filter ?? {}) as Record<string, unknown>;
    const audience: AudienceConfig = {
      type: (af.type as AudienceConfig['type']) ?? 'all',
      tagIds: af.tagIds as string[] | undefined,
      excludeTagIds: af.excludeTagIds as string[] | undefined,
      csvContacts: af.csvContacts as AudienceConfig['csvContacts'],
      customField: af.customField as AudienceConfig['customField'] | undefined,
    };
    const variables = (broadcast.template_variables ?? {}) as Record<string, VariableMapping>;

    try {
      await createAndSendBroadcast({
        name: broadcast.name,
        template: templateData as MessageTemplate,
        audience,
        variables,
        existingBroadcastId: broadcast.id,
      });
      setLoading(true);
      await fetchData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao enviar broadcast');
    }
  }

  async function handleResend(recipientIds?: string[]) {
    if (isProcessing) return;
    setResendTarget(recipientIds && recipientIds.length === 1 ? recipientIds[0] : 'all');
    try {
      const { resent, stillFailed } = await resendFailedRecipients(
        broadcastId,
        recipientIds,
      );
      if (resent === 0 && stillFailed === 0) {
        toast.info('Nenhum destinatário com falha para reenviar.');
      } else if (stillFailed === 0) {
        toast.success(`${resent} mensagem${resent === 1 ? '' : 's'} reenviada${resent === 1 ? '' : 's'} com sucesso.`);
      } else {
        toast.warning(`${resent} reenviada${resent === 1 ? '' : 's'}, ${stillFailed} continua${stillFailed === 1 ? '' : 'm'} com falha.`);
      }
      await fetchData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao reenviar mensagens');
    } finally {
      setResendTarget(null);
    }
  }

  const filteredRecipients = useMemo(
    () =>
      statusFilter === 'all'
        ? recipients
        : recipients.filter((r) => r.status === statusFilter),
    [recipients, statusFilter],
  );

  function handleExport() {
    if (!broadcast) return;
    const header = [
      'Contact',
      'Phone',
      'Status',
      'Sent At',
      'Delivered At',
      'Read At',
      'Replied At',
      'Error',
    ];
    const rows = recipients.map((r) => [
      r.contact?.name ?? '',
      r.contact?.phone ?? '',
      r.status,
      r.sent_at ?? '',
      r.delivered_at ?? '',
      r.read_at ?? '',
      r.replied_at ?? '',
      r.error_message ?? '',
    ]);
    const csv = toCsv([header, ...rows]);
    const safeName = broadcast.name.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
    downloadBlob(`broadcast-${safeName}-${broadcastId.slice(0, 8)}.csv`, csv);
  }

  async function handleDelete() {
    setDeleting(true);
    const supabase = createClient();
    // broadcast_recipients cascades on broadcasts.id (migration 001), so a
    // single delete is sufficient — the aggregate trigger in migration 003
    // is defined on broadcast_recipients but fires only on its own row
    // changes, not on a cascaded drop of the parent row.
    const { error: delErr } = await supabase
      .from('broadcasts')
      .delete()
      .eq('id', broadcastId);
    setDeleting(false);
    if (delErr) {
      toast.error(`Failed to delete: ${delErr.message}`);
      return;
    }
    toast.success('Broadcast deleted');
    router.push('/broadcasts');
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !broadcast) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-400">{error ?? 'Broadcast not found'}</p>
        <Button variant="outline" onClick={() => router.push('/broadcasts')}>
          Back to Broadcasts
        </Button>
      </div>
    );
  }

  const status = getBroadcastStatus(broadcast.status);

  const funnelSteps: FunnelStep[] = [
    { label: 'Sent', value: broadcast.sent_count, color: 'bg-primary' },
    { label: 'Delivered', value: broadcast.delivered_count, color: 'bg-teal-500' },
    { label: 'Read', value: broadcast.read_count, color: 'bg-blue-500' },
    { label: 'Replied', value: broadcast.replied_count, color: 'bg-indigo-500' },
  ];

  return (
    <div className="space-y-6">
      {/* Progress bar while sending a draft */}
      {isProcessing && (
        <div className="fixed inset-x-0 top-0 z-40 h-0.5 bg-muted">
          <div
            className="h-0.5 bg-primary transition-[width] duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-4">
          <Button
            variant="outline"
            size="icon"
            onClick={() => router.push('/broadcasts')}
            className="border-border"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-foreground">{broadcast.name}</h1>
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${status.classes}`}
              >
                {status.label}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-3 text-sm text-muted-foreground">
              <span>Template: {broadcast.template_name}</span>
              <span>-</span>
              <span>
                Created {new Date(broadcast.created_at).toLocaleDateString()}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Send button — only shown for drafts */}
          {broadcast.status === 'draft' && (
            <Button
              size="sm"
              disabled={isProcessing}
              onClick={handleSendDraft}
              className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {isProcessing ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Enviando… {progress}%
                </>
              ) : (
                <>
                  <Send className="h-3.5 w-3.5" />
                  Enviar Broadcast
                </>
              )}
            </Button>
          )}

          {/* Resend failures — only once there's something to resend and
              nothing is currently sending/draft. */}
          {broadcast.status !== 'draft' &&
            broadcast.status !== 'sending' &&
            broadcast.failed_count > 0 && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={isProcessing}
                      onClick={() => handleResend()}
                      className="border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
                    />
                  }
                >
                  {isProcessing && resendTarget === 'all' ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Reenviando… {progress}%
                    </>
                  ) : (
                    <>
                      <RotateCw className="h-3.5 w-3.5" />
                      Reenviar falhas
                    </>
                  )}
                </TooltipTrigger>
                <TooltipContent>
                  Somente os destinatários com status &quot;Failed&quot; serão reenviados.
                </TooltipContent>
              </Tooltip>
            )}

          {/* Delete — inline-confirm pattern matches the pipeline-settings
              "Delete Pipeline" flow. Mid-send broadcasts can't be deleted
              because orphaning in-flight Meta messages would leave the
              funnel inconsistent. */}
          {confirmDelete ? (
          <div className="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-sm">
            <span className="text-red-300">Delete this broadcast?</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
              className="h-7 border-border bg-transparent text-muted-foreground hover:bg-muted"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleDelete}
              disabled={deleting}
              className="h-7 bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
            >
              {deleting ? 'Deleting…' : 'Confirm'}
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={broadcast.status === 'sending'}
            onClick={() => setConfirmDelete(true)}
            title={
              broadcast.status === 'sending'
                ? 'Cannot delete while a broadcast is actively sending'
                : 'Delete this broadcast'
            }
            className="border-red-500/30 bg-transparent text-red-400 hover:bg-red-500/10 disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </Button>
        )}
        </div>
      </div>

      {/* Stats — 6 cards: Total / Sent / Delivered / Read / Replied / Failed */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label="Total Recipients"
          value={broadcast.total_recipients}
          total={broadcast.total_recipients}
          icon={<Users className="h-4 w-4" />}
          color="bg-muted text-muted-foreground"
        />
        <StatCard
          label="Sent"
          value={broadcast.sent_count}
          total={broadcast.total_recipients}
          icon={<Send className="h-4 w-4" />}
          color="bg-primary/10 text-primary"
        />
        <StatCard
          label="Delivered"
          value={broadcast.delivered_count}
          total={broadcast.total_recipients}
          icon={<CheckCheck className="h-4 w-4" />}
          color="bg-teal-500/10 text-teal-400"
        />
        <StatCard
          label="Read"
          value={broadcast.read_count}
          total={broadcast.total_recipients}
          icon={<Eye className="h-4 w-4" />}
          color="bg-blue-500/10 text-blue-400"
        />
        <StatCard
          label="Replied"
          value={broadcast.replied_count}
          total={broadcast.total_recipients}
          icon={<MessageCircle className="h-4 w-4" />}
          color="bg-indigo-500/10 text-indigo-400"
        />
        <StatCard
          label="Failed"
          value={broadcast.failed_count}
          total={broadcast.total_recipients}
          icon={<AlertCircle className="h-4 w-4" />}
          color="bg-red-500/10 text-red-400"
        />
      </div>

      <FunnelChart steps={funnelSteps} />

      {/* Recipients Table */}
      <div className="rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-medium text-foreground">
            Recipients ({filteredRecipients.length}
            {statusFilter !== 'all' ? ` of ${recipients.length}` : ''})
          </h2>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-border text-muted-foreground hover:bg-muted"
                  />
                }
              >
                <Filter className="h-3.5 w-3.5" />
                {statusFilter === 'all'
                  ? 'All statuses'
                  : getRecipientStatus(statusFilter).label}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="border-border bg-popover">
                <DropdownMenuItem
                  onClick={() => setStatusFilter('all')}
                  className={
                    statusFilter === 'all' ? 'text-primary' : 'text-popover-foreground'
                  }
                >
                  All statuses
                </DropdownMenuItem>
                {RECIPIENT_STATUSES.map((s) => (
                  <DropdownMenuItem
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    className={
                      statusFilter === s
                        ? 'text-primary'
                        : 'text-popover-foreground'
                    }
                  >
                    {getRecipientStatus(s).label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              disabled={recipients.length === 0}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </Button>
          </div>
        </div>

        {filteredRecipients.length === 0 ? (
          <div className="flex h-32 items-center justify-center">
            <p className="text-sm text-muted-foreground">
              {recipients.length === 0
                ? 'No recipients found.'
                : 'No recipients match this filter.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="text-muted-foreground">Contact</TableHead>
                  <TableHead className="text-muted-foreground">Phone</TableHead>
                  <TableHead className="text-muted-foreground">Status</TableHead>
                  <TableHead className="text-muted-foreground">Sent</TableHead>
                  <TableHead className="text-muted-foreground">Delivered</TableHead>
                  <TableHead className="text-muted-foreground">Read</TableHead>
                  <TableHead className="text-muted-foreground">Error</TableHead>
                  <TableHead className="w-12 px-1 text-center text-muted-foreground">
                    Options
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRecipients.map((recipient) => {
                  const rStatus = getRecipientStatus(recipient.status);
                  return (
                    <TableRow key={recipient.id} className="border-border">
                      <TableCell className="font-medium text-foreground">
                        {recipient.contact?.name ?? 'Unknown'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {recipient.contact?.phone ?? '-'}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${rStatus.classes}`}
                        >
                          {rStatus.label}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {recipient.sent_at
                          ? new Date(recipient.sent_at).toLocaleString()
                          : '-'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {recipient.delivered_at
                          ? new Date(recipient.delivered_at).toLocaleString()
                          : '-'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {recipient.read_at
                          ? new Date(recipient.read_at).toLocaleString()
                          : '-'}
                      </TableCell>
                      <TableCell
                        className="max-w-[10rem] truncate text-xs text-red-400"
                        title={recipient.error_message ?? undefined}
                      >
                        {recipient.error_message ?? '-'}
                      </TableCell>
                      <TableCell className="px-1 text-center">
                        {recipient.status === 'failed' && (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <button
                                  type="button"
                                  disabled={isProcessing}
                                  onClick={() => handleResend([recipient.id])}
                                  className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                                />
                              }
                            >
                              {isProcessing && resendTarget === recipient.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Send className="h-3.5 w-3.5" />
                              )}
                            </TooltipTrigger>
                            <TooltipContent>Reenviar para este contato</TooltipContent>
                          </Tooltip>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
