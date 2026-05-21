'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import {
  CheckCircle2,
  ExternalLink,
  GitPullRequest,
  Loader2,
  MessageSquare,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useWastelandTRPC } from '@/lib/wasteland/trpc';
import type { WastelandOutputs } from '@/lib/wasteland/trpc';
import { useUser } from '@/hooks/useUser';

type MyPull = WastelandOutputs['wasteland']['listMyPulls'][number];

const STATE_TONE: Record<MyPull['state'], string> = {
  open: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300',
  merged: 'border-violet-500/20 bg-violet-500/10 text-violet-300',
  closed: 'border-white/10 bg-white/[0.04] text-white/45',
};

/**
 * The "Pull request" tab — info about the PR linked to the user's
 * branch for this item. Visible only when a PR exists; the parent
 * panel hides the tab otherwise.
 *
 * Maintainer affordances (merge / comment / close) are surfaced when
 * the caller is an upstream admin so admins can review their own
 * incoming PR without bouncing to the pulls page. Non-admin users see
 * the link-out + status only.
 */
export function WantedItemPullTab({ wastelandId, pull }: { wastelandId: string; pull: MyPull }) {
  const trpc = useWastelandTRPC();
  const queryClient = useQueryClient();
  const { data: currentUser } = useUser();

  // Maintainer signal mirrors the pulls page (`PullsClient.tsx`):
  // is_upstream_admin OR site admin. Used to gate the merge/close
  // actions; users with neither only see the read-only PR summary.
  const credentialQuery = useQuery(
    trpc.wasteland.getCredentialStatus.queryOptions({ wastelandId })
  );
  const isMaintainer =
    credentialQuery.data?.is_upstream_admin === true || currentUser?.is_admin === true;

  // DoltHub merges async — schedule follow-up invalidations so the
  // status flips from open → merged without a manual refresh.
  const pendingTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(
    () => () => {
      for (const id of pendingTimers.current) clearTimeout(id);
      pendingTimers.current = [];
    },
    []
  );

  const refetch = () => {
    void queryClient.invalidateQueries({
      queryKey: trpc.wasteland.listMyPulls.queryKey({ wastelandId }),
    });
    void queryClient.invalidateQueries({
      queryKey: trpc.wasteland.listMyForkBranches.queryKey({ wastelandId }),
    });
  };

  const mergeMutation = useMutation({
    ...trpc.wasteland.mergeUpstreamPR.mutationOptions(),
    onSuccess: () => {
      toast.success('Merge initiated');
      for (const ms of [2_000, 5_000, 15_000, 30_000]) {
        pendingTimers.current.push(setTimeout(refetch, ms));
      }
    },
    onError: err => toast.error(err.message || 'Merge failed'),
  });

  const closeMutation = useMutation({
    ...trpc.wasteland.closeUpstreamPR.mutationOptions(),
    onSuccess: () => {
      toast.success('PR closed');
      refetch();
    },
    onError: err => toast.error(err.message || 'Close failed'),
  });

  const [commentOpen, setCommentOpen] = useState(false);

  const busy = mergeMutation.isPending || closeMutation.isPending;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-start gap-2">
          <GitPullRequest className="mt-0.5 size-4 shrink-0 text-white/40" />
          <a
            href={pull.dolthubUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-white/85 transition-colors hover:text-primary"
          >
            {pull.title}
            <ExternalLink className="size-3 text-white/40" />
          </a>
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
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-white/40">
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

      {isMaintainer && pull.state === 'open' && (
        <div className="flex flex-col gap-2 border-t border-white/[0.06] pt-3">
          <p className="text-[10px] font-semibold tracking-[0.08em] text-white/30 uppercase">
            Maintainer actions
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => mergeMutation.mutate({ wastelandId, pullId: pull.pullId })}
              disabled={busy}
              className="h-8 gap-1.5"
            >
              {mergeMutation.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <CheckCircle2 className="size-3.5" />
              )}
              Merge
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setCommentOpen(true)}
              disabled={busy}
              className="h-8 gap-1.5"
            >
              <MessageSquare className="size-3.5" />
              Comment
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => closeMutation.mutate({ wastelandId, pullId: pull.pullId })}
              disabled={busy}
              className="h-8 gap-1.5 text-white/55 hover:bg-red-500/10 hover:text-red-300"
            >
              <X className="size-3.5" />
              Close
            </Button>
          </div>
        </div>
      )}

      {commentOpen && (
        <CommentForm
          wastelandId={wastelandId}
          pullId={pull.pullId}
          onClose={() => setCommentOpen(false)}
        />
      )}
    </div>
  );
}

// ── Inline comment form ───────────────────────────────────────────────

function CommentForm({
  wastelandId,
  pullId,
  onClose,
}: {
  wastelandId: string;
  pullId: string;
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
    onError: err => toast.error(err.message || 'Comment failed'),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!comment.trim()) return;
    commentMutation.mutate({ wastelandId, pullId, comment: comment.trim() });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-2 border-t border-white/[0.06] pt-3">
      <textarea
        required
        rows={4}
        value={comment}
        onChange={e => setComment(e.target.value)}
        placeholder="Write a comment for the contributor…"
        className="w-full resize-none rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-white/80 outline-none placeholder:text-white/25 focus:border-white/20"
      />
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onClose}
          disabled={commentMutation.isPending}
          className="h-8"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={commentMutation.isPending || !comment.trim()}
          className="h-8 gap-1.5"
        >
          {commentMutation.isPending && <Loader2 className="size-3.5 animate-spin" />}
          Post comment
        </Button>
      </div>
    </form>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}
