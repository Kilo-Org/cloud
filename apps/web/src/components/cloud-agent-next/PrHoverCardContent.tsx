'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

const MERGE_STATE_LABELS: Record<string, string> = {
  clean: 'Clean',
  blocked: 'Blocked',
  behind: 'Behind base branch',
  unstable: 'Checks failing',
  dirty: 'Conflicts',
  draft: 'Draft',
  unknown: 'Unknown',
  has_hooks: 'Pre-receive hooks',
};

const UNAVAILABLE_LABELS = {
  checks: 'check runs',
  statuses: 'commit statuses',
  reviews: 'reviews and threads',
};

export function PrHoverCardContent({ pr, sessionId, gitBranch }: PrHoverCardContentProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const statusQuery = useQuery({
    ...trpc.cliSessionsV2.getAssociatedPullRequestStatus.queryOptions({ sessionId, prUrl: pr.url }),
    enabled: pr.platform === 'github',
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: (failureCount, error) => failureCount < 1 && error.data?.code === 'BAD_GATEWAY',
  });
  const refreshMutation = useMutation({
    ...trpc.cliSessionsV2.refreshAssociatedPullRequest.mutationOptions(),
    onSuccess: () => {
      void queryClient.invalidateQueries(trpc.cliSessionsV2.list.pathFilter());
      void queryClient.invalidateQueries(trpc.cliSessionsV2.search.pathFilter());
      void queryClient.invalidateQueries(trpc.cliSessionsV2.worktreeDetails.pathFilter());
    },
    onError: error => toast.error(error.message),
    onSettled: () => void statusQuery.refetch(),
  });
  const status = pr.platform === 'github' ? statusQuery.data : undefined;
  const state = normalizePrBadgeState(status?.state ?? pr.state);
  const headShaShort = (status?.headSha ?? pr.headSha)?.slice(0, 7) ?? null;
  const truncatedTitle = truncatePrTitle(status?.title ?? pr.title, 80);
  const reviewDecision = status ? status.reviewDecision : pr.reviewDecision;
  const isFetching =
    pr.platform === 'github' && (statusQuery.isFetching || refreshMutation.isPending);

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex items-start gap-2">
        <PrStateBadge state={state} />
        <span className="text-muted-foreground text-xs leading-5">PR #{pr.number}</span>
      </div>

      {isFetching && (
        <p className="text-muted-foreground text-xs leading-snug" role="status">
          Fetching pull request status from GitHub...
        </p>
      )}

      {truncatedTitle && (
        <p className="text-foreground line-clamp-2 text-sm leading-snug">{truncatedTitle}</p>
      )}

      <div className="border-border/60 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 border-t pt-3 text-xs">
        {pr.platform === 'github' && (
          <>
            <span
              className="text-muted-foreground"
              title={
                status
                  ? 'Latest check runs and commit statuses for this commit. Required checks are not evaluated.'
                  : 'Checks received via webhooks for the cached commit. Earlier checks may be missing.'
              }
            >
              {status ? 'Checks' : 'Checks (observed)'}
            </span>
            <span className="tabular-nums">
              {status ? (
                status.checks ? (
                  <>
                    <span>
                      {status.checks.total}
                      {status.checks.truncated ? '+' : ''} total
                    </span>
                    <span className="block">
                      {status.checks.passed} passed / {status.checks.failed} failed /{' '}
                      {status.checks.pending} pending
                    </span>
                    {status.checks.skipped > 0 && (
                      <span className="block">{status.checks.skipped} skipped</span>
                    )}
                    {status.checks.unknown > 0 && (
                      <span className="block">{status.checks.unknown} unknown</span>
                    )}
                  </>
                ) : (
                  'Unavailable'
                )
              ) : pr.observations?.checks ? (
                `${pr.observations.checks.total} total / ${pr.observations.checks.failed} failed`
              ) : (
                'Unknown'
              )}
            </span>
            <span
              className="text-muted-foreground"
              title={
                status
                  ? 'Unresolved review threads read from GitHub, not individual replies.'
                  : 'Unresolved review threads observed via webhooks. Earlier threads may be missing.'
              }
            >
              Unresolved threads
            </span>
            <span className="tabular-nums">
              {status
                ? status.unresolvedThreads === null
                  ? 'Unavailable'
                  : `${status.unresolvedThreads}${status.threadsTruncated ? '+' : ''}`
                : (pr.observations?.unresolvedThreads ?? 'Unknown')}
            </span>
            <span
              className="text-muted-foreground"
              title="Whether GitHub can merge this head into the base without conflicts. No conflicts does not mean ready to merge."
            >
              Merge conflicts
            </span>
            <span className={status?.mergeable === false ? 'text-destructive' : undefined}>
              {status?.mergeable === true
                ? 'No conflicts'
                : status?.mergeable === false
                  ? 'Conflicts detected'
                  : 'Unknown'}
            </span>
            {status?.mergeableState && (
              <>
                <span className="text-muted-foreground">Merge status</span>
                <span>{MERGE_STATE_LABELS[status.mergeableState] ?? status.mergeableState}</span>
              </>
            )}
          </>
        )}
        {(pr.platform === 'github' || reviewDecision) && (
          <>
            <span className="text-muted-foreground">Review</span>
            <span className={reviewDecision ? REVIEW_DECISION_CLASSES[reviewDecision] : undefined}>
              {reviewDecision
                ? REVIEW_DECISION_LABELS[reviewDecision]
                : status
                  ? status.unavailable.includes('reviews')
                    ? 'Unavailable'
                    : 'No decision'
                  : 'Unknown'}
            </span>
          </>
        )}
        {(status?.headRef ?? gitBranch) && (
          <>
            <span className="text-muted-foreground">Branch</span>
            <span className="truncate font-mono">{status?.headRef ?? gitBranch}</span>
          </>
        )}
        {status && (
          <>
            <span className="text-muted-foreground">Base</span>
            <span className="truncate font-mono" title={status.baseSha}>
              {status.baseRef}
            </span>
          </>
        )}
        {headShaShort && (
          <>
            <span className="text-muted-foreground">Commit</span>
            <span className="font-mono">{headShaShort}</span>
          </>
        )}
        <span className="text-muted-foreground">Synced</span>
        <span>{formatRelativeSync(status?.fetchedAt ?? pr.lastSyncedAt)}</span>
      </div>

      {pr.platform === 'github' && statusQuery.isError && (
        <p className="text-destructive text-xs" role="alert">
          {statusQuery.error.message}
          {status && ' Showing the last fetched status.'}
        </p>
      )}

      {status && status.unavailable.length > 0 && (
        <p className="text-muted-foreground text-xs">
          Unavailable from GitHub:{' '}
          {status.unavailable.map(part => UNAVAILABLE_LABELS[part]).join(', ')}. Check the GitHub
          connection permissions and refresh to try again.
        </p>
      )}

      {status && (status.checks?.truncated || status.threadsTruncated) && (
        <p className="text-muted-foreground text-xs">
          Partial counts; some checks or threads could not be read.
        </p>
      )}

      {pr.platform === 'github' && !status && pr.observations?.truncated && (
        <p className="text-muted-foreground text-xs">
          Partial observations; some evidence is missing.
        </p>
      )}

      <div className="border-border/60 flex items-center gap-2 border-t pt-3">
        {pr.platform === 'github' && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => refreshMutation.mutate({ sessionId })}
            disabled={isFetching}
            aria-label="Refresh pull request status"
          >
            <RefreshCw className={isFetching ? 'animate-spin' : undefined} />
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
