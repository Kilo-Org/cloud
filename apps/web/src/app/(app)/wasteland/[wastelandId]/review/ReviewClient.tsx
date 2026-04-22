'use client';

/**
 * Review inbox — typed-card view of open upstream pull requests.
 *
 * Each PR is classified server-side into one of five kinds (plus
 * `unknown` for foreign PRs) by the inbox classifier. This file renders
 * each kind as a dedicated card with reviewer-relevant context, and
 * exposes Merge / Close / Comment / View-on-DoltHub actions.
 *
 * Gating: only wasteland owners with admin mode enabled can load this
 * page. Contributors (no credential, or credential without
 * `is_upstream_admin`) get a permission-denied notice.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useWastelandTRPC } from '@/lib/wasteland/trpc';
import type { WastelandOutputs } from '@/lib/wasteland/trpc';
import { useUser } from '@/hooks/useUser';
import { useSetWastelandPageHeader } from '../WastelandPageHeaderContext';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import {
  Inbox,
  Loader2,
  GitMerge,
  XCircle,
  MessageSquare,
  ExternalLink,
  UserPlus,
  ScrollText,
  Pencil,
  Hand,
  ThumbsUp,
  ThumbsDown,
  ShieldCheck,
  HelpCircle,
  AlertTriangle,
  Star,
  CheckCircle2,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

type InboxItem = WastelandOutputs['wasteland']['listInboxItems']['items'][number];

type Filter = 'all' | InboxItem['kind'];

const FILTER_LABELS: Record<Filter, string> = {
  all: 'All',
  'rig-registration': 'Registrations',
  'wanted-post': 'New Posts',
  'wanted-edit': 'Edits',
  'work-submission': 'Submissions',
  'admin-action': 'Admin Actions',
  unknown: 'Unknown',
};

export function ReviewClient({ wastelandId }: { wastelandId: string }) {
  const trpc = useWastelandTRPC();
  const queryClient = useQueryClient();
  const { data: currentUser } = useUser();

  const wastelandQuery = useQuery(trpc.wasteland.getWasteland.queryOptions({ wastelandId }));
  const credentialQuery = useQuery(
    trpc.wasteland.getCredentialStatus.queryOptions({ wastelandId })
  );
  const membersQuery = useQuery(trpc.wasteland.listMembers.queryOptions({ wastelandId }));

  const isUpstreamAdmin = credentialQuery.data?.is_upstream_admin === true;
  const currentUserMember = membersQuery.data?.find(m => m.user_id === currentUser?.id);
  const isOwner = currentUserMember?.role === 'owner' || currentUser?.is_admin === true;

  const inboxQueryKey = trpc.wasteland.listInboxItems.queryKey({ wastelandId });
  const inboxQuery = useQuery({
    ...trpc.wasteland.listInboxItems.queryOptions({ wastelandId }),
    enabled: isOwner && isUpstreamAdmin,
    refetchInterval: 30_000,
  });

  const [filter, setFilter] = useState<Filter>('all');
  const [commentOnItem, setCommentOnItem] = useState<InboxItem | null>(null);

  const items = inboxQuery.data?.items ?? [];
  const filtered = useMemo(
    () => (filter === 'all' ? items : items.filter(i => i.kind === filter)),
    [items, filter]
  );

  const counts = useMemo(() => countByKind(items), [items]);
  const upstream = wastelandQuery.data?.dolthub_upstream ?? null;

  const refetch = () => {
    void queryClient.invalidateQueries({ queryKey: inboxQueryKey });
  };

  // Post-merge, DoltHub merges asynchronously — schedule a few refetches
  // over ~30s so the row drops out of the inbox without manual refresh.
  // Track timers in a ref so we can clear them on unmount (tab closed mid
  // merge) and avoid lingering callbacks.
  const pendingTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(
    () => () => {
      for (const id of pendingTimers.current) clearTimeout(id);
      pendingTimers.current = [];
    },
    []
  );

  const mergeMutation = useMutation({
    ...trpc.wasteland.mergeUpstreamPR.mutationOptions(),
    onSuccess: () => {
      toast.success('Merge initiated');
      const refetchAt = [2_000, 5_000, 15_000, 30_000];
      for (const ms of refetchAt) {
        pendingTimers.current.push(setTimeout(refetch, ms));
      }
    },
    onError: err => toast.error(`Merge failed: ${err.message}`),
  });

  const closeMutation = useMutation({
    ...trpc.wasteland.closeUpstreamPR.mutationOptions(),
    onSuccess: () => {
      toast.success('PR closed');
      refetch();
    },
    onError: err => toast.error(`Close failed: ${err.message}`),
  });

  // Contribute the Review page section to the wasteland navbar on every
  // render path. Count is null until the inbox is loaded; the Admin-view
  // pill always renders for owners who have admin mode on.
  useSetWastelandPageHeader({
    title: 'Review',
    icon: <Inbox className="size-4 text-[color:oklch(70%_0.15_30_/_0.6)]" />,
    count: isOwner && isUpstreamAdmin && inboxQuery.data ? items.length : null,
    actions: isUpstreamAdmin ? (
      <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-300">
        <ShieldCheck className="size-3" />
        Admin view
      </span>
    ) : null,
  });

  // ── Loading / permission-gated states ────────────────────────────
  if (wastelandQuery.isLoading || credentialQuery.isLoading || membersQuery.isLoading) {
    return <ReviewShell>{<CardSkeleton />}</ReviewShell>;
  }

  if (!isOwner) {
    return (
      <ReviewShell>
        <AccessDenied
          title="Owner access required"
          description="Only wasteland owners can see the review inbox. Ask an owner if you need access."
        />
      </ReviewShell>
    );
  }

  if (!isUpstreamAdmin) {
    return (
      <ReviewShell>
        <AccessDenied
          title="Admin mode required"
          description="Enable 'I own this upstream (admin mode)' in settings to load the review inbox. Only a DoltHub token with push access can list and merge upstream PRs."
        />
      </ReviewShell>
    );
  }

  return (
    <ReviewShell>
      {/* Filter chips */}
      <div className="flex flex-wrap gap-1.5">
        {(Object.keys(FILTER_LABELS) as Filter[]).map(key => {
          const count = key === 'all' ? items.length : (counts[key] ?? 0);
          if (key !== 'all' && count === 0) return null;
          const active = filter === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors ${
                active
                  ? 'border-violet-500/30 bg-violet-500/10 text-violet-300'
                  : 'border-white/[0.08] bg-white/[0.02] text-white/50 hover:bg-white/[0.05]'
              }`}
            >
              {FILTER_LABELS[key]}
              <span
                className={`rounded px-1 font-mono text-[10px] ${
                  active ? 'text-violet-300/70' : 'text-white/30'
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Content */}
      {inboxQuery.isLoading ? (
        <CardSkeleton />
      ) : inboxQuery.isError ? (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
          <p className="text-sm text-red-400">Failed to load inbox</p>
          <p className="mt-1 font-mono text-[11px] text-white/40">{inboxQuery.error.message}</p>
        </div>
      ) : items.length === 0 ? (
        <EmptyInbox />
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-6 py-12 text-center">
          <p className="text-sm text-white/40">No items match this filter.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(item => (
            <InboxCard
              key={item.pull_id}
              item={item}
              upstream={upstream}
              busy={mergeMutation.isPending || closeMutation.isPending}
              onMerge={() => mergeMutation.mutate({ wastelandId, pullId: item.pull_id })}
              onClose={() => closeMutation.mutate({ wastelandId, pullId: item.pull_id })}
              onComment={() => setCommentOnItem(item)}
            />
          ))}
        </div>
      )}

      <CommentDialog
        wastelandId={wastelandId}
        item={commentOnItem}
        onClose={() => setCommentOnItem(null)}
      />
    </ReviewShell>
  );
}

