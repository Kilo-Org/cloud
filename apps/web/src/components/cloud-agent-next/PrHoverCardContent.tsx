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
 * Mirrors `REFRESH_THROTTLE_MS` in `apps/web/src/routers/cli-sessions-v2-router.ts`.
 * The server throttle remains canonical; this only decides whether the action
 * is worth surfacing.
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
  const awaitingSync = pr.state === 'unknown';
  const headShaShort = pr.headSha?.slice(0, 7) ?? null;
  const truncatedTitle = truncatePrTitle(pr.title, 80);
  const observations = pr.platform === 'github' ? pr.observations : null;
  const checks = observations?.checks ?? null;
  const hasDetailedChecks =
    checks !== null &&
    (checks.passed !== undefined ||
      checks.pending !== undefined ||
      checks.skipped !== undefined ||
      checks.unknown !== undefined);
  const checksComplete = checks?.complete === true;
  const mergeability =
    observations?.mergeability && observations.mergeability.headSha === pr.headSha?.toLowerCase()
      ? observations.mergeability
      : null;
  const unavailable = observations?.unavailable ?? [];
  const partial = observations?.truncated === true || unavailable.length > 0;

  const { mutate: refresh, isPending } = useMutation({
    ...trpc.cliSessionsV2.refreshAssociatedPullRequest.mutationOptions(),
    onSuccess: () => {
      void queryClient.invalidateQueries(trpc.cliSessionsV2.list.pathFilter());
      void queryClient.invalidateQueries(trpc.cliSessionsV2.search.pathFilter());
      void queryClient.invalidateQueries(trpc.cliSessionsV2.worktreeDetails.pathFilter());
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

      {awaitingSync && (
        <p className="text-muted-foreground text-xs leading-snug">
          Pull request status has not synced yet. Refresh to fetch the latest status from GitHub.
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
                checksComplete
                  ? 'Check runs and commit statuses for the cached commit.'
                  : 'Checks received via webhooks for the cached commit. Earlier checks may be missing.'
              }
            >
              {checksComplete ? 'Checks' : 'Checks (observed)'}
            </span>
            <span className="tabular-nums">
              {checks === null ? (
                'Unknown'
              ) : hasDetailedChecks ? (
                <>
                  <span>{checks.total} total</span>
                  <span className="block">
                    {checks.passed ?? 0} passed / {checks.failed} failed / {checks.pending ?? 0}{' '}
                    pending
                  </span>
                  {(checks.skipped ?? 0) > 0 && (
                    <span className="block">{checks.skipped} skipped</span>
                  )}
                  {(checks.unknown ?? 0) > 0 && (
                    <span className="block">{checks.unknown} unknown</span>
                  )}
                </>
              ) : (
                `${checks.total} total / ${checks.failed} failed`
              )}
            </span>
            <span
              className="text-muted-foreground"
              title={
                observations?.threadsComplete
                  ? 'Unresolved review threads from the cached pull request.'
                  : 'Unresolved review threads observed via webhooks. Earlier threads may be missing.'
              }
            >
              Unresolved threads
            </span>
            <span className="tabular-nums">
              {observations?.unresolvedThreads == null ? 'Unknown' : observations.unresolvedThreads}
            </span>
            <span
              className="text-muted-foreground"
              title="Whether GitHub can merge this head into the base without conflicts. No conflicts does not mean ready to merge."
            >
              Merge conflicts
            </span>
            <span className={mergeability?.mergeable === false ? 'text-destructive' : undefined}>
              {mergeability?.mergeable === true
                ? 'No conflicts'
                : mergeability?.mergeable === false
                  ? 'Conflicts detected'
                  : 'Unknown'}
            </span>
            {mergeability?.state && (
              <>
                <span className="text-muted-foreground">Merge status</span>
                <span>{MERGE_STATE_LABELS[mergeability.state] ?? mergeability.state}</span>
              </>
            )}
            {mergeability && (
              <>
                <span className="text-muted-foreground">Base</span>
                <span className="truncate font-mono" title={mergeability.baseSha}>
                  {mergeability.baseRef}
                </span>
              </>
            )}
          </>
        )}
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

      {partial && (
        <p className="text-muted-foreground text-xs">
          {unavailable.length > 0 && (
            <>
              Unavailable from GitHub:{' '}
              {unavailable.map(part => UNAVAILABLE_LABELS[part]).join(', ')}.{' '}
            </>
          )}
          Partial observations; some evidence is missing.
        </p>
      )}

      <div className="border-border/60 flex items-center gap-2 border-t pt-3">
        {pr.platform === 'github' &&
          (awaitingSync || !isWithinRefreshThrottle(pr.lastSyncedAt)) && (
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
