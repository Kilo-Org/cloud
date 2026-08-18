import { UserDeletionRequestStatus } from '@kilocode/db/schema-types';
import type { UserDeletionStepKey, UserDeletionTaskProgress } from '@kilocode/db/schema-types';

export type DeletionHandlerContinue = {
  kind: 'continue';
  progress?: UserDeletionTaskProgress;
};

export type DeletionHandlerRetry = {
  kind: 'retry';
  errorCode: string;
  httpStatusClass?: string;
};

export type DeletionHandlerRateLimited = {
  kind: 'rate_limited';
  retryAfterMs: number;
};

export type DeletionHandlerNeedsAttention = {
  kind: 'needs_attention';
  errorCode: string;
  resourceHmac?: string;
};

export type DeletionHandlerManualAction = {
  kind: 'manual_action_required';
  errorCode: string;
};

export type DeletionHandlerSucceeded = {
  kind: 'succeeded';
  progress?: UserDeletionTaskProgress;
};

export type DeletionHandlerNotApplicable = {
  kind: 'not_applicable';
  errorCode?: string;
};

export type DeletionHandlerOutcome =
  | DeletionHandlerContinue
  | DeletionHandlerRetry
  | DeletionHandlerRateLimited
  | DeletionHandlerNeedsAttention
  | DeletionHandlerManualAction
  | DeletionHandlerSucceeded
  | DeletionHandlerNotApplicable;

export type DeletionHandlerContext = {
  requestId: string;
  stepKey: UserDeletionStepKey;
  claimToken: string;
  deadlineAt: number;
  remainingMs: () => number;
  signal: AbortSignal;
};

export type PersistTaskOutcomeResult =
  | { kind: 'applied'; effectiveOutcome: DeletionHandlerOutcome; anonymizedUserId?: string }
  | { kind: 'already_terminal' }
  | { kind: 'stale_claim' };

export type DeletionPreflightOutcome =
  | { kind: 'promoted'; adoptedUserId: string | null }
  | { kind: 'needs_attention'; errorCode: string }
  | { kind: 'skipped'; reason: 'not_found' | 'not_pending' | 'already_blocked' };

export const SUCCESSFUL_TASK_STATUSES = [
  'succeeded',
  'not_applicable',
  'manually_verified',
] as const;

/**
 * Request statuses that still hold the "one active deletion per identity"
 * invariant enforced by the `UQ_user_deletion_requests_active_*` partial unique
 * indexes (email HMAC, user id, and Pylon ticket) and by the sign-in identity
 * fence. Every query that means "still live" must use this list so those
 * surfaces cannot disagree.
 */
export const ACTIVE_REQUEST_STATUSES = [
  UserDeletionRequestStatus.Pending,
  UserDeletionRequestStatus.InProgress,
  UserDeletionRequestStatus.Finalizing,
] as const;
