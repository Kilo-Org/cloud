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
  ExternalLink,
  GitPullRequest,
  Inbox,
  Loader2,
  MessageSquare,
  X,
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

  const mergeMutation = useMutation({
    ...trpc.wasteland.mergeUpstreamPR.mutationOptions(),
    onSuccess: () => {
      toast.success('Merge initiated');
      for (const ms of [2_000, 5_000, 15_000, 30_000]) {
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

  const [commentItem, setCommentItem] = useState<InboxItem | null>(null);

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
          <IncomingPullRow
            key={item.pull_id}
            item={item}
            wastelandId={wastelandId}
            busy={mergeMutation.isPending || closeMutation.isPending}
            onMerge={() => mergeMutation.mutate({ wastelandId, pullId: item.pull_id })}
            onClose={() => closeMutation.mutate({ wastelandId, pullId: item.pull_id })}
            onComment={() => setCommentItem(item)}
          />
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

function IncomingPullRow({
  item,
  busy,
  onMerge,
  onClose,
  onComment,
}: {
  item: InboxItem;
  wastelandId: string;
  busy: boolean;
  onMerge: () => void;
  onClose: () => void;
  onComment: () => void;
}) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
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
        <Badge variant="outline" className="border-white/10 bg-white/[0.04] text-white/55">
          {item.kind}
        </Badge>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onMerge} disabled={busy} className="h-8 gap-1.5">
          Merge
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onComment}
          disabled={busy}
          className="h-8 gap-1.5"
        >
          <MessageSquare className="size-3.5" />
          Comment
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onClose}
          disabled={busy}
          className="h-8 gap-1.5 text-white/55 hover:bg-red-500/10 hover:text-red-300"
        >
          <X className="size-3.5" />
          Close
        </Button>
      </div>
    </div>
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
