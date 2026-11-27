import { z } from 'zod';

/** The proxy's HTTP API (contract §4) and its run view. */

export const MAX_REQUEST_BYTES = 1024;

export const RunRequestSchema = z.strictObject({ sha: z.string().regex(/^[0-9a-f]{40}$/) });

export const FAILURE_CODES = [
  'github_unavailable',
  'journal_invalid',
  'owners_unreadable',
  'owners_mismatch',
  'migration_not_approved',
  'container_start_failed',
  'probe_failed',
  'leftover_not_ended',
  'lock_busy',
  'journal_order_invalid',
  'migration_not_reviewed',
  'invalid_index_present',
  'migration_failed',
  'container_lost',
  'deadline_exceeded',
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

export const PROBE_REASONS = [
  'connect_timeout',
  'tls_verify_failed',
  'not_primary',
  'auth_failed',
  'wrong_role',
] as const;
export type ProbeReason = (typeof PROBE_REASONS)[number];

/** Why one changed migration path failed the owner-approval check (§5 step 5). */
export type ReviewFailureReason =
  | 'no_pr'
  | 'ambiguous_pr'
  | 'approval_on_other_blob'
  | 'no_owner_approval'
  | 'author_only';

export type RunFailure = {
  code: FailureCode;
  retryable: boolean;
  /** Only with `probe_failed`: which part of the probe failed (§6 step 2). */
  reason?: ProbeReason;
  sqlstate: string | null;
  migrationTag: string | null;
  /** Only with `invalid_index_present`. */
  indexes?: string[];
  /** Only with `migration_not_approved`. */
  files?: { path: string; reason: ReviewFailureReason; pr: number | null }[];
};

const RETRYABLE_SQLSTATES = new Set(['57014', '55P03', '40P01', '40001']);
const RETRYABLE_PROBE_REASONS: readonly ProbeReason[] = [
  'connect_timeout',
  'tls_verify_failed',
  'not_primary',
];

/** §6 and §8: whether CI may re-POST after a failure. */
export function isRetryable(
  code: FailureCode,
  detail: { reason?: ProbeReason; sqlstate?: string | null } = {}
): boolean {
  switch (code) {
    case 'github_unavailable':
    case 'container_start_failed':
    case 'leftover_not_ended':
    case 'lock_busy':
    case 'container_lost':
      return true;
    case 'probe_failed':
      return detail.reason !== undefined && RETRYABLE_PROBE_REASONS.includes(detail.reason);
    case 'migration_failed': {
      const sqlstate = detail.sqlstate ?? null;
      return sqlstate !== null && (RETRYABLE_SQLSTATES.has(sqlstate) || sqlstate.startsWith('08'));
    }
    default:
      return false;
  }
}

export type RunState = 'pending' | 'running' | 'succeeded' | 'failed';
export type RunPhase = 'fetching' | 'reviewing' | 'starting' | 'probing' | 'migrating' | 'done';

export type AppliedMigration = { tag: string; hash: string; createdAt: number };

export type RunView = {
  id: string;
  environment: string;
  state: RunState;
  phase: RunPhase;
  sha: string;
  attestedSha: string;
  github: { runId: string; runAttempt: string; eventName: string };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  heartbeatAt: string | null;
  pending: string[];
  applied: AppliedMigration[];
  failure: RunFailure | null;
  pollAfterSeconds: number;
};

export type DeniedReason =
  | 'unknown_workload'
  | 'environment_mismatch'
  | 'grant_not_allowed'
  | 'caller_not_allowed'
  | 'claim_mismatch'
  | 'sha_not_on_main'
  | 'sha_not_attested'
  | 'sha_behind_attempted'
  | 'sha_diverged';

/** What the run-creation step answers; the Worker turns it into a response. */
export type CreateOutcome =
  | { kind: 'accepted'; run: RunView }
  | { kind: 'existing'; run: RunView }
  | { kind: 'already_applied'; run: RunView }
  | { kind: 'denied'; reason: DeniedReason; attemptedSha?: string }
  | { kind: 'busy'; activeRunId: string }
  | { kind: 'limited'; reason: 'rate_limited' | 'too_many_attempts'; retryAfterSeconds: number }
  | { kind: 'unavailable'; reason: 'github_unavailable'; retryAfterSeconds: number }
  | { kind: 'config_invalid' };

const BUSY_RETRY_SECONDS = 30;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

export function createResponse(outcome: CreateOutcome): Response {
  switch (outcome.kind) {
    case 'accepted':
      return json(202, { status: 'accepted', run: outcome.run });
    case 'existing':
      return json(200, { status: 'existing', run: outcome.run });
    case 'already_applied':
      return json(200, { status: 'already_applied', run: outcome.run });
    case 'denied':
      return deniedResponse(outcome.reason, outcome.attemptedSha);
    case 'busy':
      return json(
        409,
        { status: 'busy', activeRunId: outcome.activeRunId, retryAfterSeconds: BUSY_RETRY_SECONDS },
        { 'Retry-After': String(BUSY_RETRY_SECONDS) }
      );
    case 'limited':
      return json(
        429,
        { status: 'limited', reason: outcome.reason, retryAfterSeconds: outcome.retryAfterSeconds },
        { 'Retry-After': String(outcome.retryAfterSeconds) }
      );
    case 'unavailable':
      return unavailableResponse(outcome.reason, outcome.retryAfterSeconds);
    case 'config_invalid':
      return configInvalidResponse();
  }
}

export function deniedResponse(reason: DeniedReason, attemptedSha?: string): Response {
  return json(403, {
    status: 'denied',
    reason,
    ...(attemptedSha === undefined ? {} : { attemptedSha }),
  });
}

export const identityRejectedResponse = () =>
  json(401, { status: 'denied', reason: 'identity_rejected' });

export const invalidRequestResponse = (status: 400 | 413) =>
  json(status, { status: 'invalid_request' });

export const notFoundResponse = () => json(404, { status: 'not_found' });

/** A refused config (§3, §8 `config_invalid`): not retryable, fixed in a reviewed PR. */
export const configInvalidResponse = () => json(500, { status: 'config_invalid' });

export function unavailableResponse(
  reason: 'sts_unavailable' | 'github_unavailable',
  retryAfterSeconds: number
): Response {
  return json(
    503,
    { status: 'unavailable', reason, retryAfterSeconds },
    { 'Retry-After': String(retryAfterSeconds) }
  );
}
