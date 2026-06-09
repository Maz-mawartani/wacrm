'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import {
  Broadcast,
  BroadcastRecipient,
  MessageTemplate,
  RecipientStatus,
  TemplateButtonParameter,
  TemplateHeaderInput,
} from '@/types';
import {
  useBroadcastSending,
  type AudienceConfig,
  type VariableMapping,
} from '@/hooks/use-broadcast-sending';
import { Button } from '@/components/ui/button';
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
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import { getBroadcastStatus, getRecipientStatus } from '@/lib/broadcast-status';

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
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <div className="flex items-center justify-between">
        <div
          className={`flex h-8 w-8 items-center justify-center rounded-lg ${color}`}
        >
          {icon}
        </div>
        <span className="text-xs text-slate-500">{pct}%</span>
      </div>
      <p className="mt-3 text-2xl font-bold text-white">
        {value.toLocaleString()}
      </p>
      <p className="text-xs text-slate-400">{label}</p>
    </div>
  );
}

interface FunnelStep {
  label: string;
  value: number;
  color: string;
}

interface FailureCategory {
  key: string;
  label: string;
  classes: string;
}

/**
 * Pure-CSS funnel chart: decreasing-width rounded bars.
 * Width is relative to the largest step (typically Sent) so we
 * always render a full bar at the top and proportional tails.
 */
