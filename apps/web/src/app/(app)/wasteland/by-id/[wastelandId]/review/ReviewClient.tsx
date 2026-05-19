'use client';

/**
 * Review inbox — typed list of open upstream pull requests.
 *
 * Layout mirrors the Wanted Board: dense one-line list on the left,
 * slide-over detail panel on the right, search + kind filter + sort
 * toolbar at the top. Each PR is classified server-side into one of
 * five kinds (plus `unknown` for foreign PRs) and rendered with kind-
 * specific metadata both in the row and in the drawer body.
 *
 * Gating: only wasteland owners with admin mode enabled can load this
 * page. Contributors (no credential, or credential without
 * `is_upstream_admin`) get a permission-denied notice.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useWastelandTRPC } from '@/lib/wasteland/trpc';
import type { WastelandOutputs } from '@/lib/wasteland/trpc';
import { useUser } from '@/hooks/useUser';
import { useSetWastelandPageHeader } from '../WastelandPageHeaderContext';
import { useDrawerStack } from '@/components/wasteland/drawer/WastelandDrawerStack';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
  ArrowUpDown,
  CheckCircle2,
  ExternalLink,
  Inbox,
  Loader2,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { formatDistanceToNow } from 'date-fns';

type InboxItem = WastelandOutputs['wasteland']['listInboxItems']['items'][number];
type InboxKind = InboxItem['kind'];
type SortField = 'activity' | 'kind';

const KIND_LABEL: Record<InboxKind, string> = {
  'rig-registration': 'Registration',
  'wanted-post': 'New post',
  'wanted-edit': 'Edit',
  'work-submission': 'Submission',
  'admin-action': 'Admin action',
  unknown: 'Foreign',
};

// Short-form label used in the row's trailing kind chip.
const KIND_SHORT: Record<InboxKind, string> = {
  'rig-registration': 'rig',
  'wanted-post': 'post',
  'wanted-edit': 'edit',
  'work-submission': 'submission',
  'admin-action': 'admin',
  unknown: 'foreign',
};

const KIND_DOT: Record<InboxKind, string> = {
  'rig-registration': 'bg-emerald-400',
  'wanted-post': 'bg-sky-400',
  'wanted-edit': 'bg-amber-400',
  'work-submission': 'bg-violet-400',
  'admin-action': 'bg-indigo-400',
  unknown: 'bg-white/20',
};

const KIND_CHIP: Record<InboxKind, string> = {
  'rig-registration': 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  'wanted-post': 'bg-sky-500/10 text-sky-400 border-sky-500/20',
  'wanted-edit': 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  'work-submission': 'bg-violet-500/10 text-violet-400 border-violet-500/20',
  'admin-action': 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20',
  unknown: 'bg-white/[0.04] text-white/40 border-white/10',
};

// Stable order for filter chips (matches the taxonomy docs).
const KIND_ORDER: InboxKind[] = [
  'rig-registration',
  'wanted-post',
  'wanted-edit',
  'work-submission',
  'admin-action',
  'unknown',
];

export function ReviewClient({ wastelandId }: { wastelandId: string }) {
  const trpc = useWastelandTRPC();
  const queryClient = useQueryClient();
  const { data: currentUser } = useUser();
  const { open: openDrawer, closeAll: closeDrawer } = useDrawerStack();

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

  // ── Filter / sort state ──────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<InboxKind | null>(null);
  const [sortField, setSortField] = useState<SortField>('activity');
  const [commentOnItem, setCommentOnItem] = useState<InboxItem | null>(null);

  const items = useMemo(() => inboxQuery.data?.items ?? [], [inboxQuery.data]);

  const counts = useMemo(() => countByKind(items), [items]);

  const filteredItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = items.filter(item => {
      if (kindFilter && item.kind !== kindFilter) return false;
      if (!query) return true;
      return itemSearchHaystack(item).includes(query);
    });
    return filtered.sort((a, b) => {
      if (sortField === 'kind') {
        const ak = KIND_ORDER.indexOf(a.kind);
        const bk = KIND_ORDER.indexOf(b.kind);
        if (ak !== bk) return ak - bk;
      }
      // Fall back to activity (newest first).
      return timestampMs(b.updated_at) - timestampMs(a.updated_at);
    });
  }, [items, search, kindFilter, sortField]);

  // ── Mutations ─────────────────────────────────────────────────────
  const refetch = () => {
    void queryClient.invalidateQueries({ queryKey: inboxQueryKey });
  };

  // DoltHub merges async. Schedule 4 invalidations over ~30s so the row
  // disappears as soon as the merge lands server-side without requiring
  // a manual refresh. Timers are tracked in a ref so they can be
  // cancelled on unmount.
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
      closeDrawer();
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
      closeDrawer();
      refetch();
    },
    onError: err => toast.error(`Close failed: ${err.message}`),
  });

  const acceptMutation = useMutation({
    ...trpc.wasteland.acceptWantedItem.mutationOptions(),
    onSuccess: result => {
      const description = result.merged
        ? result.closed_submitter_pr
          ? "Stamp issued, adoption PR merged, worker's PR closed."
          : 'Stamp issued and adoption PR merged. Close the original PR manually.'
        : 'Stamp issued. The adoption PR is open on DoltHub — merge it to land the work.';
      toast.success(result.merged ? 'Submission accepted' : 'Adoption PR opened', {
        description,
        action: result.pr_url
          ? {
              label: 'Open',
              onClick: () => window.open(result.pr_url ?? '', '_blank', 'noopener,noreferrer'),
            }
          : undefined,
      });
      closeDrawer();
      const refetchAt = [2_000, 5_000, 15_000, 30_000];
      for (const ms of refetchAt) {
        pendingTimers.current.push(setTimeout(refetch, ms));
      }
    },
    onError: err => toast.error(err.message || 'Accept failed'),
  });

  const busy = mergeMutation.isPending || closeMutation.isPending || acceptMutation.isPending;

  // ── Page header contribution ──────────────────────────────────────
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

  // ── Permission / loading states ───────────────────────────────────
  if (wastelandQuery.isLoading || credentialQuery.isLoading || membersQuery.isLoading) {
    return <ReviewShell>{<InboxListSkeleton />}</ReviewShell>;
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

  const upstream = wastelandQuery.data?.dolthub_upstream ?? null;

  const handleOpenItem = (item: InboxItem) => {
    openDrawer({
      type: 'review-item',
      wastelandId,
      item,
      actions: {
        upstream,
        busy,
        onMerge: pr => mergeMutation.mutate({ wastelandId, pullId: pr.pull_id }),
        onCloseAction: pr => closeMutation.mutate({ wastelandId, pullId: pr.pull_id }),
        onComment: pr => setCommentOnItem(pr),
        onAccept: (pr, input) => {
          if (pr.kind !== 'work-submission') return;
          acceptMutation.mutate({
            wastelandId,
            itemId: pr.item_id,
            submitterPullId: pr.pull_id,
            submitterRigHandle: pr.submitter ?? undefined,
            submitterForkOwner: pr.fork_owner ?? undefined,
            completionId: pr.completion_id ?? undefined,
            evidence: pr.evidence_url ?? undefined,
            quality: input.quality,
            reliability: input.reliability,
            severity: input.severity,
            skillTags: input.skillTags,
            message: input.message,
          });
        },
      },
    });
  };

  const dolthubPullUrl = (item: InboxItem) =>
    upstream ? buildDolthubPullUrl(upstream, item.pull_id) : null;

  return (
    <div className="flex h-full">
      {/* Main list */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-3 border-b border-white/[0.06] px-6 py-2">
          {/* Search */}
          <div className="flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5">
            <Search className="size-3 text-white/30" />
            <input
              type="text"
              placeholder="Search PRs, items, rigs..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-56 bg-transparent text-xs text-white/80 outline-none placeholder:text-white/25"
            />
          </div>

          {/* Kind filter chips */}
          <div className="flex items-center gap-1">
            <FilterChip
              label="All"
              count={items.length}
              active={kindFilter === null}
              onClick={() => setKindFilter(null)}
            />
            {KIND_ORDER.map(kind => {
              const count = counts[kind] ?? 0;
              if (count === 0) return null;
              return (
                <FilterChip
                  key={kind}
                  label={KIND_LABEL[kind]}
                  count={count}
                  active={kindFilter === kind}
                  onClick={() => setKindFilter(kindFilter === kind ? null : kind)}
                  dotColor={KIND_DOT[kind]}
                />
              );
            })}
          </div>

          {/* Sort toggle */}
          <button
            type="button"
            onClick={() => setSortField(s => (s === 'activity' ? 'kind' : 'activity'))}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-white/30 transition-colors hover:bg-white/[0.04] hover:text-white/50"
          >
            <ArrowUpDown className="size-3" />
            {sortField === 'activity' ? 'Last activity' : 'Kind'}
          </button>
        </div>

        {/* Item list */}
        <div className="flex-1 overflow-y-auto">
          {inboxQuery.isLoading && <InboxListSkeleton />}

          {inboxQuery.isError && !inboxQuery.isLoading && (
            <div className="mx-6 mt-6 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
              <p className="text-sm text-red-400">Failed to load inbox</p>
              <p className="mt-1 font-mono text-[11px] text-white/40">{inboxQuery.error.message}</p>
            </div>
          )}

          {!inboxQuery.isLoading && !inboxQuery.isError && items.length === 0 && <EmptyInbox />}

          {!inboxQuery.isLoading &&
            !inboxQuery.isError &&
            items.length > 0 &&
            filteredItems.length === 0 && (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <Inbox className="mb-3 size-8 text-white/10" />
                <p className="text-sm text-white/30">No inbox items match your filters.</p>
              </div>
            )}

          <AnimatePresence mode="popLayout">
            {filteredItems.map((item, i) => (
              <motion.div
                key={item.pull_id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ delay: Math.min(i * 0.02, 0.3), duration: 0.15 }}
                onClick={() => handleOpenItem(item)}
                className="group flex cursor-pointer items-center gap-3 border-b border-white/[0.04] px-6 py-2.5 transition-colors hover:bg-white/[0.02]"
              >
                <span className={`size-2 shrink-0 rounded-full ${KIND_DOT[item.kind]}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm text-white/80">{rowTitle(item)}</span>
                    <Badge variant="outline" className={`text-[9px] ${KIND_CHIP[item.kind]}`}>
                      {KIND_SHORT[item.kind]}
                    </Badge>
                    <span className="font-mono text-[10px] text-white/30">#{item.pull_id}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10px] text-white/30">
                    <span className="line-clamp-1 max-w-xs">{rowSubtitle(item)}</span>
                    {item.submitter && (
                      <>
                        <span className="text-white/15">|</span>
                        <span className="font-mono">{item.submitter}</span>
                      </>
                    )}
                    {item.updated_at && (
                      <>
                        <span className="text-white/15">|</span>
                        <span>{formatRelative(item.updated_at)}</span>
                      </>
                    )}
                  </div>
                </div>
                <span className="shrink-0 text-[10px] font-medium text-white/40">
                  {rowAccent(item)}
                </span>
                {dolthubPullUrl(item) && (
                  <a
                    href={dolthubPullUrl(item) ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    onClick={e => e.stopPropagation()}
                    className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[10px] font-medium text-white/35 transition-colors hover:bg-white/[0.04] hover:text-white/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/20"
                  >
                    Open on DoltHub
                    <ExternalLink className="size-3" />
                  </a>
                )}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>

      <CommentDialog
        wastelandId={wastelandId}
        item={commentOnItem}
        onClose={() => setCommentOnItem(null)}
      />
    </div>
  );
}

// ── Shell (used for loading / access-denied states) ─────────────────────

function ReviewShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

function InboxListSkeleton() {
  return (
    <div className="space-y-0">
      {Array.from({ length: 10 }).map((_, i) => (
        <div
          key={i}
          className="flex animate-pulse items-center gap-3 border-b border-white/[0.04] px-6 py-3"
        >
          <div className="size-2 rounded-full bg-white/10" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-64 rounded bg-white/5" />
            <div className="h-2 w-40 rounded bg-white/[0.03]" />
          </div>
          <div className="h-3 w-10 rounded bg-white/5" />
        </div>
      ))}
    </div>
  );
}

function EmptyInbox() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <CheckCircle2 className="mb-3 size-8 text-emerald-500/40" />
      <p className="text-sm text-white/70">Inbox zero</p>
      <p className="mt-1 text-xs text-white/40">No open pull requests on the upstream.</p>
    </div>
  );
}

function AccessDenied({ title, description }: { title: string; description: string }) {
  return (
    <div className="mx-auto max-w-md px-6 py-16 text-center">
      <ShieldCheck className="mx-auto mb-3 size-8 text-white/15" />
      <p className="text-sm text-white/70">{title}</p>
      <p className="mt-1 text-xs text-white/40">{description}</p>
    </div>
  );
}

// ── Filter chip ──────────────────────────────────────────────────────────

function FilterChip({
  label,
  count,
  active,
  onClick,
  dotColor,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  dotColor?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-medium capitalize transition-colors ${
        active
          ? 'bg-white/[0.08] text-white/70'
          : 'text-white/30 hover:bg-white/[0.04] hover:text-white/50'
      }`}
    >
      {dotColor && <span className={`size-1.5 rounded-full ${dotColor}`} />}
      {label}
      <span className="font-mono text-[9px] opacity-60">{count}</span>
    </button>
  );
}

