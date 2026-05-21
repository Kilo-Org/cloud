import pLimit from 'p-limit';
import { captureException } from '@sentry/nextjs';
import { ensureBotUserForOrg } from '@/lib/bot-users/bot-user-service';
import {
  listDispatchableCodeReviewOwnerCandidates,
  type DispatchableCodeReviewOwnerCandidate,
} from '../db/code-reviews';
import { errorExceptInTest, logExceptInTest } from '@/lib/utils.server';
import {
  tryDispatchPendingReviews,
  type TryDispatchPendingReviewsOptions,
} from './dispatch-pending-reviews';
import { cronPendingCodeReviewCreatedAfterSql } from './dispatch-constants';
import type { Owner } from '../core';

const OWNER_SCAN_LIMIT = 100;
const OWNER_DISPATCH_CONCURRENCY = 4;

export type DispatchPendingCodeReviewOwnersSummary = {
  ownersConsidered: number;
  ownersProcessed: number;
  ownersWithNoNewDispatch: number;
  ownersSkippedMissingBotUsers: number;
  coordinatorFailures: number;
  reviewsDispatched: number;
  hasMoreCandidateOwners: boolean;
};

type OwnerDrainOutcome =
  | { status: 'processed'; dispatched: number }
  | { status: 'skipped-missing-bot' }
  | { status: 'failed' };

type DispatchPendingCodeReviewOwnersOptions = TryDispatchPendingReviewsOptions;

async function resolveDispatchOwner(
  candidate: DispatchableCodeReviewOwnerCandidate
): Promise<Owner | null> {
  if (candidate.type === 'user') {
    return { type: 'user', id: candidate.id, userId: candidate.id };
  }

  const botUser = await ensureBotUserForOrg(candidate.id, 'code-review');
  return { type: 'org', id: candidate.id, userId: botUser.id };
}

async function drainOwner(
  candidate: DispatchableCodeReviewOwnerCandidate,
  options: DispatchPendingCodeReviewOwnersOptions
): Promise<OwnerDrainOutcome> {
  try {
    const owner = await resolveDispatchOwner(candidate);
    if (!owner) {
      return { status: 'skipped-missing-bot' };
    }

    const result = await tryDispatchPendingReviews(owner, options);
    return { status: 'processed', dispatched: result.dispatched };
  } catch (error) {
    errorExceptInTest('[dispatchPendingCodeReviewOwners] Owner drain failed', {
      candidate,
      error,
    });
    captureException(error, {
      tags: { operation: 'dispatch-pending-code-review-owner' },
      extra: { candidate },
    });
    return { status: 'failed' };
  }
}

export async function dispatchPendingCodeReviewOwners(
  options: DispatchPendingCodeReviewOwnersOptions = {}
): Promise<DispatchPendingCodeReviewOwnersSummary> {
  const pendingCreatedAfter = options.pendingCreatedAfter ?? cronPendingCodeReviewCreatedAfterSql();
  const dispatchOptions = { ...options, pendingCreatedAfter };
  const candidates = await listDispatchableCodeReviewOwnerCandidates({
    limit: OWNER_SCAN_LIMIT,
    pendingCreatedAfter,
  });
  const limit = pLimit(OWNER_DISPATCH_CONCURRENCY);
  const outcomes = await Promise.all(
    candidates.owners.map(candidate => limit(() => drainOwner(candidate, dispatchOptions)))
  );

  const summary: DispatchPendingCodeReviewOwnersSummary = {
    ownersConsidered: candidates.owners.length,
    ownersProcessed: 0,
    ownersWithNoNewDispatch: 0,
    ownersSkippedMissingBotUsers: 0,
    coordinatorFailures: 0,
    reviewsDispatched: 0,
    hasMoreCandidateOwners: candidates.hasMore,
  };

  for (const outcome of outcomes) {
    if (outcome.status === 'skipped-missing-bot') {
      summary.ownersSkippedMissingBotUsers++;
      continue;
    }

    if (outcome.status === 'failed') {
      summary.coordinatorFailures++;
      continue;
    }

    summary.ownersProcessed++;
    summary.reviewsDispatched += outcome.dispatched;
    if (outcome.dispatched === 0) {
      summary.ownersWithNoNewDispatch++;
    }
  }

  logExceptInTest('[dispatchPendingCodeReviewOwners] Drain complete', summary);
  return summary;
}
