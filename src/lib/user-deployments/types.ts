import * as z from 'zod';
import { buildStatusSchema } from '@kilocode/db/schema-types';
import type { BuildStatus } from '@kilocode/db/schema-types';
export { providerSchema, buildStatusSchema } from '@kilocode/db/schema-types';
export type { Provider, BuildStatus } from '@kilocode/db/schema-types';

// Source configuration types for deployments
export type GitSource = {
  type: 'git';
  gitUrl: string;
  authToken?: string;
};

export type AppBuilderSource = {
  type: 'app-builder';
  gitUrl: string;
};

export type GitHubSource = {
  type: 'github';
  platformIntegrationId: string;
  repositoryFullName: string;
};

export type DeploymentSource = GitSource | AppBuilderSource | GitHubSource;

/**
 * Zod schema for log event payload
 */
export const logPayloadSchema = z.object({
  message: z.string(),
});

/**
 * Log payload type inferred from schema
 */
export type LogPayload = z.infer<typeof logPayloadSchema>;

/**
 * Zod schema for status change event payload
 */
export const statusChangePayloadSchema = z.object({
  status: buildStatusSchema,
});

/**
 * Status change payload type inferred from schema
 */
export type StatusChangePayload = z.infer<typeof statusChangePayloadSchema>;

/**
 * Zod schema for events using discriminated union
 */
export const eventSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.number().int().nonnegative(),
    // TODO: add date validation
    ts: z.string(),
    type: z.literal('log'),
    payload: logPayloadSchema,
  }),
  z.object({
    id: z.number().int().nonnegative(),
    ts: z.string(),
    type: z.literal('status_change'),
    payload: statusChangePayloadSchema,
  }),
]);

/**
 * Event type inferred from schema
 */
export type Event = z.infer<typeof eventSchema>;

/**
 * Zod schema for webhook payload
 */
export const webhookPayloadSchema = z.object({
  buildId: z.string().uuid(),
  events: z.array(eventSchema),
});

/**
 * Webhook payload type inferred from schema
 */
export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;

/**
 * Check if a deployment build is currently in progress (building, queued, or deploying)
 */
export function isDeploymentInProgress(status: BuildStatus | null | undefined): boolean {
  if (!status) return false;
  return status === 'building' || status === 'queued' || status === 'deploying';
}

/**
 * Check if a deployment build has completed successfully
 */
export function isDeploymentCompleted(status: BuildStatus | null | undefined): boolean {
  return status === 'deployed';
}

/**
 * Check if a deployment build has failed
 */
export function isDeploymentFailed(status: BuildStatus | null | undefined): boolean {
  return status === 'failed';
}

/**
 * Check if a deployment build was cancelled
 */
export function isDeploymentCancelled(status: BuildStatus | null | undefined): boolean {
  return status === 'cancelled';
}

/**
 * Check if a deployment build is in a final state (deployed, failed, or cancelled)
 */
export function isDeploymentFinished(status: BuildStatus | null | undefined): boolean {
  return (
    isDeploymentCompleted(status) || isDeploymentFailed(status) || isDeploymentCancelled(status)
  );
}

/**
 * Cancel build reason enum
 */
export type CancelBuildReason = 'cancelled' | 'not_found' | 'already_finished';

/**
 * Cancel build result
 */
export type CancelBuildResult = {
  cancelled: boolean;
  reason: CancelBuildReason;
  /** Present when reason is 'already_finished' */
  status?: BuildStatus;
};
