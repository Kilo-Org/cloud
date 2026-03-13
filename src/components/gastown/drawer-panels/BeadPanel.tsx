'use client';

import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { BeadEventTimeline, extractPrUrl } from '@/components/gastown/ActivityFeed';
import type { ResourceRef } from '@/components/gastown/DrawerStack';

import { format } from 'date-fns';
import {
  Clock,
  ExternalLink,
  Flag,
  Hash,
  Tags,
  User,
  Hexagon,
  FileText,
  GitBranch,
  ChevronRight,
  Bot,
  Network,
  ArrowDownRight,
  ArrowUpRight,
  GitPullRequest,
  CircleDot,
  Layers,
  Pencil,
  X,
  Save,
  Loader2,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const BEAD_STATUSES = ['open', 'in_progress', 'in_review', 'closed', 'failed'] as const;
const BEAD_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;

const STATUS_STYLES: Record<string, string> = {
  open: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  in_progress: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  in_review: 'border-violet-500/30 bg-violet-500/10 text-violet-300',
  closed: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  failed: 'border-red-500/30 bg-red-500/10 text-red-300',
};

const PRIORITY_STYLES: Record<string, string> = {
  critical: 'text-red-400',
  high: 'text-orange-400',
  medium: 'text-amber-400',
  low: 'text-white/50',
};

type EditState = {
  title: string;
  body: string;
  status: string;
  priority: string;
  labels: string;
  metadata: string;
  rig_id: string;
  parent_bead_id: string;
};

export function BeadPanel({
  beadId,
  rigId,
  push,
}: {
  beadId: string;
  rigId: string;
  push: (ref: ResourceRef) => void;
}) {
  const trpc = useGastownTRPC();
  const queryClient = useQueryClient();
  const beadsQuery = useQuery(trpc.gastown.listBeads.queryOptions({ rigId }));
  const agentsQuery = useQuery(trpc.gastown.listAgents.queryOptions({ rigId }));
  const rigQuery = useQuery(trpc.gastown.getRig.queryOptions({ rigId }));

  // Fetch convoy data for DAG edges — townId is needed for the query
  const townId = rigQuery.data?.town_id;
  const convoysQuery = useQuery({
    ...trpc.gastown.listConvoys.queryOptions({ townId: townId ?? '' }),
    enabled: !!townId,
  });

  const bead = (beadsQuery.data ?? []).find(b => b.bead_id === beadId);
  const agentNameById = (agentsQuery.data ?? []).reduce<Record<string, string>>((acc, a) => {
    acc[a.id] = a.name;
    return acc;
  }, {});

  // ── Edit mode state ───────────────────────────────────────────────────
  const [editing, setEditing] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [editState, setEditState] = useState<EditState>({
    title: '',
    body: '',
    status: '',
    priority: '',
    labels: '',
    metadata: '',
    rig_id: '',
    parent_bead_id: '',
  });

  const enterEditMode = useCallback(() => {
    if (!bead) return;
    setEditState({
      title: bead.title,
      body: bead.body ?? '',
      status: bead.status,
      priority: bead.priority,
      labels: bead.labels.join(', '),
      metadata:
        bead.metadata && Object.keys(bead.metadata).length > 0
          ? JSON.stringify(bead.metadata, null, 2)
          : '',
      rig_id: bead.rig_id ?? '',
      parent_bead_id: bead.parent_bead_id ?? '',
    });
    setEditing(true);
  }, [bead]);

  const cancelEdit = useCallback(() => setEditing(false), []);

  const updateField = useCallback(<K extends keyof EditState>(field: K, value: EditState[K]) => {
    setEditState(prev => ({ ...prev, [field]: value }));
  }, []);

  const {
    mutate: doUpdateBead,
    isPending: isUpdatePending,
    isError: isUpdateError,
    error: updateError,
  } = useMutation(
    trpc.gastown.updateBead.mutationOptions({
      onSuccess: () => {
        setEditing(false);
        void queryClient.invalidateQueries({
          queryKey: trpc.gastown.listBeads.queryKey({ rigId }),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.gastown.getRig.queryKey({ rigId }),
        });
      },
    })
  );

  const handleSave = useCallback(() => {
    if (!bead) return;

    // Build the diff — only send fields that changed
    const updates: Record<string, unknown> = {};
    if (editState.title !== bead.title) updates.title = editState.title;
    if (editState.body !== (bead.body ?? '')) {
      updates.body = editState.body || null;
    }
    if (editState.status !== bead.status) updates.status = editState.status;
    if (editState.priority !== bead.priority) updates.priority = editState.priority;
    const newLabels = editState.labels
      .split(',')
      .map(l => l.trim())
      .filter(Boolean);
    const oldLabels = bead.labels;
    if (JSON.stringify(newLabels) !== JSON.stringify(oldLabels)) {
      updates.labels = newLabels;
    }

    if (editState.metadata.trim()) {
      try {
        const parsed = JSON.parse(editState.metadata) as Record<string, unknown>;
        setMetadataError(null);
        if (JSON.stringify(parsed) !== JSON.stringify(bead.metadata)) {
          updates.metadata = parsed;
        }
      } catch {
        setMetadataError('Invalid JSON in metadata field');
        return;
      }
    } else if (bead.metadata && Object.keys(bead.metadata).length > 0) {
      updates.metadata = {};
    }

    const newRigId = editState.rig_id || null;
    if (newRigId !== (bead.rig_id ?? null)) {
      updates.rig_id = newRigId;
    }

    const newParent = editState.parent_bead_id || null;
    if (newParent !== (bead.parent_bead_id ?? null)) {
      updates.parent_bead_id = newParent;
    }

    if (Object.keys(updates).length === 0) {
      setEditing(false);
      return;
    }

    doUpdateBead({
      rigId,
      beadId: bead.bead_id,
      ...updates,
    } as Parameters<typeof doUpdateBead>[0]);
  }, [bead, editState, rigId, doUpdateBead]);

  if (!bead) {
    return <div className="p-6 text-center text-sm text-white/30">Loading bead…</div>;
  }

  const assigneeName = bead.assignee_agent_bead_id
    ? agentNameById[bead.assignee_agent_bead_id]
    : null;

  // Extract PR URL from bead metadata (set by setReviewPrUrl for merge_request beads).
  // Only allow https:// URLs to prevent XSS via javascript: protocol injection.
  const prUrl = extractPrUrl(bead.metadata);

  // Build related beads from the flat list and convoy DAG data
  const allBeads = beadsQuery.data ?? [];
  const convoys = convoysQuery.data ?? [];
  const relatedBeads = buildRelatedBeads(bead, allBeads, convoys);

  // Find parent convoy for metadata display
  const beadConvoyId =
    typeof bead.metadata?.convoy_id === 'string' ? bead.metadata.convoy_id : null;
  const parentConvoy = convoys.find(
    c => c.id === beadConvoyId || c.beads.some(b => b.bead_id === bead.bead_id)
  );

  return (
    <div className="flex flex-col gap-0">
      {/* Title area */}
      <div className="border-b border-white/[0.06] px-5 pt-4 pb-4">
        <div className="flex items-center gap-2">
          <Hexagon className="size-4 shrink-0 text-[color:oklch(95%_0.15_108_/_0.7)]" />
          {editing ? (
            <Input
              value={editState.title}
              onChange={e => updateField('title', e.target.value)}
              className="h-7 border-white/10 bg-white/5 text-sm font-semibold text-white/90"
            />
          ) : (
            <span className="truncate text-base font-semibold text-white/90">{bead.title}</span>
          )}
          <button
            onClick={editing ? cancelEdit : enterEditMode}
            className="ml-auto shrink-0 rounded-md p-1 text-white/30 transition-colors hover:bg-white/[0.06] hover:text-white/60"
            title={editing ? 'Cancel editing' : 'Edit bead'}
          >
            {editing ? <X className="size-3.5" /> : <Pencil className="size-3.5" />}
          </button>
        </div>

        {editing ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <EditSelect
              value={editState.status}
              options={BEAD_STATUSES}
              onChange={v => updateField('status', v)}
              label="Status"
            />
            <EditSelect
              value={editState.priority}
              options={BEAD_PRIORITIES}
              onChange={v => updateField('priority', v)}
              label="Priority"
            />
            <div className="ml-auto flex items-center gap-1.5">
              <Button
                size="sm"
                onClick={handleSave}
                disabled={isUpdatePending}
                className="gap-1bg-[color:oklch(95%_0.15_108_/_0.90)] h-6 px-2.5 text-[10px] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
              >
                {isUpdatePending ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Save className="size-3" />
                )}
                Save
              </Button>
              {isUpdateError && (
                <span className="text-[10px] text-red-400">{updateError?.message ?? 'Failed'}</span>
              )}
            </div>
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span
              className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLES[bead.status] ?? 'border-white/10 text-white/50'}`}
            >
              {bead.status.replace('_', ' ')}
            </span>
            <Badge variant="outline" className="text-[10px]">
              {bead.type}
            </Badge>
            <span
              className={`inline-flex items-center gap-0.5 text-[10px] font-medium ${PRIORITY_STYLES[bead.priority] ?? 'text-white/50'}`}
            >
              <Flag className="size-2.5" />
              {bead.priority}
            </span>
          </div>
        )}
      </div>

      {/* Edit mode: additional fields */}
      {editing && (
        <div className="space-y-3 border-b border-white/[0.06] px-5 py-3">
          <div>
            <label className="mb-1 block text-[10px] font-medium text-white/30">Labels</label>
            <Input
              value={editState.labels}
              onChange={e => updateField('labels', e.target.value)}
              placeholder="comma-separated labels"
              className="h-7 border-white/10 bg-white/5 text-xs text-white/75"
            />
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-medium text-white/30">Body</label>
            <Textarea
              value={editState.body}
              onChange={e => updateField('body', e.target.value)}
              placeholder="Bead description (Markdown)"
              className="min-h-[80px] border-white/10 bg-white/5 text-xs text-white/75"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-[10px] font-medium text-white/30">Rig ID</label>
              <Input
                value={editState.rig_id}
                onChange={e => updateField('rig_id', e.target.value)}
                placeholder="rig UUID"
                className="h-7 border-white/10 bg-white/5 font-mono text-[10px] text-white/75"
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-medium text-white/30">
                Parent Bead
              </label>
              <Input
                value={editState.parent_bead_id}
                onChange={e => updateField('parent_bead_id', e.target.value)}
                placeholder="parent bead UUID"
                className="h-7 border-white/10 bg-white/5 font-mono text-[10px] text-white/75"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-medium text-white/30">
              Metadata (JSON)
            </label>
            <Textarea
              value={editState.metadata}
              onChange={e => {
                updateField('metadata', e.target.value);
                setMetadataError(null);
              }}
              placeholder='{"key": "value"}'
              className={`min-h-[60px] border-white/10 bg-white/5 font-mono text-[10px] text-white/75 ${metadataError ? 'border-red-500/50' : ''}`}
            />
            {metadataError && (
              <span className="mt-0.5 block text-[10px] text-red-400">{metadataError}</span>
            )}
          </div>
        </div>
      )}

      {/* Metadata grid (read-only, hidden during edit) */}
      {!editing && (
        <div className="grid grid-cols-2 border-b border-white/[0.06]">
          <MetaCell icon={Hash} label="Bead ID" value={bead.bead_id.slice(0, 8)} mono />
          <MetaCell
            icon={Clock}
            label="Created"
            value={format(new Date(bead.created_at), 'MMM d, HH:mm')}
          />

          {/* Assignee — clickable to open agent drawer */}
          {bead.assignee_agent_bead_id ? (
            <button
              onClick={() => {
                if (townId) {
                  push({
                    type: 'agent',
                    agentId: bead.assignee_agent_bead_id ?? '',
                    rigId,
                    townId,
                  });
                }
              }}
              className="group/link flex flex-col border-r border-b border-white/[0.04] px-4 py-3 text-left transition-colors hover:bg-white/[0.03] [&:nth-child(2n)]:border-r-0"
            >
              <div className="flex items-center gap-1 text-[10px] text-white/30">
                <User className="size-3" />
                Assignee
              </div>
              <div className="mt-0.5 flex items-center gap-1 text-sm text-[color:oklch(95%_0.15_108)]">
                <Bot className="size-3" />
                <span className="truncate">
                  {assigneeName ?? bead.assignee_agent_bead_id.slice(0, 8)}
                </span>
                <ChevronRight className="size-3 shrink-0 text-white/15 transition-colors group-hover/link:text-white/30" />
              </div>
            </button>
          ) : (
            <MetaCell icon={User} label="Assignee" value="Unassigned" />
          )}

          <MetaCell
            icon={Tags}
            label="Labels"
            value={bead.labels.length ? bead.labels.join(', ') : 'None'}
          />

          {/* Parent bead — clickable */}
          {bead.parent_bead_id && (
            <button
              onClick={() => push({ type: 'bead', beadId: bead.parent_bead_id ?? '', rigId })}
              className="group/link flex flex-col border-r border-b border-white/[0.04] px-4 py-3 text-left transition-colors hover:bg-white/[0.03] [&:nth-child(2n)]:border-r-0"
            >
              <div className="flex items-center gap-1 text-[10px] text-white/30">
                <GitBranch className="size-3" />
                Parent Bead
              </div>
              <div className="mt-0.5 flex items-center gap-1 font-mono text-xs text-[color:oklch(95%_0.15_108)]">
                <span>{bead.parent_bead_id.slice(0, 8)}</span>
                <ChevronRight className="size-3 shrink-0 text-white/15 transition-colors group-hover/link:text-white/30" />
              </div>
            </button>
          )}
        </div>
      )}

      {/* Convoy membership */}
      {parentConvoy && (
        <div className="border-b border-white/[0.06] px-5 py-3">
          <div className="flex items-center gap-2">
            <Layers className="size-3 text-violet-400/60" />
            <span className="text-[10px] text-white/40">Convoy:</span>
            <span className="text-xs font-medium text-violet-300/80">{parentConvoy.title}</span>
          </div>
          {parentConvoy.feature_branch && (
            <div className="mt-1.5 flex items-center gap-1.5">
              <GitBranch className="size-3 text-white/20" />
              <span className="font-mono text-[10px] text-white/30">
                {parentConvoy.feature_branch}
              </span>
            </div>
          )}
        </div>
      )}

      {/* PR link for merge_request beads */}
      {bead.type === 'merge_request' && prUrl && (
        <div className="border-b border-white/[0.06] px-5 py-3">
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-[color:oklch(95%_0.15_108)] transition-colors hover:bg-white/[0.06]"
          >
            <ExternalLink className="size-3" />
            {prUrl.includes('github.com') ? 'View Pull Request' : 'View Merge Request'}
          </a>
        </div>
      )}

      {/* Related Beads DAG */}
      {relatedBeads.length > 0 && (
        <div className="border-b border-white/[0.06] px-5 py-4">
          <div className="mb-3 flex items-center gap-1.5">
            <Network className="size-3 text-white/25" />
            <span className="text-[10px] font-medium tracking-wide text-white/30 uppercase">
              Related Beads
            </span>
          </div>
          <div className="flex flex-col gap-1">
            {relatedBeads.map(rel => (
              <button
                key={`${rel.relation}-${rel.bead.bead_id}`}
                onClick={() => push({ type: 'bead', beadId: rel.bead.bead_id, rigId })}
                className="group/rel flex items-center gap-2.5 rounded-md px-3 py-2 text-left transition-colors hover:bg-white/[0.04]"
              >
                <rel.icon className="size-3.5 shrink-0 text-white/30" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] font-medium text-white/35">{rel.label}</span>
                    <Badge variant="outline" className="px-1 py-0 text-[9px]">
                      {rel.bead.type.replace('_', ' ')}
                    </Badge>
                    <span
                      className={`ml-auto inline-flex items-center rounded-md border px-1.5 py-0 text-[9px] font-medium ${STATUS_STYLES[rel.bead.status] ?? 'border-white/10 text-white/50'}`}
                    >
                      {rel.bead.status.replace('_', ' ')}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1">
                    <span className="truncate text-xs text-white/65">{rel.bead.title}</span>
                    <ChevronRight className="size-3 shrink-0 text-white/10 transition-colors group-hover/rel:text-white/25" />
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Body (markdown) — hidden during edit since body is in the edit form */}
      {!editing && bead.body && bead.body.trim().length > 0 && (
        <div className="border-b border-white/[0.06] px-5 py-4">
          <div className="mb-2 flex items-center gap-1.5">
            <FileText className="size-3 text-white/25" />
            <span className="text-[10px] font-medium tracking-wide text-white/30 uppercase">
              Description
            </span>
          </div>
          <div className="prose prose-sm prose-invert prose-headings:text-white/80 prose-p:text-white/65 prose-a:text-[color:oklch(95%_0.15_108)] prose-strong:text-white/80 prose-code:rounded prose-code:bg-white/[0.06] prose-code:px-1 prose-code:py-0.5 prose-code:text-[11px] prose-code:text-white/70 prose-pre:bg-white/[0.04] prose-pre:border prose-pre:border-white/[0.06] prose-li:text-white/65 max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{bead.body}</ReactMarkdown>
          </div>
        </div>
      )}

      {/* Event Timeline */}
      <div className="px-5 pt-4 pb-2">
        <div className="mb-2 flex items-center gap-1.5">
          <Clock className="size-3 text-white/25" />
          <span className="text-[10px] font-medium tracking-wide text-white/30 uppercase">
            Event Timeline
          </span>
        </div>
      </div>
      <div className="px-3 pb-6">
        <BeadEventTimeline rigId={rigId} beadId={bead.bead_id} />
      </div>
    </div>
  );
}

// ── Edit select component ───────────────────────────────────────────────

function EditSelect({
  value,
  options,
  onChange,
  label,
}: {
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      aria-label={label}
      className="h-6 rounded-md border border-white/10 bg-white/5 px-2 text-[10px] font-medium text-white/70 outline-none focus:border-white/20"
    >
      {options.map(opt => (
        <option key={opt} value={opt} className="bg-zinc-900 text-white">
          {opt.replace(/_/g, ' ')}
        </option>
      ))}
    </select>
  );
}

function MetaCell({
  icon: Icon,
  label,
  value,
  mono,
}: {
  icon: typeof Clock;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="border-r border-b border-white/[0.04] px-4 py-3 [&:nth-child(2n)]:border-r-0">
      <div className="flex items-center gap-1 text-[10px] text-white/30">
        <Icon className="size-3" />
        {label}
      </div>
      <div className={`mt-0.5 truncate text-sm text-white/75 ${mono ? 'font-mono text-xs' : ''}`}>
        {value}
      </div>
    </div>
  );
}

// ── Related beads DAG ─────────────────────────────────────────────────

type BeadLike = {
  bead_id: string;
  type: string;
  status: string;
  title: string;
  parent_bead_id: string | null;
  rig_id?: string | null;
  metadata: Record<string, unknown>;
};

type RelatedBead = {
  relation: string;
  label: string;
  icon: typeof Clock;
  bead: BeadLike;
};

type ConvoyLike = {
  id: string;
  title: string;
  feature_branch?: string | null;
  beads: Array<{ bead_id: string; title: string; status: string; rig_id: string | null }>;
  dependency_edges?: Array<{ bead_id: string; depends_on_bead_id: string }>;
};

/**
 * Compute the DAG neighborhood of a bead from the flat list and convoy data.
 * Includes: children, source/review links, blockers, and dependents from convoy DAG.
 */
function buildRelatedBeads(
  bead: BeadLike,
  allBeads: BeadLike[],
  convoys: ConvoyLike[]
): RelatedBead[] {
  const related: RelatedBead[] = [];

  // Find which convoy this bead belongs to (if any) via metadata or convoy beads list
  const convoyId = typeof bead.metadata?.convoy_id === 'string' ? bead.metadata.convoy_id : null;
  const parentConvoy = convoys.find(
    c => c.id === convoyId || c.beads.some(b => b.bead_id === bead.bead_id)
  );

  // Show convoy membership
  if (parentConvoy) {
    // Find blockers (beads that this bead depends on / is blocked by)
    const edges = parentConvoy.dependency_edges ?? [];
    const blockerIds = new Set(
      edges.filter(e => e.bead_id === bead.bead_id).map(e => e.depends_on_bead_id)
    );
    for (const blockerId of blockerIds) {
      const blockerBead = allBeads.find(b => b.bead_id === blockerId);
      const convoyBead = parentConvoy.beads.find(b => b.bead_id === blockerId);
      if (blockerBead) {
        related.push({
          relation: 'blocker',
          label: 'Blocked by',
          icon: ArrowUpRight,
          bead: blockerBead,
        });
      } else if (convoyBead) {
        // Bead is in convoy but not in the rig's bead list — use convoy data
        related.push({
          relation: 'blocker',
          label: 'Blocked by',
          icon: ArrowUpRight,
          bead: {
            bead_id: convoyBead.bead_id,
            type: 'issue',
            status: convoyBead.status,
            title: convoyBead.title,
            parent_bead_id: null,
            rig_id: convoyBead.rig_id,
            metadata: {},
          },
        });
      }
    }

    // Find dependents (beads that depend on / are blocked by this bead)
    const dependentIds = new Set(
      edges.filter(e => e.depends_on_bead_id === bead.bead_id).map(e => e.bead_id)
    );
    for (const depId of dependentIds) {
      const depBead = allBeads.find(b => b.bead_id === depId);
      const convoyBead = parentConvoy.beads.find(b => b.bead_id === depId);
      if (depBead) {
        related.push({
          relation: 'dependent',
          label: 'Blocks',
          icon: ArrowDownRight,
          bead: depBead,
        });
      } else if (convoyBead) {
        related.push({
          relation: 'dependent',
          label: 'Blocks',
          icon: ArrowDownRight,
          bead: {
            bead_id: convoyBead.bead_id,
            type: 'issue',
            status: convoyBead.status,
            title: convoyBead.title,
            parent_bead_id: null,
            rig_id: convoyBead.rig_id,
            metadata: {},
          },
        });
      }
    }
  }

  // Child beads (beads whose parent_bead_id = this bead)
  for (const b of allBeads) {
    if (b.parent_bead_id === bead.bead_id) {
      related.push({ relation: 'child', label: 'Child', icon: ArrowDownRight, bead: b });
    }
  }

  // For merge_request beads: link back to the source bead
  if (bead.type === 'merge_request' && typeof bead.metadata?.source_bead_id === 'string') {
    const source = allBeads.find(b => b.bead_id === bead.metadata.source_bead_id);
    if (source) {
      related.push({ relation: 'source', label: 'Source Work', icon: CircleDot, bead: source });
    }
  }

  // For non-MR beads: find any MR beads that track this bead
  if (bead.type !== 'merge_request') {
    for (const b of allBeads) {
      if (b.type === 'merge_request' && b.metadata?.source_bead_id === bead.bead_id) {
        related.push({ relation: 'review', label: 'Review', icon: GitPullRequest, bead: b });
      }
    }
  }

  return related;
}
