import { z } from 'zod';

/**
 * Database lease contracts (design 4.5, 6.1 job 3): a Worker calls `SecretsBroker.lease` and
 * `SecretsBroker.revokeLease`, a caller outside the account posts the same bodies to
 * `STS_LEASE_HTTP_PATH` and `STS_LEASE_REVOKE_HTTP_PATH` with its provider OIDC token as the bearer.
 */

/** The dynamic grants a policy may list; each is one Infisical dynamic secret. */
export const LEASE_GRANTS = ['replica-read', 'ci-migration'] as const;
export const LeaseGrantSchema = z.enum(LEASE_GRANTS);
export type LeaseGrant = z.infer<typeof LeaseGrantSchema>;

/**
 * The longest lease of each grant (design 4.5: 8 hours read-only, 1 hour for a migration). A
 * policy sets its own maximum at or below it, and the dynamic secret's Max TTL equals it.
 */
export const LEASE_GRANT_MAX_TTL_SECONDS: Readonly<Record<LeaseGrant, number>> = {
  'replica-read': 8 * 60 * 60,
  'ci-migration': 60 * 60,
};

/** No lease is shorter than this. */
export const LEASE_MIN_TTL_SECONDS = 5 * 60;

/** A requested lifetime above the policy's maximum is shortened to it; one above this is malformed. */
export const LEASE_REQUEST_MAX_TTL_SECONDS = 24 * 60 * 60;

export const STS_LEASE_HTTP_PATH = '/v1/lease';
export const STS_LEASE_REVOKE_HTTP_PATH = '/v1/lease/revoke';

/** Infisical's lease id. */
export const LeaseIdSchema = z.uuid();

export const LeaseRequestSchema = z.strictObject({
  grant: LeaseGrantSchema,
  /** Omitted: the policy's default lifetime. */
  ttlSeconds: z
    .number()
    .int()
    .min(LEASE_MIN_TTL_SECONDS)
    .max(LEASE_REQUEST_MAX_TTL_SECONDS)
    .optional(),
});
export type LeaseRequest = z.infer<typeof LeaseRequestSchema>;

export const LeaseRevokeRequestSchema = z.strictObject({ leaseId: LeaseIdSchema });
export type LeaseRevokeRequest = z.infer<typeof LeaseRevokeRequestSchema>;

/** Non-retryable refusals of the caller itself, on both routes. */
export const LEASE_CALLER_DENIED_REASONS = [
  'identity_rejected',
  'unknown_workload',
  'environment_mismatch',
] as const;
export type LeaseCallerDeniedReason = (typeof LEASE_CALLER_DENIED_REASONS)[number];

/** Non-retryable: the caller gets no lease of this grant until its identity or policy changes. */
export const LEASE_DENIED_REASONS = [...LEASE_CALLER_DENIED_REASONS, 'grant_not_allowed'] as const;
export type LeaseDeniedReason = (typeof LEASE_DENIED_REASONS)[number];

/**
 * Retryable after `retryAfterSeconds`: the workload holds its policy's number of active leases of
 * this grant, or made too many lease requests in the last minute.
 */
export const LEASE_LIMITED_REASONS = ['too_many_active', 'rate_limited'] as const;
export type LeaseLimitedReason = (typeof LEASE_LIMITED_REASONS)[number];

const RetryAfterSchema = z.number().int().positive().max(3600);

const IssuedLeaseSchema = z.strictObject({
  status: z.literal('ok'),
  leaseId: LeaseIdSchema,
  grant: LeaseGrantSchema,
  username: z.string().min(1),
  password: z.string().min(1),
  expiresAt: z.iso.datetime(),
  ttlSeconds: z.number().int().positive(),
  /** True when STS shortened the requested lifetime to the policy's maximum. */
  clamped: z.boolean(),
  /**
   * Where to connect, only when STS configuration names it for this grant (`ci-migration`: the
   * primary's direct endpoint). A `replica-read` caller keeps its own replica host.
   */
  host: z.string().min(1).max(253).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  database: z.string().min(1).max(63).optional(),
});
export type IssuedLease = z.infer<typeof IssuedLeaseSchema>;

const InvalidRequestSchema = z.strictObject({ status: z.literal('invalid_request') });

const UnavailableSchema = z.strictObject({
  status: z.literal('unavailable'),
  retryAfterSeconds: RetryAfterSchema,
});

export const LeaseResultSchema = z.discriminatedUnion('status', [
  IssuedLeaseSchema,
  z.strictObject({ status: z.literal('denied'), reason: z.enum(LEASE_DENIED_REASONS) }),
  z.strictObject({
    status: z.literal('limited'),
    reason: z.enum(LEASE_LIMITED_REASONS),
    retryAfterSeconds: RetryAfterSchema,
  }),
  InvalidRequestSchema,
  UnavailableSchema,
]);
export type LeaseResult = z.infer<typeof LeaseResultSchema>;

/**
 * `revoked` also answers for the caller's own lease that already ended. `not_found` answers for a
 * lease id STS never issued to this caller, another workload's included, so a caller learns
 * nothing about other leases.
 */
export const LeaseRevokeResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('revoked'), leaseId: LeaseIdSchema }),
  z.strictObject({ status: z.literal('not_found') }),
  z.strictObject({ status: z.literal('denied'), reason: z.enum(LEASE_CALLER_DENIED_REASONS) }),
  InvalidRequestSchema,
  UnavailableSchema,
]);
export type LeaseRevokeResult = z.infer<typeof LeaseRevokeResultSchema>;

/**
 * HTTP status of a lease answer: ok 200, invalid_request 400, denied 401 (identity) or 403,
 * limited 429 and unavailable 503, both with `Retry-After`.
 */
export function leaseResultHttpStatus(result: LeaseResult): 200 | 400 | 401 | 403 | 429 | 503 {
  switch (result.status) {
    case 'ok':
      return 200;
    case 'invalid_request':
      return 400;
    case 'denied':
      return result.reason === 'identity_rejected' ? 401 : 403;
    case 'limited':
      return 429;
    case 'unavailable':
      return 503;
  }
}

/** HTTP status of a revoke answer: revoked 200, not_found 404, the rest as for a lease. */
export function leaseRevokeResultHttpStatus(
  result: LeaseRevokeResult
): 200 | 400 | 401 | 403 | 404 | 503 {
  switch (result.status) {
    case 'revoked':
      return 200;
    case 'not_found':
      return 404;
    case 'invalid_request':
      return 400;
    case 'denied':
      return result.reason === 'identity_rejected' ? 401 : 403;
    case 'unavailable':
      return 503;
  }
}
