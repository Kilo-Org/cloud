import { z } from 'zod';

import { instanceLifecycleEventSchema, scheduledActionEventSchema } from './notification-events';

const nonEmptyStringSchema = z.string().min(1);

// Discriminates between attention-requiring and status-only cloud agent
// session notifications. Optional everywhere it appears so old producers
// in a rolling deploy still validate; the default ('status') is applied
// at the enforcement read site.
export const cloudAgentSessionCategorySchema = z.enum(['attention', 'status']);
export type CloudAgentSessionCategory = z.infer<typeof cloudAgentSessionCategorySchema>;

/**
 * Schema for the `data` blob attached to Expo push notifications.
 * This crosses the OS boundary as untyped JSON, so it MUST be
 * Zod-parsed by the mobile notification handler before use.
 */
export const pushDataSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('chat.message'),
    sandboxId: nonEmptyStringSchema,
    conversationId: nonEmptyStringSchema,
    messageId: nonEmptyStringSchema,
  }),
  z.object({
    type: z.literal('instance-lifecycle'),
    event: instanceLifecycleEventSchema,
    sandboxId: z.string().min(1),
  }),
  z.object({
    type: z.literal('scheduled-action'),
    event: scheduledActionEventSchema,
    sandboxId: z.string().min(1),
  }),
  z.object({
    type: z.literal('cloud_agent_session'),
    cliSessionId: nonEmptyStringSchema,
    category: cloudAgentSessionCategorySchema.optional(),
  }),
  z.object({
    type: z.literal('low_balance'),
    organizationId: nonEmptyStringSchema,
  }),
  z.object({
    type: z.literal('security_finding'),
    findingId: nonEmptyStringSchema,
    scope: nonEmptyStringSchema,
  }),
  // 1:1 map to SecurityAuditLogAction (packages/db/src/schema-types.ts):
  // analysis_completed -> FindingAnalysisCompleted,
  // analysis_failed -> FindingAnalysisFailed,
  // remediation_queued -> RemediationQueued,
  // remediation_pr_opened -> RemediationPrOpened,
  // remediation_failed -> RemediationFailed,
  // remediation_blocked -> RemediationBlocked,
  // remediation_no_changes_needed -> RemediationNoChangesNeeded,
  // remediation_cancelled -> RemediationCancelled.
  // FindingCreated is intentionally unmapped: finding creation already sends
  // the visible `security_finding` push, so a second visible push would
  // double-notify.
  z.object({
    type: z.literal('security_lifecycle'),
    event: z.enum([
      'analysis_completed',
      'analysis_failed',
      'remediation_queued',
      'remediation_pr_opened',
      'remediation_failed',
      'remediation_blocked',
      'remediation_no_changes_needed',
      'remediation_cancelled',
    ]),
    findingId: nonEmptyStringSchema,
    scope: nonEmptyStringSchema,
    remediationId: nonEmptyStringSchema.optional(),
    prUrl: nonEmptyStringSchema.optional(),
  }),
  // Aggregate glanceable snapshot for the Active Agents Live Activity / widget
  // / Android ongoing. Carries generic status, counts, safe timestamps, and an
  // opaque scope key only — no titles, ids, or accountEpoch (the client sets
  // its local epoch). `status` mirrors the shared glanceable status enum.
  // Old clients omit this type; remove the send gate when every client is past
  // this release.
  z.object({
    type: z.literal('active_agents_glanceable'),
    schemaVersion: z.literal(1),
    revision: z.number().int().min(1),
    scopeKey: nonEmptyStringSchema,
    organizationBound: z.boolean(),
    status: z.enum(['waiting', 'empty', 'happy', 'stale', 'expired', 'signed_out', 'privacy']),
    running: z.number().int().min(0),
    needsInput: z.number().int().min(0),
    reconnecting: z.number().int().min(0),
    updatedAt: z.string(),
    expiresAt: z.string(),
    eligibleStartedAt: z.string().nullable(),
  }),
]);

export type PushData = z.infer<typeof pushDataSchema>;
