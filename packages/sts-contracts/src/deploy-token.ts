import { z } from 'zod';

/**
 * CI deploy-token contracts (design 4.4, 4.5, 6.1 job 3): a GitHub Actions job posts to
 * `STS_CLOUDFLARE_DEPLOY_TOKEN_HTTP_PATH` with its GitHub OIDC token (audience: the STS issuer) as
 * the bearer and gets one Cloudflare account API token for its policy's permission set. It revokes
 * the token with `STS_CLOUDFLARE_DEPLOY_TOKEN_REVOKE_HTTP_PATH` when the deploy ends.
 */

export const STS_CLOUDFLARE_DEPLOY_TOKEN_HTTP_PATH = '/v1/ci/cloudflare-deploy-token';
export const STS_CLOUDFLARE_DEPLOY_TOKEN_REVOKE_HTTP_PATH = '/v1/ci/cloudflare-deploy-token/revoke';

/** The longest Cloudflare deploy token STS mints (design 4.5: CI deploy credentials, 1 hour). */
export const CLOUDFLARE_DEPLOY_MAX_TTL_SECONDS = 60 * 60;

/** No Cloudflare deploy token is shorter than this (as for a lease). */
export const CLOUDFLARE_DEPLOY_MIN_TTL_SECONDS = 5 * 60;

/** Cloudflare's token id: 32 lowercase hexadecimal characters. */
export const CloudflareTokenIdSchema = z.string().regex(/^[0-9a-f]{32}$/);

/** The mint body carries nothing: the policy decides the permission set and the lifetime. */
export const CloudflareDeployTokenRequestSchema = z.strictObject({});
export type CloudflareDeployTokenRequest = z.infer<typeof CloudflareDeployTokenRequestSchema>;

export const CloudflareDeployTokenRevokeRequestSchema = z.strictObject({
  tokenId: CloudflareTokenIdSchema,
});
export type CloudflareDeployTokenRevokeRequest = z.infer<
  typeof CloudflareDeployTokenRevokeRequestSchema
>;

/** Non-retryable refusals of the caller itself, on both routes. */
export const DEPLOY_TOKEN_CALLER_DENIED_REASONS = [
  'identity_rejected',
  'unknown_workload',
  'environment_mismatch',
] as const;
export type DeployTokenCallerDeniedReason = (typeof DEPLOY_TOKEN_CALLER_DENIED_REASONS)[number];

/** Non-retryable: the caller gets no deploy token until its identity or policy changes. */
export const DEPLOY_TOKEN_DENIED_REASONS = [
  ...DEPLOY_TOKEN_CALLER_DENIED_REASONS,
  'grant_not_allowed',
] as const;
export type DeployTokenDeniedReason = (typeof DEPLOY_TOKEN_DENIED_REASONS)[number];

/**
 * Retryable after `retryAfterSeconds`: the workload holds its policy's number of unexpired deploy
 * tokens (`too_many_active`), or made its policy's number of mint requests in the last hour
 * (`rate_limited`).
 */
export const DEPLOY_TOKEN_LIMITED_REASONS = ['too_many_active', 'rate_limited'] as const;
export type DeployTokenLimitedReason = (typeof DEPLOY_TOKEN_LIMITED_REASONS)[number];

const RetryAfterSchema = z.number().int().positive().max(3600);

const InvalidRequestSchema = z.strictObject({ status: z.literal('invalid_request') });

const UnavailableSchema = z.strictObject({
  status: z.literal('unavailable'),
  retryAfterSeconds: RetryAfterSchema,
});

const IssuedDeployTokenSchema = z.strictObject({
  status: z.literal('ok'),
  /** The Cloudflare API token, for `CLOUDFLARE_API_TOKEN`; mask it in the job log. */
  token: z.string().min(1),
  tokenId: CloudflareTokenIdSchema,
  expiresAt: z.iso.datetime(),
  ttlSeconds: z.number().int().positive(),
  /** The policy's name for the permission set the token carries. */
  permissionSet: z.string().min(1).max(63),
});
export type IssuedCloudflareDeployToken = z.infer<typeof IssuedDeployTokenSchema>;

export const CloudflareDeployTokenResultSchema = z.discriminatedUnion('status', [
  IssuedDeployTokenSchema,
  z.strictObject({ status: z.literal('denied'), reason: z.enum(DEPLOY_TOKEN_DENIED_REASONS) }),
  z.strictObject({
    status: z.literal('limited'),
    reason: z.enum(DEPLOY_TOKEN_LIMITED_REASONS),
    retryAfterSeconds: RetryAfterSchema,
  }),
  InvalidRequestSchema,
  UnavailableSchema,
]);
export type CloudflareDeployTokenResult = z.infer<typeof CloudflareDeployTokenResultSchema>;

/**
 * `revoked` also answers for the caller's own token that was already deleted. `not_found` answers
 * for a token id STS never issued to this caller's workload and run, another workload's included,
 * so a caller learns nothing about other tokens.
 */
export const CloudflareDeployTokenRevokeResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('revoked'), tokenId: CloudflareTokenIdSchema }),
  z.strictObject({ status: z.literal('not_found') }),
  z.strictObject({
    status: z.literal('denied'),
    reason: z.enum(DEPLOY_TOKEN_CALLER_DENIED_REASONS),
  }),
  InvalidRequestSchema,
  UnavailableSchema,
]);
export type CloudflareDeployTokenRevokeResult = z.infer<
  typeof CloudflareDeployTokenRevokeResultSchema
>;

/**
 * HTTP status of a mint answer: ok 200, invalid_request 400, denied 401 (identity) or 403,
 * limited 429 and unavailable 503, both with `Retry-After`.
 */
export function cloudflareDeployTokenResultHttpStatus(
  result: CloudflareDeployTokenResult
): 200 | 400 | 401 | 403 | 429 | 503 {
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

/** HTTP status of a revoke answer: revoked 200, not_found 404, the rest as for a mint. */
export function cloudflareDeployTokenRevokeResultHttpStatus(
  result: CloudflareDeployTokenRevokeResult
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