// ── Row-title label maps ────────────────────────────────────────────────
//
// These two const maps are also defined inside ReviewItemPanel.tsx for use
// by the drawer body. They're duplicated here intentionally because the
// row-title formatters (`rowTitle`, `rowAccent`) need them too, and
// importing from a sibling panel component would couple the row rendering
// to the drawer-internal structure.

const EDIT_SUBKIND_LABEL: Record<'update' | 'delete' | 'unclaim', string> = {
  update: 'Update',
  delete: 'Withdraw',
  unclaim: 'Unclaim',
};

const ADMIN_SUBKIND_LABEL: Record<
  'accept' | 'accept-upstream' | 'reject' | 'close' | 'close-upstream',
  { label: string; tone: 'emerald' | 'red' | 'white' }
> = {
  accept: { label: 'Accept + stamp', tone: 'emerald' },
  'accept-upstream': { label: 'Accept upstream + stamp', tone: 'emerald' },
  reject: { label: 'Reject', tone: 'red' },
  close: { label: 'Close (no stamp)', tone: 'white' },
  'close-upstream': { label: 'Close upstream (no stamp)', tone: 'white' },
};

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

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Title shown as the bold first line of each list row. Different per
 * kind so the row communicates the PR's purpose at a glance without
 * requiring the reviewer to parse the tiny metadata line.
 */
