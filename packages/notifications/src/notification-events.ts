import { z } from 'zod';

import { nonEmptyStringSchema } from './non-empty-string';

export const instanceLifecycleEventSchema = z.enum(['ready', 'start_failed']);
export type InstanceLifecycleEvent = z.infer<typeof instanceLifecycleEventSchema>;

export const scheduledActionEventSchema = z.enum([
  'scheduled_restart_notice',
  'scheduled_restart_cancelled',
  'scheduled_version_change_notice',
  'scheduled_version_change_cancelled',
]);
export type ScheduledActionEvent = z.infer<typeof scheduledActionEventSchema>;

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
export const SECURITY_LIFECYCLE_EVENTS = [
  'analysis_completed',
  'analysis_failed',
  'remediation_queued',
  'remediation_pr_opened',
  'remediation_failed',
  'remediation_blocked',
  'remediation_no_changes_needed',
  'remediation_cancelled',
] as const;

export const securityLifecycleEventSchema = z.enum(SECURITY_LIFECYCLE_EVENTS);
export type SecurityLifecycleEvent = z.infer<typeof securityLifecycleEventSchema>;

// The payload one security-lifecycle event carries, whatever envelope transports
// it: the visible push in `push-data.ts` and the internal dispatch request in
// `rpc-schemas.ts` differ only by their envelope (`type` vs `kind` plus
// `recipientUserIds`). Declared once so a field cannot be added to one path and
// silently dropped by the other.
export const securityLifecyclePayloadShape = {
  event: securityLifecycleEventSchema,
  findingId: nonEmptyStringSchema,
  scope: nonEmptyStringSchema,
  remediationId: nonEmptyStringSchema.optional(),
  prUrl: nonEmptyStringSchema.optional(),
};
