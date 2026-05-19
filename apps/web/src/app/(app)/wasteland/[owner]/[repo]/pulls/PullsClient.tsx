'use client';

/**
 * Pull requests view — proposals from forks to the upstream.
 *
 * Two tabs:
 *  - Mine     : PRs the current user opened (sourced from
 *               `wasteland.listMyPulls`).
 *  - Incoming : PRs from other rigs against the upstream, visible to
 *               maintainer rigs only (`trust_level >= 2` on the
 *               wasteland's members table OR `is_upstream_admin` on
 *               the caller's credential). Reuses the existing
 *               `wasteland.listInboxItems` procedure and the merge /
 *               close / comment mutations from the legacy review
 *               page.
 *
 * The Incoming tab is intentionally hidden — not just disabled — when
 * the caller lacks maintainer access, so contributors don't see a
 * teasing tab they can't use.
 */

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useWastelandTRPC } from '@/lib/wasteland/trpc';
import type { WastelandOutputs } from '@/lib/wasteland/trpc';
import { useUser } from '@/hooks/useUser';
import { useWastelandRepo } from '../_components/WastelandRepoContext';
import { useDrawerStack } from '@/components/wasteland/drawer/WastelandDrawerStack';
import type { AcceptFormInput, ReviewPanelActions } from '@/components/wasteland/drawer/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  GitPullRequest,
  Inbox,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';

type MyPull = WastelandOutputs['wasteland']['listMyPulls'][number];
type InboxItem = WastelandOutputs['wasteland']['listInboxItems']['items'][number];

const STATE_TONE: Record<MyPull['state'], string> = {
  open: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300',
  merged: 'border-violet-500/20 bg-violet-500/10 text-violet-300',
  closed: 'border-white/10 bg-white/[0.04] text-white/45',
};