function rowTitle(item: InboxItem): string {
  switch (item.kind) {
    case 'rig-registration':
      return `Register rig ${item.handle}`;
    case 'wanted-post':
      return item.item_title;
    case 'wanted-edit':
      return `${EDIT_SUBKIND_LABEL[item.subkind]}: ${item.item_title}`;
    case 'work-submission':
      return item.has_done ? `Evidence: ${item.item_title}` : `Claim: ${item.item_title}`;
    case 'admin-action':
      return `${ADMIN_SUBKIND_LABEL[item.subkind].label}: ${item.item_title}`;
    case 'unknown':
      return item.title;
  }
}

/**
 * Secondary subtitle shown beneath `rowTitle`. Kept short — the details
 * live in the drawer. Returns a plain string so it can be truncated
 * with `line-clamp-1`.
 */
function rowSubtitle(item: InboxItem): string {
  switch (item.kind) {
    case 'rig-registration':
      return item.display_name ?? item.owner_email ?? '';
    case 'wanted-post':
      return item.description ?? '';
    case 'wanted-edit':
      return item.status_transition ?? (item.posted_by ? `posted by ${item.posted_by}` : '');
    case 'work-submission':
      return item.evidence_url ? item.evidence_url : `claimed by ${item.claimer}`;
    case 'admin-action':
      if (item.stamp?.message) return item.stamp.message;
      if (item.reject_reason) return item.reject_reason;
      return item.worker ? `worker: ${item.worker}` : '';
    case 'unknown':
      return item.commit_subjects[0] ?? '';
  }
}

