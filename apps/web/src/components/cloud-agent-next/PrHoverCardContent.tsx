'use client';

import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useTRPC } from '@/lib/trpc/utils';

import { PrStateBadge } from './PrStateBadge';
import {
  normalizePrBadgeState,
  truncatePrTitle,
  type AssociatedPr,
  type ReviewDecision,
} from './utils/github-pr-link';

type PrHoverCardContentProps = {
  pr: AssociatedPr;
  sessionId: string;
  gitBranch: string | null;
};

/**
 * Hide the Refresh button while the cache row is at most this old. Mirrors
 * `REFRESH_THROTTLE_MS` in `apps/web/src/routers/cli-sessions-v2-router.ts`;
 * the server short-circuits below the same threshold.
 */
const REFRESH_THROTTLE_MS = 60_000;

const REVIEW_DECISION_LABELS: Record<ReviewDecision, string> = {
  approved: 'Approved',
  changes_requested: 'Changes requested',
  review_required: 'Awaiting review',
};

const REVIEW_DECISION_CLASSES: Record<ReviewDecision, string> = {
  approved: 'text-emerald-400',
  changes_requested: 'text-amber-400',
  review_required: 'text-muted-foreground',
};

function formatRelativeSync(lastSyncedAt: string): string {
  const parsed = new Date(lastSyncedAt);
  if (Number.isNaN(parsed.getTime())) return 'unknown';
  return formatDistanceToNow(parsed, { addSuffix: true });
}

function isWithinRefreshThrottle(lastSyncedAt: string): boolean {
  const parsed = Date.parse(lastSyncedAt);
  if (!Number.isFinite(parsed)) return false;
  return Date.now() - parsed < REFRESH_THROTTLE_MS;
}

export function PrHoverCardContent({ pr, sessionId, gitBranch }: PrHoverCardContentProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const state = normalizePrBadgeState(pr.state);
  const headShaShort = pr.headSha?.slice(0, 7) ?? null;
  const truncatedTitle = truncatePrTitle(pr.title, 80);

  const { mutate: refresh, isPending } = useMutation({
    ...trpc.cliSessionsV2.refreshAssociatedPullRequest.mutationOptions(),
    onSuccess: () => {
      void queryClient.invalidateQueries(trpc.cliSessionsV2.list.pathFilter());
      void queryClient.invalidateQueries(trpc.cliSessionsV2.search.pathFilter());
    },
    onError: error => {
      toast.error(error?.message ?? 'Failed to refresh pull request status');
    },
  });

  const handleRefresh = useCallback(() => {
    if (isPending) return;
    refresh({ sessionId });
  }, [isPending, refresh, sessionId]);

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex items-start gap-2">
        <PrStateBadge state={state} />
        <span className="text-muted-foreground text-xs leading-5">PR #{pr.number}</span>
      </div>

      {truncatedTitle && (
        <p className="text-foreground line-clamp-2 text-sm leading-snug">{truncatedTitle}</p>
      )}

      <div className="border-border/60 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 border-t pt-3 text-xs">
        {pr.reviewDecision && (
          <>
            <span className="text-muted-foreground">Review</span>
            <span className={REVIEW_DECISION_CLASSES[pr.reviewDecision]}>
              {REVIEW_DECISION_LABELS[pr.reviewDecision]}
            </span>
          </>
        )}
        {gitBranch && (
          <>
            <span className="text-muted-foreground">Branch</span>
            <span className="truncate font-mono">{gitBranch}</span>
          </>
        )}
        {headShaShort && (
          <>
            <span className="text-muted-foreground">Commit</span>
            <span className="font-mono">{headShaShort}</span>
          </>
        )}
        <span className="text-muted-foreground">Synced</span>
        <span>{formatRelativeSync(pr.lastSyncedAt)}</span>
      </div>

      <div className="border-border/60 flex items-center gap-2 border-t pt-3">
        {!isWithinRefreshThrottle(pr.lastSyncedAt) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            disabled={isPending}
            aria-label="Refresh pull request status"
          >
            <RefreshCw className={isPending ? 'animate-spin' : undefined} />
            Refresh
          </Button>
        )}
        <Button asChild variant="outline" size="sm" className="ml-auto">
          <a href={pr.url} target="_blank" rel="noopener noreferrer">
            <ExternalLink />
            Open on GitHub
          </a>
        </Button>
      </div>
    </div>
  );
}