export function PullsClient() {
  const repo = useWastelandRepo();
  const trpc = useWastelandTRPC();
  const { data: currentUser } = useUser();

  const credentialQuery = useQuery(
    trpc.wasteland.getCredentialStatus.queryOptions({ wastelandId: repo.wastelandId })
  );
  const membersQuery = useQuery(
    trpc.wasteland.listMembers.queryOptions({ wastelandId: repo.wastelandId })
  );

  // Maintainer access — controls whether the Incoming tab shows up.
  //
  // The plan flagged this as an open question, recommending
  // `trust_level >= 2`. We broaden it deliberately:
  //   - `trust_level >= 2` on the wasteland members table — a
  //     wasteland-local maintainer.
  //   - `is_upstream_admin` on the caller's credential — someone who
  //     literally owns the upstream DoltHub repo. Locking these users
  //     out of their own PR queue would be perverse.
  //   - site `is_admin` — Kilo staff debugging the inbox.
  // None of these signals lets a non-admin do anything they couldn't
  // already do via a direct DoltHub call; they only gate visibility.
  const currentMember = membersQuery.data?.find(m => m.user_id === currentUser?.id);
  const isMaintainer =
    (currentMember?.trust_level ?? 0) >= 2 ||
    credentialQuery.data?.is_upstream_admin === true ||
    currentUser?.is_admin === true;

  const [tab, setTab] = useState<'mine' | 'incoming'>('mine');

  return (
    <div className="flex h-full flex-col">
      <PullsHeader owner={repo.owner} repoName={repo.repo} />

      <Tabs
        value={tab}
        onValueChange={value => setTab(value === 'incoming' ? 'incoming' : 'mine')}
        className="flex flex-1 flex-col overflow-hidden"
      >
        <div className="border-b border-white/[0.06] px-6 pt-3">
          <TabsList className="bg-transparent p-0">
            <TabsTrigger value="mine" className="data-[state=active]:bg-white/[0.06]">
              Mine
            </TabsTrigger>
            {isMaintainer && (
              <TabsTrigger value="incoming" className="data-[state=active]:bg-white/[0.06]">
                Incoming
              </TabsTrigger>
            )}
          </TabsList>
        </div>

        <TabsContent value="mine" className="mt-0 flex-1 overflow-y-auto px-6 py-4">
          <MineTab wastelandId={repo.wastelandId} />
        </TabsContent>

        {isMaintainer && (
          <TabsContent value="incoming" className="mt-0 flex-1 overflow-y-auto px-6 py-4">
            <IncomingTab wastelandId={repo.wastelandId} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

// ── Header ──────────────────────────────────────────────────────────────

function PullsHeader({ owner, repoName }: { owner: string; repoName: string }) {
  return (
    <div className="flex flex-col gap-1 border-b border-white/[0.06] bg-white/[0.015] px-6 py-3">
      <p className="text-sm font-medium text-white/85">
        Pull requests against{' '}
        <span className="font-mono text-white/65">
          {owner}/{repoName}
        </span>
      </p>
      <p className="text-xs text-white/45">Proposals from forks to the upstream.</p>
    </div>
  );
}

// ── Mine tab ────────────────────────────────────────────────────────────

function MineTab({ wastelandId }: { wastelandId: string }) {
  const trpc = useWastelandTRPC();
  const pullsQuery = useQuery(trpc.wasteland.listMyPulls.queryOptions({ wastelandId }));

  if (pullsQuery.isLoading) return <ListSkeleton />;

  if (pullsQuery.isError) {
    return (
      <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
        <p className="text-sm text-red-400">Failed to load your pulls</p>
        <p className="mt-1 font-mono text-[11px] text-white/40">{pullsQuery.error.message}</p>
      </div>
    );
  }

  const pulls = pullsQuery.data ?? [];
  if (pulls.length === 0) {
    return (
      <EmptyState
        icon={<GitPullRequest className="size-5 text-white/40" />}
        title="No pulls yet."
        description="Once you publish a branch from your fork, the PR shows up here."
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {pulls.map(pull => (
        <MinePullRow key={pull.pullId} pull={pull} />
      ))}
    </div>
  );
}

function MinePullRow({ pull }: { pull: MyPull }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <a
            href={pull.dolthubUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-white/85 transition-colors hover:text-primary"
          >
            {pull.title}
            <ExternalLink className="size-3 text-white/40" />
          </a>
          <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[11px] text-white/40">
            <span>#{pull.pullId}</span>
            {pull.branchName && (
              <>
                <span className="text-white/15">·</span>
                <span className="truncate">{pull.branchName}</span>
              </>
            )}
            {pull.updatedAt && (
              <>
                <span className="text-white/15">·</span>
                <span>updated {formatRelative(pull.updatedAt)}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className={STATE_TONE[pull.state]}>
            {pull.state}
          </Badge>
          {pull.state === 'open' && pull.mergeable && (
            <Badge
              variant="outline"
              className="border-white/10 bg-white/[0.04] text-[10px] text-white/55"
            >
              Mergeable
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Incoming tab ────────────────────────────────────────────────────────

function IncomingTab({ wastelandId }: { wastelandId: string }) {
  const trpc = useWastelandTRPC();
  const queryClient = useQueryClient();
  const repo = useWastelandRepo();
  const { open: openDrawer, closeAll: closeDrawer } = useDrawerStack();

  const inboxQueryKey = trpc.wasteland.listInboxItems.queryKey({ wastelandId });
  const inboxQuery = useQuery({
    ...trpc.wasteland.listInboxItems.queryOptions({ wastelandId }),
    refetchInterval: 30_000,
  });

  const refetch = () => {
    void queryClient.invalidateQueries({ queryKey: inboxQueryKey });
  };

  // DoltHub merges async — schedule follow-up invalidations so the row
  // disappears once the merge lands without a manual refresh.
  const pendingTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(
    () => () => {
      for (const id of pendingTimers.current) clearTimeout(id);
      pendingTimers.current = [];
    },
    []
  );

  const scheduleSettleRefetch = () => {
    for (const ms of [2_000, 5_000, 15_000, 30_000]) {
      pendingTimers.current.push(setTimeout(refetch, ms));
    }
  };

  // Merge stays available for non-work-submission inbox kinds
  // (rig-registration, wanted-post, wanted-edit, admin-action). For
  // work-submission rows the admin opens the row drawer and submits
  // the inline AcceptForm, which writes the stamp + adoption commit +
  // merges + closes the worker's PR in one shot. Plain Merge on a
  // work-submission would land the worker's branch as-is
  // (status=in_review, no stamp) — exactly the bug we're fixing.
  const mergeMutation = useMutation({
    ...trpc.wasteland.mergeUpstreamPR.mutationOptions(),
    onSuccess: () => {
      toast.success('Merge initiated');
      scheduleSettleRefetch();
      closeDrawer();
    },
    onError: err => toast.error(`Merge failed: ${err.message}`),
  });

  const closeMutation = useMutation({
    ...trpc.wasteland.closeUpstreamPR.mutationOptions(),
    onSuccess: () => {
      toast.success('PR closed');
      refetch();
      closeDrawer();
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
      scheduleSettleRefetch();
      closeDrawer();
    },
    onError: err => toast.error(err.message || 'Accept failed'),
  });

  const [commentItem, setCommentItem] = useState<InboxItem | null>(null);

  // Build the actions object the drawer's ReviewItemPanel consumes. The
  // drawer captures the actions on push, so we build the same object
  // both for openDrawer below and for any inline quick-actions on the
  // row buttons. Re-opening the drawer with a fresh actions object is
  // cheap; it just pushes a new entry.
  const upstream = `${repo.owner}/${repo.repo}`;
  const busy = mergeMutation.isPending || closeMutation.isPending || acceptMutation.isPending;
  const buildActions = (): ReviewPanelActions => ({
    upstream,
    busy,
    onMerge: pr => mergeMutation.mutate({ wastelandId, pullId: pr.pull_id }),
    onCloseAction: pr => closeMutation.mutate({ wastelandId, pullId: pr.pull_id }),
    onComment: pr => setCommentItem(pr),
    onAccept: (pr, input: AcceptFormInput) => {
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
  });

  const handleOpenDrawer = (item: InboxItem) => {
    openDrawer({ type: 'review-item', wastelandId, item, actions: buildActions() });
  };

  if (inboxQuery.isLoading) return <ListSkeleton />;

  if (inboxQuery.isError) {
    if (inboxQuery.error.message.toLowerCase().includes('admin mode required')) {
      return (
        <EmptyState
          icon={<Inbox className="size-5 text-white/40" />}
          title="Admin mode required."
          description="Enable “I own this upstream (admin mode)” in settings to load incoming PRs. A DoltHub token with push access is required."
        />
      );
    }
    return (
      <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
        <p className="text-sm text-red-400">Failed to load incoming PRs</p>
        <p className="mt-1 font-mono text-[11px] text-white/40">{inboxQuery.error.message}</p>
      </div>
    );
  }

  const items = inboxQuery.data?.items ?? [];
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<CheckCircle2 className="size-5 text-emerald-500/60" />}
        title="Inbox zero."
        description="No open pull requests on the upstream."
      />
    );
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        {items.map(item => (
          <IncomingPullRow key={item.pull_id} item={item} onOpen={() => handleOpenDrawer(item)} />
        ))}
      </div>
      <CommentDialog
        wastelandId={wastelandId}
        item={commentItem}
        onClose={() => setCommentItem(null)}
      />
    </>
  );
}

/**
 * Inbox row. Clicking anywhere on the row opens a `review-item`
 * drawer; the drawer holds the per-kind detail view, the inline
 * AcceptForm (for work-submissions), and the secondary action
 * buttons. The DoltHub external-link affordance still opens in a new
 * tab without triggering the drawer.
 */
function IncomingPullRow({ item, onOpen }: { item: InboxItem; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 text-left transition-colors hover:border-white/10 hover:bg-white/[0.035] focus:border-white/15 focus:outline-none"
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white/85">{item.title}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[11px] text-white/40">
            <span>#{item.pull_id}</span>
            {item.from_branch && (
              <>
                <span className="text-white/15">·</span>
                <span className="truncate">{item.from_branch}</span>
              </>
            )}
            {item.submitter && (
              <>
                <span className="text-white/15">·</span>
                <span>{item.submitter}</span>
              </>
            )}
            {item.updated_at && (
              <>
                <span className="text-white/15">·</span>
                <span>updated {formatRelative(item.updated_at)}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="border-white/10 bg-white/[0.04] text-white/55">
            {item.kind}
          </Badge>
          <a
            href={item.dolthub_url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className="rounded p-1 text-white/35 transition-colors hover:bg-white/[0.06] hover:text-white/70"
            aria-label="Open on DoltHub"
          >
            <ExternalLink className="size-3.5" />
          </a>
          <ChevronRight className="size-4 shrink-0 text-white/25" aria-hidden />
        </div>
      </div>
    </button>
  );
}

// ── Comment dialog ─────────────────────────────────────────────────────

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
    commentMutation.mutate({ wastelandId, pullId: item.pull_id, comment: comment.trim() });
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
            >
              Cancel
            </Button>
            <Button type="submit" disabled={commentMutation.isPending || !comment.trim()}>
              {commentMutation.isPending && <Loader2 className="size-3.5 animate-spin" />}
              Post comment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Skeleton + empty state ─────────────────────────────────────────────

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className="animate-pulse rounded-xl border border-white/[0.06] bg-white/[0.02] p-4"
        >
          <div className="h-4 w-2/3 rounded bg-white/[0.06]" />
          <div className="mt-2 h-3 w-1/3 rounded bg-white/[0.04]" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="mx-auto mt-12 flex max-w-md flex-col items-center gap-3 text-center">
      <div className="flex size-10 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03]">
        {icon}
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-white/80">{title}</p>
        <p className="max-w-sm text-xs text-white/45">{description}</p>
      </div>
    </div>
  );
}

function formatRelative(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}