function FunnelChart({ steps }: { steps: FunnelStep[] }) {
  const max = Math.max(...steps.map((s) => s.value), 1);
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <h3 className="mb-4 text-sm font-medium text-white">Funnel</h3>
      <div className="space-y-2">
        {steps.map((step) => {
          const pctOfMax = Math.max(5, Math.round((step.value / max) * 100));
          const pctOfSent =
            steps[0].value > 0
              ? Math.round((step.value / steps[0].value) * 100)
              : 0;
          return (
            <div key={step.label} className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-xs text-slate-400">
                {step.label}
              </span>
              <div className="relative h-7 flex-1 rounded-full bg-slate-800">
                <div
                  className={`h-7 rounded-full ${step.color} transition-[width] duration-500`}
                  style={{ width: `${pctOfMax}%` }}
                />
                <span className="absolute inset-0 flex items-center px-3 text-xs font-medium text-white">
                  {step.value.toLocaleString()}
                  <span className="ml-2 text-slate-300/80">({pctOfSent}%)</span>
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

const failureCategories = {
  ecosystem_health: {
    key: 'ecosystem_health',
    label: 'Ecosystem health',
    classes: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
  },
  undeliverable: {
    key: 'undeliverable',
    label: 'Undeliverable',
    classes: 'bg-red-500/10 text-red-300 border-red-500/20',
  },
  experiment: {
    key: 'experiment',
    label: 'Experiment',
    classes: 'bg-purple-500/10 text-purple-300 border-purple-500/20',
  },
  invalid_phone: {
    key: 'invalid_phone',
    label: 'Invalid phone',
    classes: 'bg-orange-500/10 text-orange-300 border-orange-500/20',
  },
  other: {
    key: 'other',
    label: 'Other',
    classes: 'bg-slate-500/10 text-slate-300 border-slate-500/20',
  },
} satisfies Record<string, FailureCategory>;

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

function isHealthyEcosystemError(message: string | null | undefined): boolean {
  if (!message) return false;
  const normalized = message.toLowerCase();
  return (
    normalized.includes('131049') ||
    normalized.includes('healthy ecosystem engagement')
  );
}

function getFailureCategory(
  message: string | null | undefined
): FailureCategory {
  if (!message) return failureCategories.other;
  const normalized = message.toLowerCase();

  if (
    normalized.includes('131049') ||
    normalized.includes('healthy ecosystem') ||
    normalized.includes('meta chose not to deliver')
  ) {
    return failureCategories.ecosystem_health;
  }

  if (
    normalized.includes('130472') ||
    normalized.includes('part of an experiment')
  ) {
    return failureCategories.experiment;
  }

  if (
    normalized.includes('131026') ||
    normalized.includes('undeliverable') ||
    normalized.includes('incapable of receiving')
  ) {
    return failureCategories.undeliverable;
  }

  if (normalized.includes('invalid phone')) {
    return failureCategories.invalid_phone;
  }

  return failureCategories.other;
}

function getRecipientDisplayStatus(recipient: BroadcastRecipient) {
  if (recipient.status === 'pending' && recipient.whatsapp_message_id) {
    return {
      label: 'Accepted',
      classes: 'bg-sky-500/10 text-sky-400 border-sky-500/20',
    };
  }

  return getRecipientStatus(recipient.status);
}

function hasNoStatusAfterAcceptance(recipient: BroadcastRecipient): boolean {
  return (
    recipient.status === 'pending' &&
    Boolean(recipient.whatsapp_message_id) &&
    !recipient.error_message
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (item): item is string => typeof item === 'string'
  );
  return strings.length > 0 ? strings : undefined;
}

function normalizeVariableMappings(
  value: unknown
): Record<string, VariableMapping> {
  if (!isRecord(value)) return {};

  const variables: Record<string, VariableMapping> = {};
  for (const [key, rawMapping] of Object.entries(value)) {
    if (!isRecord(rawMapping)) continue;
    const { type, value: mappingValue } = rawMapping;
    if (
      (type === 'static' || type === 'field' || type === 'custom_field') &&
      typeof mappingValue === 'string'
    ) {
      variables[key] = { type, value: mappingValue };
    }
  }
  return variables;
}

function normalizeTemplateHeader(value: unknown): TemplateHeaderInput | null {
  if (!isRecord(value)) return null;
  if (value.type === 'text') {
    return {
      type: 'text',
      text: typeof value.text === 'string' ? value.text : undefined,
      value: typeof value.value === 'string' ? value.value : undefined,
    };
  }
  if (
    value.type === 'image' ||
    value.type === 'video' ||
    value.type === 'document'
  ) {
    return {
      type: value.type,
      media_url:
        typeof value.media_url === 'string' ? value.media_url : undefined,
      mediaUrl: typeof value.mediaUrl === 'string' ? value.mediaUrl : undefined,
      media_id: typeof value.media_id === 'string' ? value.media_id : undefined,
      mediaId: typeof value.mediaId === 'string' ? value.mediaId : undefined,
      filename: typeof value.filename === 'string' ? value.filename : undefined,
    };
  }
  return null;
}

function normalizeTemplateButtons(value: unknown): TemplateButtonParameter[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is TemplateButtonParameter => {
    if (!isRecord(item)) return false;
    if (
      item.type === 'url' &&
      (typeof item.index === 'string' || typeof item.index === 'number') &&
      typeof item.text === 'string'
    ) {
      return true;
    }
    return (
      item.type === 'quick_reply' &&
      (typeof item.index === 'string' || typeof item.index === 'number') &&
      typeof item.payload === 'string'
    );
  });
}

function normalizeCsvContacts(
  value: unknown
): { phone: string; name?: string }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows = value
    .filter(isRecord)
    .map((row) => ({
      phone: typeof row.phone === 'string' ? row.phone : '',
      name: typeof row.name === 'string' ? row.name : undefined,
    }))
    .filter((row) => row.phone);
  return rows.length > 0 ? rows : undefined;
}

function normalizeAudienceConfig(value: unknown): AudienceConfig | null {
  if (!isRecord(value)) return null;

  const excludeTagIds = normalizeStringArray(value.excludeTagIds);

  if (value.type === 'all') {
    return { type: 'all', excludeTagIds };
  }

  if (value.type === 'contacts') {
    const contactIds = normalizeStringArray(value.contactIds);
    return contactIds ? { type: 'contacts', contactIds, excludeTagIds } : null;
  }

  if (value.type === 'tags') {
    const tagIds = normalizeStringArray(value.tagIds);
    return tagIds ? { type: 'tags', tagIds, excludeTagIds } : null;
  }

  if (value.type === 'custom_field' && isRecord(value.customField)) {
    const { fieldId, operator, value: filterValue } = value.customField;
    if (
      typeof fieldId === 'string' &&
      (operator === 'is' || operator === 'is_not' || operator === 'contains') &&
      typeof filterValue === 'string' &&
      filterValue.length > 0
    ) {
      return {
        type: 'custom_field',
        customField: { fieldId, operator, value: filterValue },
        excludeTagIds,
      };
    }
    return null;
  }

  if (value.type === 'csv') {
    const csvContacts = normalizeCsvContacts(value.csvContacts);
    return csvContacts ? { type: 'csv', csvContacts, excludeTagIds } : null;
  }

  return null;
}

function buildDraftTemplate(broadcast: Broadcast): MessageTemplate {
  return {
    id: broadcast.template_name,
    user_id: broadcast.user_id,
    name: broadcast.template_name,
    category: 'Marketing',
    language: broadcast.template_language,
    body_text: '',
    created_at: broadcast.created_at,
  };
}

export default function BroadcastDetailPage() {
  const params = useParams();
  const router = useRouter();
  const broadcastId = params.id as string;
  const {
    createAndSendBroadcast,
    isProcessing: isSendingDraft,
    progress: draftProgress,
  } = useBroadcastSending();

  const [broadcast, setBroadcast] = useState<Broadcast | null>(null);
  const [recipients, setRecipients] = useState<BroadcastRecipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<RecipientStatus | 'all'>(
    'all'
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const fetchData = useCallback(
    async (showSpinner = true) => {
      if (showSpinner) setLoading(true);
      setError(null);

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
        setError(
          err instanceof Error ? err.message : 'Failed to load broadcast'
        );
      } finally {
        setLoading(false);
      }
    },
    [broadcastId]
  );

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`broadcast-detail-status:${broadcastId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'broadcasts',
          filter: `id=eq.${broadcastId}`,
        },
        (payload) => {
          setBroadcast(payload.new as Broadcast);
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'broadcast_recipients',
          filter: `broadcast_id=eq.${broadcastId}`,
        },
        (payload) => {
          const next = payload.new as BroadcastRecipient;
          setRecipients((current) =>
            current.map((recipient) =>
              recipient.id === next.id
                ? { ...recipient, ...next, contact: recipient.contact }
                : recipient
            )
          );
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'broadcast_recipients',
          filter: `broadcast_id=eq.${broadcastId}`,
        },
        (payload) => {
          const oldRow = payload.old as Partial<BroadcastRecipient>;
          setRecipients((current) =>
            current.filter((recipient) => recipient.id !== oldRow.id)
          );
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [broadcastId]);

  const filteredRecipients = useMemo(
    () =>
      statusFilter === 'all'
        ? recipients
        : recipients.filter((r) => r.status === statusFilter),
    [recipients, statusFilter]
  );
  const healthyEcosystemFailures = useMemo(
    () =>
      recipients.filter((recipient) =>
        isHealthyEcosystemError(recipient.error_message)
      ).length,
    [recipients]
  );
  const acceptedByMetaCount = useMemo(
    () =>
      recipients.filter((recipient) => recipient.whatsapp_message_id).length,
    [recipients]
  );
  const failedRecipients = useMemo(
    () =>
      recipients.filter(
        (recipient) => recipient.status === 'failed' || recipient.error_message
      ),
    [recipients]
  );
  const noStatusRecipients = useMemo(
    () => recipients.filter(hasNoStatusAfterAcceptance),
    [recipients]
  );
  const failureSummary = useMemo(() => {
    const byCategory = new Map<
      string,
      { category: FailureCategory; count: number }
    >();

    for (const recipient of failedRecipients) {
      const category = getFailureCategory(recipient.error_message);
      const current = byCategory.get(category.key);
      byCategory.set(category.key, {
        category,
        count: (current?.count ?? 0) + 1,
      });
    }

    return [...byCategory.values()].sort((a, b) => b.count - a.count);
  }, [failedRecipients]);

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
      getRecipientDisplayStatus(r).label,
      r.sent_at ?? '',
      r.delivered_at ?? '',
      r.read_at ?? '',
      r.replied_at ?? '',
      r.error_message ?? '',
    ]);
    const csv = toCsv([header, ...rows]);
    const safeName = broadcast.name
      .replace(/[^a-z0-9-_]+/gi, '-')
      .toLowerCase();
    downloadBlob(`broadcast-${safeName}-${broadcastId.slice(0, 8)}.csv`, csv);
  }

  function handleExportFailed() {
    if (!broadcast) return;
    const header = [
      'Contact',
      'Phone',
      'Failure Category',
      'Status',
      'Sent At',
      'Delivered At',
      'Read At',
      'Error',
    ];
    const rows = failedRecipients.map((r) => [
      r.contact?.name ?? '',
      r.contact?.phone ?? '',
      getFailureCategory(r.error_message).label,
      getRecipientDisplayStatus(r).label,
      r.sent_at ?? '',
      r.delivered_at ?? '',
      r.read_at ?? '',
      r.error_message ?? '',
    ]);
    const csv = toCsv([header, ...rows]);
    const safeName = broadcast.name
      .replace(/[^a-z0-9-_]+/gi, '-')
      .toLowerCase();
    downloadBlob(
      `broadcast-${safeName}-${broadcastId.slice(0, 8)}-failed.csv`,
      csv
    );
  }

  function handleExportNoStatus() {
    if (!broadcast) return;
    const header = [
      'Contact',
      'Phone',
      'Status',
      'WhatsApp Message ID',
      'Sent At',
      'Delivered At',
      'Read At',
    ];
    const rows = noStatusRecipients.map((r) => [
      r.contact?.name ?? '',
      r.contact?.phone ?? '',
      getRecipientDisplayStatus(r).label,
      r.whatsapp_message_id ?? '',
      r.sent_at ?? '',
      r.delivered_at ?? '',
      r.read_at ?? '',
    ]);
    const csv = toCsv([header, ...rows]);
    const safeName = broadcast.name
      .replace(/[^a-z0-9-_]+/gi, '-')
      .toLowerCase();
    downloadBlob(
      `broadcast-${safeName}-${broadcastId.slice(0, 8)}-no-status.csv`,
      csv
    );
  }

  async function handleSendDraft() {
    if (!broadcast || broadcast.status !== 'draft') return;

    const audience = normalizeAudienceConfig(broadcast.audience_filter);
    if (!audience) {
      toast.error(
        'This draft is missing a sendable audience. Create a new broadcast or save a new draft.'
      );
      return;
    }

    try {
      await createAndSendBroadcast({
        broadcastId: broadcast.id,
        name: broadcast.name,
        template: buildDraftTemplate(broadcast),
        audience,
        variables: normalizeVariableMappings(broadcast.template_variables),
        header: normalizeTemplateHeader(broadcast.template_header),
        buttonParams: normalizeTemplateButtons(broadcast.template_buttons),
      });
      toast.success('Draft broadcast sent');
      await fetchData(false);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to send draft broadcast';
      toast.error(message);
    }
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
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
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
    {
      label: 'Delivered',
      value: broadcast.delivered_count,
      color: 'bg-teal-500',
    },
    { label: 'Read', value: broadcast.read_count, color: 'bg-blue-500' },
    {
      label: 'Replied',
      value: broadcast.replied_count,
      color: 'bg-indigo-500',
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-4">
          <Button
            variant="outline"
            size="icon"
            onClick={() => router.push('/broadcasts')}
            className="border-slate-700"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-white">
                {broadcast.name}
              </h1>
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${status.classes}`}
              >
                {status.label}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-3 text-sm text-slate-400">
              <span>Template: {broadcast.template_name}</span>
              <span>-</span>
              <span>
                Created {new Date(broadcast.created_at).toLocaleDateString()}
              </span>
            </div>
          </div>
        </div>

        {/* Delete — inline-confirm pattern matches the pipeline-settings
            "Delete Pipeline" flow. Mid-send broadcasts can't be deleted
            because orphaning in-flight Meta messages would leave the
            funnel inconsistent. */}
        <div className="flex items-center gap-2">
          {broadcast.status === 'draft' && (
            <Button
              size="sm"
              onClick={() => void handleSendDraft()}
              disabled={isSendingDraft}
              className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {isSendingDraft ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              {isSendingDraft ? `${draftProgress}%` : 'Send draft'}
            </Button>
          )}

          <Button
            variant="outline"
            size="sm"
            onClick={() => void fetchData(false)}
            className="border-slate-700 bg-transparent text-slate-300 hover:bg-slate-800"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>

          {confirmDelete ? (
            <div className="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-sm">
              <span className="text-red-300">Delete this broadcast?</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                className="h-7 border-slate-700 bg-transparent text-slate-300 hover:bg-slate-800"
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
          color="bg-slate-800 text-slate-300"
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

      {isSendingDraft && (
        <div className="border-primary/20 bg-primary/5 rounded-xl border p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="text-primary h-4 w-4 animate-spin" />
              <p className="text-sm font-medium text-white">
                Sending draft broadcast...
              </p>
            </div>
            <span className="text-primary text-xs font-medium">
              {draftProgress}%
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-slate-800">
            <div
              className="bg-primary h-1.5 rounded-full transition-all duration-300"
              style={{ width: `${draftProgress}%` }}
            />
          </div>
        </div>
      )}

      {healthyEcosystemFailures > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
          <div className="flex gap-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-amber-200">
                {healthyEcosystemFailures.toLocaleString()} recipient
                {healthyEcosystemFailures === 1 ? '' : 's'} hit WhatsApp error
                #131049
              </p>
              <p className="text-xs leading-5 text-amber-100/80">
                Meta blocked delivery to protect user engagement. This is most
                common with marketing templates, cold audiences, or recipients
                who recently received too many business messages. Retrying
                immediately usually fails again.
              </p>
            </div>
          </div>
        </div>
      )}

      {failureSummary.length > 0 && (
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-white">Failure reasons</h3>
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportFailed}
              className="border-slate-700 text-slate-300 hover:bg-slate-800"
            >
              <Download className="h-3.5 w-3.5" />
              Export failed CSV
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {failureSummary.map(({ category, count }) => (
              <div
                key={category.key}
                className="rounded-lg border border-slate-800 bg-slate-950/40 p-3"
              >
                <span
                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${category.classes}`}
                >
                  {category.label}
                </span>
                <p className="mt-2 text-2xl font-bold text-white">
                  {count.toLocaleString()}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {noStatusRecipients.length > 0 && (
        <div className="rounded-xl border border-sky-500/20 bg-sky-500/10 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium text-sky-100">
                No status received
              </h3>
              <p className="mt-1 text-xs leading-5 text-sky-100/75">
                Meta accepted these sends and returned message ids, but the app
                has not received a later sent, delivered, read, or failed
                webhook for them. They are the best candidate list for aggregate
                Insights failures that were not captured per recipient.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-2xl font-bold text-white">
                {noStatusRecipients.length.toLocaleString()}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={handleExportNoStatus}
                className="border-sky-400/30 text-sky-100 hover:bg-sky-500/20"
              >
                <Download className="h-3.5 w-3.5" />
                Export no-status CSV
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Recipients Table */}
      <div className="rounded-xl border border-slate-800 bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
          <h2 className="text-sm font-medium text-white">
            Recipients ({filteredRecipients.length}
            {statusFilter !== 'all' ? ` of ${recipients.length}` : ''})
          </h2>
          {acceptedByMetaCount > 0 && (
            <span className="text-xs text-slate-500">
              Accepted by Meta: {acceptedByMetaCount.toLocaleString()}
            </span>
          )}
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-slate-700 text-slate-300 hover:bg-slate-800"
                  />
                }
              >
                <Filter className="h-3.5 w-3.5" />
                {statusFilter === 'all'
                  ? 'All statuses'
                  : getRecipientStatus(statusFilter).label}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="border-slate-700 bg-slate-900">
                <DropdownMenuItem
                  onClick={() => setStatusFilter('all')}
                  className={
                    statusFilter === 'all' ? 'text-primary' : 'text-slate-300'
                  }
                >
                  All statuses
                </DropdownMenuItem>
                {RECIPIENT_STATUSES.map((s) => (
                  <DropdownMenuItem
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    className={
                      statusFilter === s ? 'text-primary' : 'text-slate-300'
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
              className="border-slate-700 text-slate-300 hover:bg-slate-800"
            >
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </Button>
          </div>
        </div>

        {filteredRecipients.length === 0 ? (
          <div className="flex h-32 items-center justify-center">
            <p className="text-sm text-slate-400">
              {recipients.length === 0
                ? 'No recipients found.'
                : 'No recipients match this filter.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-slate-800 hover:bg-transparent">
                  <TableHead className="text-slate-400">Contact</TableHead>
                  <TableHead className="text-slate-400">Phone</TableHead>
                  <TableHead className="text-slate-400">Status</TableHead>
                  <TableHead className="text-slate-400">Failure</TableHead>
                  <TableHead className="text-slate-400">Sent</TableHead>
                  <TableHead className="text-slate-400">Delivered</TableHead>
                  <TableHead className="text-slate-400">Read</TableHead>
                  <TableHead className="text-slate-400">Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRecipients.map((recipient) => {
                  const rStatus = getRecipientDisplayStatus(recipient);
                  return (
                    <TableRow key={recipient.id} className="border-slate-800">
                      <TableCell className="font-medium text-white">
                        {recipient.contact?.name ?? 'Unknown'}
                      </TableCell>
                      <TableCell className="text-slate-300">
                        {recipient.contact?.phone ?? '-'}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${rStatus.classes}`}
                        >
                          {rStatus.label}
                        </span>
                      </TableCell>
                      <TableCell>
                        {recipient.error_message ? (
                          <span
                            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${getFailureCategory(recipient.error_message).classes}`}
                          >
                            {getFailureCategory(recipient.error_message).label}
                          </span>
                        ) : (
                          <span className="text-slate-500">-</span>
                        )}
                      </TableCell>
                      <TableCell className="text-slate-400">
                        {recipient.sent_at
                          ? new Date(recipient.sent_at).toLocaleString()
                          : '-'}
                      </TableCell>
                      <TableCell className="text-slate-400">
                        {recipient.delivered_at
                          ? new Date(recipient.delivered_at).toLocaleString()
                          : '-'}
                      </TableCell>
                      <TableCell className="text-slate-400">
                        {recipient.read_at
                          ? new Date(recipient.read_at).toLocaleString()
                          : '-'}
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-xs text-red-400">
                        {recipient.error_message ?? '-'}
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