/**
 * Trailing badge text on each row (rightmost column). Used to surface a
 * one-word signal about severity/importance without requiring reading
 * the subtitle. Returns an empty string when nothing meaningful applies.
 */
function rowAccent(item: InboxItem): string {
  switch (item.kind) {
    case 'work-submission':
      return item.has_done ? 'review' : 'claim';
    case 'admin-action':
      return item.stamp?.quality ?? item.subkind;
    case 'wanted-post':
      return item.priority ?? '';
    default:
      return '';
  }
}

function itemSearchHaystack(item: InboxItem): string {
  const parts: Array<string | null | undefined> = [
    item.title,
    item.pull_id,
    item.from_branch,
    item.submitter,
    item.creator_name,
    KIND_LABEL[item.kind],
  ];
  switch (item.kind) {
    case 'rig-registration':
      parts.push(item.handle, item.display_name, item.owner_email, item.dolthub_org);
      break;
    case 'wanted-post':
      parts.push(item.item_id, item.item_title, item.description, item.posted_by, item.tags);
      break;
    case 'wanted-edit':
      parts.push(item.item_id, item.item_title, item.posted_by, item.subkind);
      break;
    case 'work-submission':
      parts.push(item.item_id, item.item_title, item.claimer, item.evidence_url);
      break;
    case 'admin-action':
      parts.push(
        item.item_id,
        item.item_title,
        item.worker,
        item.acceptor,
        item.reject_reason,
        item.stamp?.message
      );
      break;
    case 'unknown':
      parts.push(...item.commit_subjects);
      break;
  }
  return parts.filter(Boolean).join(' ').toLowerCase();
}

function buildDolthubPullUrl(upstream: string, pullId: string): string {
  const [owner, repo] = upstream.split('/');
  if (!owner || !repo) return `https://www.dolthub.com/repositories/${upstream}/pulls/${pullId}`;
  return `https://www.dolthub.com/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(pullId)}`;
}

function countByKind(items: InboxItem[]): Partial<Record<InboxKind, number>> {
  const counts: Partial<Record<InboxKind, number>> = {};
  for (const item of items) {
    counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  }
  return counts;
}

function timestampMs(iso: string | null): number {
  if (!iso) return 0;
  try {
    return new Date(iso).getTime() || 0;
  } catch {
    return 0;
  }
}

function formatRelative(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}