// ── Shell ───────────────────────────────────────────────────────────────
// Body-only wrapper; the title/count/Admin-pill live in the wasteland
// navbar via `useSetWastelandPageHeader`.

function ReviewShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-4 p-6">{children}</div>
      </div>
    </div>
  );
}

function EmptyInbox() {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-6 py-16 text-center">
      <CheckCircle2 className="mx-auto mb-3 size-8 text-emerald-500/40" />
      <p className="text-sm text-white/70">Inbox zero</p>
      <p className="mt-1 text-xs text-white/40">No open pull requests on the upstream.</p>
    </div>
  );
}

function AccessDenied({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-6 py-12 text-center">
      <ShieldCheck className="mx-auto mb-3 size-8 text-white/15" />
      <p className="text-sm text-white/70">{title}</p>
      <p className="mt-1 text-xs text-white/40">{description}</p>
    </div>
  );
}

function CardSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-28 w-full rounded-xl" />
      <Skeleton className="h-28 w-full rounded-xl" />
      <Skeleton className="h-28 w-full rounded-xl" />
    </div>
  );
}

// ── Cards ───────────────────────────────────────────────────────────────

function InboxCard({
  item,
  upstream,
  busy,
  onMerge,
  onClose,
  onComment,
}: {
  item: InboxItem;
  upstream: string | null;
  busy: boolean;
  onMerge: () => void;
  onClose: () => void;
  onComment: () => void;
}) {
  const accent = accentFor(item.kind);

  return (
    <article
      className={`relative overflow-hidden rounded-xl border bg-[color:oklch(0.15_0_0)] ${accent.border}`}
    >
      <div className={`absolute inset-y-0 left-0 w-1 ${accent.bar}`} />
      <div className="pl-4">
        {/* Header strip */}
        <div className="flex items-start justify-between gap-3 border-b border-white/[0.04] px-4 py-2.5">
          <div className="flex items-center gap-2">
            <accent.Icon className={`size-4 ${accent.icon}`} />
            <span className={`text-xs font-medium ${accent.label}`}>{cardHeading(item)}</span>
            <Badge
              variant="outline"
              className="border-white/[0.08] font-mono text-[10px] text-white/50"
            >
              #{item.pull_id}
            </Badge>
          </div>
          <div className="flex items-center gap-3 text-[10px] text-white/30">
            {item.submitter && (
              <span>
                by <span className="font-mono text-white/50">{item.submitter}</span>
              </span>
            )}
            {item.updated_at && <span>{formatRelative(item.updated_at)}</span>}
          </div>
        </div>

        {/* Body — per-kind content */}
        <div className="px-4 py-3">
          <CardBody item={item} />
        </div>

        {/* Action strip */}
        <div className="flex flex-wrap items-center justify-end gap-1.5 border-t border-white/[0.04] px-4 py-2.5">
          {upstream && (
            <a
              href={`https://www.dolthub.com/repositories/${upstream}/pulls/${item.pull_id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[11px] text-white/60 transition-colors hover:bg-white/[0.06]"
            >
              <ExternalLink className="size-3" />
              DoltHub
            </a>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 border-white/[0.08] px-2 text-[11px] text-white/60 hover:bg-white/[0.06]"
            onClick={onComment}
          >
            <MessageSquare className="size-3" />
            Comment
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 border-red-500/20 px-2 text-[11px] text-red-400 hover:bg-red-500/10"
            disabled={busy}
            onClick={onClose}
          >
            <XCircle className="size-3" />
            Close
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 border-emerald-500/20 px-2 text-[11px] text-emerald-400 hover:bg-emerald-500/10"
            disabled={busy}
            onClick={onMerge}
          >
            <GitMerge className="size-3" />
            Merge
          </Button>
        </div>
      </div>
    </article>
  );
}

function CardBody({ item }: { item: InboxItem }) {
  switch (item.kind) {
    case 'rig-registration':
      return <RigRegistrationBody item={item} />;
    case 'wanted-post':
      return <WantedPostBody item={item} />;
    case 'wanted-edit':
      return <WantedEditBody item={item} />;
    case 'work-submission':
      return <WorkSubmissionBody item={item} />;
    case 'admin-action':
      return <AdminActionBody item={item} />;
    case 'unknown':
      return <UnknownBody item={item} />;
  }
}

// ─── Rig registration ────

function RigRegistrationBody({ item }: { item: Extract<InboxItem, { kind: 'rig-registration' }> }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 ring-1 ring-emerald-500/20">
          <UserPlus className="size-4 text-emerald-400" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm text-white/85">{item.handle}</p>
          {item.display_name && <p className="text-xs text-white/50">{item.display_name}</p>}
        </div>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-[11px]">
        {item.owner_email && (
          <MetaRow label="Owner">
            <span className="font-mono">{item.owner_email}</span>
          </MetaRow>
        )}
        {item.dolthub_org && (
          <MetaRow label="DoltHub org">
            <span className="font-mono">{item.dolthub_org}</span>
          </MetaRow>
        )}
        {item.hop_uri && (
          <MetaRow label="Hop URI">
            <span className="font-mono break-all">{item.hop_uri}</span>
          </MetaRow>
        )}
        {item.gt_version && (
          <MetaRow label="wl version">
            <span className="font-mono">{item.gt_version}</span>
          </MetaRow>
        )}
      </dl>
      <ScrutinyHint text="Verify the handle matches the DoltHub org (spam/sybil risk). New rigs land with trust_level=1." />
    </div>
  );
}

// ─── Wanted post ────

function WantedPostBody({ item }: { item: Extract<InboxItem, { kind: 'wanted-post' }> }) {
  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium text-white/85">{item.item_title}</p>
        <p className="mt-0.5 font-mono text-[10px] text-white/30">{item.item_id}</p>
      </div>
      {item.description && (
        <p className="line-clamp-3 text-xs whitespace-pre-wrap text-white/55">{item.description}</p>
      )}
      <div className="flex flex-wrap gap-1.5 text-[10px]">
        {item.type && <TagPill>{`type: ${item.type}`}</TagPill>}
        {item.priority && <TagPill>{`priority: ${item.priority}`}</TagPill>}
        {item.effort_level && <TagPill>{`effort: ${item.effort_level}`}</TagPill>}
        {item.posted_by && <TagPill>{`by: ${item.posted_by}`}</TagPill>}
      </div>
      {item.tags && <p className="font-mono text-[10px] text-white/35">tags: {item.tags}</p>}
    </div>
  );
}

// ─── Wanted edit ────

const EDIT_SUBKIND_LABEL: Record<'update' | 'delete' | 'unclaim', string> = {
  update: 'Update',
  delete: 'Withdraw',
  unclaim: 'Unclaim',
};

function WantedEditBody({ item }: { item: Extract<InboxItem, { kind: 'wanted-edit' }> }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="rounded border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
          {EDIT_SUBKIND_LABEL[item.subkind]}
        </span>
        <p className="truncate text-sm text-white/80">{item.item_title}</p>
        <span className="font-mono text-[10px] text-white/30">{item.item_id}</span>
      </div>
      {item.status_transition && (
        <p className="font-mono text-[11px] text-white/50">{item.status_transition}</p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-[11px]">
        {item.posted_by && (
          <MetaRow label="Posted by">
            <span className="font-mono">{item.posted_by}</span>
          </MetaRow>
        )}
        {item.submitter_is_poster !== null && (
          <MetaRow label="Submitter">
            {item.submitter_is_poster ? (
              <span className="text-emerald-400">is the original poster ✓</span>
            ) : (
              <span className="text-amber-400">
                is <em>not</em> the original poster ⚠
              </span>
            )}
          </MetaRow>
        )}
      </dl>
      {item.submitter_is_poster === false && (
        <ScrutinyHint text="Edit submitted by someone other than the original poster. Verify they should be able to modify this item." />
      )}
    </div>
  );
}

// ─── Work submission ────

function WorkSubmissionBody({ item }: { item: Extract<InboxItem, { kind: 'work-submission' }> }) {
  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium text-white/85">{item.item_title}</p>
        <p className="mt-0.5 font-mono text-[10px] text-white/30">{item.item_id}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="inline-flex items-center gap-1 rounded border border-violet-500/20 bg-violet-500/10 px-1.5 py-0.5 text-violet-300">
          <Hand className="size-3" />
          Claimed
        </span>
        {item.has_done ? (
          <span className="inline-flex items-center gap-1 rounded border border-sky-500/20 bg-sky-500/10 px-1.5 py-0.5 text-sky-300">
            <CheckCircle2 className="size-3" />
            Evidence submitted
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-white/50">
            Claim only — waiting on evidence
          </span>
        )}
        <span className="text-white/40">
          by <span className="font-mono text-white/70">{item.claimer}</span>
        </span>
      </div>
      {item.evidence_url && (
        <div className="rounded-md border border-white/[0.06] bg-white/[0.02] p-2">
          <p className="mb-1 text-[10px] font-medium tracking-wide text-white/40 uppercase">
            Evidence
          </p>
          <a
            href={item.evidence_url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-[11px] text-sky-400 hover:text-sky-300 break-all"
          >
            {item.evidence_url}
          </a>
        </div>
      )}
      {item.completion_id && (
        <p className="font-mono text-[10px] text-white/25">completion {item.completion_id}</p>
      )}
    </div>
  );
}

// ─── Admin action ────

const ADMIN_SUBKIND_LABEL: Record<
  'accept' | 'accept-upstream' | 'reject' | 'close' | 'close-upstream',
  { label: string; icon: typeof ThumbsUp; tone: 'emerald' | 'red' | 'white' }
> = {
  accept: { label: 'Accept + stamp', icon: ThumbsUp, tone: 'emerald' },
  'accept-upstream': { label: 'Accept upstream + stamp', icon: ThumbsUp, tone: 'emerald' },
  reject: { label: 'Reject', icon: ThumbsDown, tone: 'red' },
  close: { label: 'Close (no stamp)', icon: XCircle, tone: 'white' },
  'close-upstream': { label: 'Close upstream (no stamp)', icon: XCircle, tone: 'white' },
};

function AdminActionBody({ item }: { item: Extract<InboxItem, { kind: 'admin-action' }> }) {
  const { label, tone } = ADMIN_SUBKIND_LABEL[item.subkind];
  const toneClass =
    tone === 'emerald'
      ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300'
      : tone === 'red'
        ? 'border-red-500/20 bg-red-500/10 text-red-300'
        : 'border-white/[0.08] bg-white/[0.03] text-white/70';

  const selfStamp = item.stamp && item.worker && item.acceptor && item.worker === item.acceptor;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${toneClass}`}>
          {label}
        </span>
        <p className="truncate text-sm text-white/80">{item.item_title}</p>
        <span className="font-mono text-[10px] text-white/30">{item.item_id}</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-[11px]">
        {item.worker && (
          <MetaRow label="Worker">
            <span className="font-mono">{item.worker}</span>
          </MetaRow>
        )}
        {item.acceptor && (
          <MetaRow label="Actor">
            <span className="font-mono">{item.acceptor}</span>
          </MetaRow>
        )}
      </dl>
      {item.reject_reason && (
        <div className="rounded-md border border-red-500/10 bg-red-500/5 p-2">
          <p className="mb-1 text-[10px] font-medium tracking-wide text-red-400/70 uppercase">
            Rejection reason
          </p>
          <p className="text-xs text-white/70">{item.reject_reason}</p>
        </div>
      )}
      {item.stamp && (
        <div className="space-y-1 rounded-md border border-emerald-500/10 bg-emerald-500/5 p-2">
          <div className="flex items-center gap-2">
            <Star className="size-3 text-emerald-400" />
            <p className="text-[10px] font-medium tracking-wide text-emerald-400/80 uppercase">
              Stamp
            </p>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-[11px]">
            {item.stamp.quality && (
              <MetaRow label="Quality">
                <span>{item.stamp.quality}</span>
              </MetaRow>
            )}
            {item.stamp.severity && (
              <MetaRow label="Severity">
                <span>{item.stamp.severity}</span>
              </MetaRow>
            )}
            {item.stamp.skill_tags && (
              <MetaRow label="Skills">
                <span className="font-mono">{item.stamp.skill_tags}</span>
              </MetaRow>
            )}
            {item.stamp.message && (
              <MetaRow label="Message">
                <span>{item.stamp.message}</span>
              </MetaRow>
            )}
          </dl>
        </div>
      )}
      {selfStamp && (
        <ScrutinyHint
          tone="red"
          text="Author and subject of this stamp are the same rig. wl rejects self-stamps at the CLI, so this PR was likely hand-crafted — do not merge without understanding who authored it."
        />
      )}
      {item.subkind === 'reject' && !item.reject_reason && (
        <ScrutinyHint
          tone="red"
          text="Rejection has no reason — the contributor will see an empty reject commit. Consider asking the actor to resubmit with --reason."
        />
      )}
    </div>
  );
}

// ─── Unknown ────

function UnknownBody({ item }: { item: Extract<InboxItem, { kind: 'unknown' }> }) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-white/80">{item.title}</p>
      {item.commit_subjects.length > 0 && (
        <div className="rounded-md border border-white/[0.06] bg-white/[0.02] p-2">
          <p className="mb-1 text-[10px] font-medium tracking-wide text-white/40 uppercase">
            Commits
          </p>
          <ul className="space-y-0.5 font-mono text-[11px] text-white/60">
            {item.commit_subjects.map((subject, idx) => (
              <li key={idx} className="truncate">
                {subject}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ScrutinyHint text="This PR wasn't produced by the wl CLI. Inspect it on DoltHub before merging — there's no typed context to compare against." />
    </div>
  );
}

// ── Comment dialog ──────────────────────────────────────────────────────

function CommentDialog({
  wastelandId,
  item,
  onClose,
}: {
  wastelandId: string;
  item: InboxItem | null;
  onClose: () => void;
}) {
  const trpc = useWastelandTRPC();
  const [comment, setComment] = useState('');

  const commentMutation = useMutation({
    ...trpc.wasteland.commentOnUpstreamPR.mutationOptions(),
    onSuccess: () => {
      toast.success('Comment posted to DoltHub');
      setComment('');
      onClose();
    },
    onError: err => toast.error(`Comment failed: ${err.message}`),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!item || !comment.trim()) return;
    commentMutation.mutate({
      wastelandId,
      pullId: item.pull_id,
      comment: comment.trim(),
    });
  };

  const handleClose = () => {
    setComment('');
    onClose();
  };

  return (
    <Dialog
      open={item !== null}
      onOpenChange={open => {
        if (!open) handleClose();
      }}
    >
      <DialogContent className="border-white/10 bg-[color:oklch(0.155_0_0)]">
        <DialogHeader>
          <DialogTitle className="text-white/90">Comment on PR</DialogTitle>
          <DialogDescription className="text-white/50">
            Posts a comment to DoltHub on this pull request. The contributor will see it in the PR's
            comment thread.
          </DialogDescription>
        </DialogHeader>

        {item && (
          <div className="rounded-md border border-white/[0.08] bg-white/[0.03] p-3">
            <p className="truncate text-sm font-medium text-white/80">{item.title}</p>
            <p className="mt-0.5 font-mono text-[10px] text-white/30">PR #{item.pull_id}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <textarea
            required
            rows={5}
            value={comment}
            onChange={e => setComment(e.target.value)}
            placeholder="Write your comment..."
            className="w-full resize-none rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-white/80 outline-none placeholder:text-white/25 focus:border-white/20"
          />

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
              disabled={commentMutation.isPending}
              className="border-white/[0.08] bg-white/[0.03] text-white/60 hover:bg-white/[0.06]"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={commentMutation.isPending || !comment.trim()}
              className="gap-1.5 bg-violet-600 text-white hover:bg-violet-500"
            >
              {commentMutation.isPending && <Loader2 className="size-3.5 animate-spin" />}
              Post comment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Small helpers ───────────────────────────────────────────────────────

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-white/30">{label}</dt>
      <dd className="truncate text-white/70">{children}</dd>
    </>
  );
}

function TagPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-white/55">
      {children}
    </span>
  );
}

function ScrutinyHint({ text, tone = 'amber' }: { text: string; tone?: 'amber' | 'red' }) {
  const toneClass =
    tone === 'red'
      ? 'border-red-500/20 bg-red-500/5 text-red-300/80'
      : 'border-amber-500/20 bg-amber-500/5 text-amber-200/80';
  return (
    <div className={`flex items-start gap-2 rounded-md border px-2 py-1.5 ${toneClass}`}>
      <AlertTriangle className="mt-0.5 size-3 shrink-0" />
      <p className="text-[11px] leading-snug">{text}</p>
    </div>
  );
}

function accentFor(kind: InboxItem['kind']): {
  Icon: typeof Inbox;
  icon: string;
  label: string;
  border: string;
  bar: string;
} {
  switch (kind) {
    case 'rig-registration':
      return {
        Icon: UserPlus,
        icon: 'text-emerald-400',
        label: 'text-emerald-300',
        border: 'border-emerald-500/15',
        bar: 'bg-emerald-500/50',
      };
    case 'wanted-post':
      return {
        Icon: ScrollText,
        icon: 'text-sky-400',
        label: 'text-sky-300',
        border: 'border-sky-500/15',
        bar: 'bg-sky-500/50',
      };
    case 'wanted-edit':
      return {
        Icon: Pencil,
        icon: 'text-amber-400',
        label: 'text-amber-300',
        border: 'border-amber-500/15',
        bar: 'bg-amber-500/50',
      };
    case 'work-submission':
      return {
        Icon: Hand,
        icon: 'text-violet-400',
        label: 'text-violet-300',
        border: 'border-violet-500/15',
        bar: 'bg-violet-500/50',
      };
    case 'admin-action':
      return {
        Icon: ShieldCheck,
        icon: 'text-indigo-400',
        label: 'text-indigo-300',
        border: 'border-indigo-500/15',
        bar: 'bg-indigo-500/50',
      };
    case 'unknown':
      return {
        Icon: HelpCircle,
        icon: 'text-white/40',
        label: 'text-white/50',
        border: 'border-white/[0.08]',
        bar: 'bg-white/20',
      };
  }
}

function cardHeading(item: InboxItem): string {
  switch (item.kind) {
    case 'rig-registration':
      return 'Rig registration';
    case 'wanted-post':
      return 'New wanted post';
    case 'wanted-edit':
      return `Wanted edit — ${item.subkind}`;
    case 'work-submission':
      return item.has_done ? 'Work submitted' : 'Claim';
    case 'admin-action':
      return `Admin — ${item.subkind}`;
    case 'unknown':
      return 'Foreign PR';
  }
}

function countByKind(items: InboxItem[]): Partial<Record<InboxItem['kind'], number>> {
  const counts: Partial<Record<InboxItem['kind'], number>> = {};
  for (const item of items) {
    counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  }
  return counts;
}

function formatRelative(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}
