import { z } from 'zod';
import { OCSF_API_ACTIVITY } from './audit';
import { WorkloadNameSchema, type StsEnvironment } from './bundle';

/**
 * Migration run attestation (design Q64a): the migration proxy sends a GitHub job's raw OIDC token
 * to `SecretsBroker.attestGithubRun` over its STS binding. STS verifies it with the proxy's own
 * audience (`MIGRATION_PROXY_AUDIENCE`), selects the one GitHub policy it matches, requires that
 * policy's `migration-run` grant, and returns the verified claims. The proxy mints nothing.
 */

/** The dynamic grant of a trigger-only policy: its job may start a migration run, nothing else. */
export const MIGRATION_RUN_GRANT = 'migration-run';

/** The props caller of the migration proxy's STS binding, the only one `attestGithubRun` serves. */
export const MIGRATION_PROXY_WORKLOAD = 'migration-proxy';

/** A GitHub OIDC token is a few kilobytes; anything longer is refused before it is decoded. */
export const GITHUB_RUN_ATTESTATION_TOKEN_MAX_LENGTH = 8192;

export const GithubRunAttestationRequestSchema = z.strictObject({
  token: z.string().min(1).max(GITHUB_RUN_ATTESTATION_TOKEN_MAX_LENGTH),
});
export type GithubRunAttestationRequest = z.infer<typeof GithubRunAttestationRequestSchema>;

/** Non-retryable refusals; the proxy maps `identity_rejected` to 401 and the rest to 403. */
export const GITHUB_RUN_ATTESTATION_DENIED_REASONS = [
  'identity_rejected',
  'unknown_workload',
  'environment_mismatch',
  'grant_not_allowed',
  'caller_not_allowed',
] as const;
export type GithubRunAttestationDeniedReason =
  (typeof GITHUB_RUN_ATTESTATION_DENIED_REASONS)[number];

const DecimalIdSchema = z.string().regex(/^[0-9]{1,20}$/);
const ShaSchema = z.string().regex(/^[0-9a-f]{40}$/);

/** The verified claims of the job (contract §5 step 1), each from the token STS checked. */
export const AttestedGithubRunSchema = z.strictObject({
  repositoryId: DecimalIdSchema,
  repositoryOwnerId: DecimalIdSchema,
  environment: z.string().min(1).max(255),
  ref: z.string().min(1).max(255),
  sha: ShaSchema,
  eventName: z.string().min(1).max(64),
  jobWorkflowRef: z.string().min(1).max(512),
  runId: DecimalIdSchema,
  runAttempt: DecimalIdSchema,
});
export type AttestedGithubRun = z.infer<typeof AttestedGithubRunSchema>;

export const GithubRunAttestationResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    workload: WorkloadNameSchema,
    github: AttestedGithubRunSchema,
    /** The token's own expiry. */
    expiresAt: z.iso.datetime(),
  }),
  z.strictObject({
    status: z.literal('denied'),
    reason: z.enum(GITHUB_RUN_ATTESTATION_DENIED_REASONS),
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    retryAfterSeconds: z.number().int().positive().max(3600),
  }),
]);
export type GithubRunAttestationResult = z.infer<typeof GithubRunAttestationResultSchema>;

/** The proxy's audit event types (contract §7), each with its OCSF API Activity id. */
export const MIGRATION_PROXY_AUDIT_TYPES = {
  runStarted: { type: 'ai.kilo.migration_proxy.run_started', activityId: OCSF_API_ACTIVITY.create },
  migrationApplied: {
    type: 'ai.kilo.migration_proxy.migration_applied',
    activityId: OCSF_API_ACTIVITY.update,
  },
  sessionTerminated: {
    type: 'ai.kilo.migration_proxy.session_terminated',
    activityId: OCSF_API_ACTIVITY.delete,
  },
  runFinished: {
    type: 'ai.kilo.migration_proxy.run_finished',
    activityId: OCSF_API_ACTIVITY.other,
  },
  sessionSampled: {
    type: 'ai.kilo.migration_proxy.session_sampled',
    activityId: OCSF_API_ACTIVITY.read,
  },
  runDenied: { type: 'ai.kilo.migration_proxy.run_denied', activityId: OCSF_API_ACTIVITY.create },
  reviewCheckPassed: {
    type: 'ai.kilo.migration_proxy.review_check_passed',
    activityId: OCSF_API_ACTIVITY.read,
  },
  reviewCheckFailed: {
    type: 'ai.kilo.migration_proxy.review_check_failed',
    activityId: OCSF_API_ACTIVITY.read,
  },
} as const;

export type MigrationProxyAuditType =
  (typeof MIGRATION_PROXY_AUDIT_TYPES)[keyof typeof MIGRATION_PROXY_AUDIT_TYPES]['type'];

/** The CloudEvents `source` of the proxy's events in one environment. */
export function migrationProxyAuditSource(environment: StsEnvironment): string {
  return `kilo:${MIGRATION_PROXY_WORKLOAD}:${environment}`;
}

/** The proxy's one audit stream per environment, written from its Durable Object's outbox. */
export function migrationProxyAuditStream(environment: StsEnvironment): string {
  return `${MIGRATION_PROXY_WORKLOAD}:${environment}:runs`;
}
