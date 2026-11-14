import { z } from 'zod';

import {
  instanceLifecycleEventSchema,
  scheduledActionEventSchema,
  securityLifecyclePayloadShape,
} from './notification-events';
import { NEEDS_INPUT_ATTENTION_KINDS } from './needs-input-actions';
import { nonEmptyStringSchema } from './non-empty-string';
import { pushDataSchema, cloudAgentSessionCategorySchema } from './push-data';
import { refineSpendAlertScope, spendAlertScopeShape } from './spend-alert-scope';

// The pre-localized copy a producer may attach to a push.
// Old producers omit these; remove the optionals when every producer sends keys.
const i18nCopyFields = {
  i18nKey: nonEmptyStringSchema.optional(),
  i18nParams: z.record(z.string(), z.string()).optional(),
};

// ── push delivery outcome vocabulary ────────────────────────────────
//
// The suppression and failure states a push dispatch can report. Declared
// once here; each RPC schema below adds only the states its own response can
// carry, so a renamed or new shared state is a single edit.

// Reported by every RPC that sends a push.
const DELIVERY_OUTCOME_REASONS = [
  'suppressed_presence',
  'suppressed_preference',
  'no_tokens',
  'duplicate',
  'failed',
] as const;
type DeliveryOutcomeReason = (typeof DELIVERY_OUTCOME_REASONS)[number];

// Reported by the per-recipient result and the dispatch outcome only. The
// agent-session RPC folds both into `failed`.
const CHANNEL_DELIVERY_OUTCOME_REASONS = ['suppressed_expired', 'suppressed_access'] as const;
type ChannelDeliveryOutcomeReason = (typeof CHANNEL_DELIVERY_OUTCOME_REASONS)[number];

// Discriminated-union members that carry no payload. A generic parameter keeps
// each variant's own `kind` literal so `DispatchPushOutcome` stays discriminated.
function payloadFreeOutcome<
  const K extends
    | Exclude<DeliveryOutcomeReason, 'failed'>
    | ChannelDeliveryOutcomeReason
    | 'suppressed_rate_limit',
>(kind: K) {
  return z.object({ kind: z.literal(kind) });
}

// ── sendPushForConversation ─────────────────────────────────────────

export const sendPushForConversationInputSchema = z.object({
  conversationId: nonEmptyStringSchema,
  sandboxId: nonEmptyStringSchema,
  senderUserId: z.union([nonEmptyStringSchema, z.null()]),
  recipientUserIds: z.array(nonEmptyStringSchema).min(1),
  title: z.string().max(200),
  bodyPreview: z.string().max(200),
  messageId: nonEmptyStringSchema,
  ...i18nCopyFields,
});
export type SendPushForConversationInput = z.infer<typeof sendPushForConversationInputSchema>;

export const perRecipientOutcomeSchema = z.enum([
  'delivered',
  ...DELIVERY_OUTCOME_REASONS,
  ...CHANNEL_DELIVERY_OUTCOME_REASONS,
]);
export type PerRecipientOutcome = z.infer<typeof perRecipientOutcomeSchema>;

export const perRecipientResultSchema = z.object({
  userId: z.string(),
  outcome: perRecipientOutcomeSchema,
  // Stable, content-free failure classification (e.g. 'expo_ticket_rejected'),
  // populated by the internal dispatch path for `failed` outcomes. Optional:
  // older workers and the conversation push path omit it.
  reason: z.string().optional(),
});
export type PerRecipientResult = z.infer<typeof perRecipientResultSchema>;

export const sendPushForConversationOutputSchema = z.object({
  perRecipient: z.array(perRecipientResultSchema),
});
export type SendPushForConversationOutput = z.infer<typeof sendPushForConversationOutputSchema>;

// ── badge HTTP routes ───────────────────────────────────────────────

export const badgeBucketSchema = nonEmptyStringSchema;
export type BadgeBucket = z.infer<typeof badgeBucketSchema>;

export const badgeCountRowSchema = z.object({
  badgeBucket: badgeBucketSchema,
  badgeCount: z.number().int().nonnegative(),
});
export type BadgeCountRow = z.infer<typeof badgeCountRowSchema>;

export const listBadgesResponseSchema = z.object({
  buckets: z.array(badgeCountRowSchema),
});
export type ListBadgesResponse = z.infer<typeof listBadgesResponseSchema>;

export const markBadgeReadInputSchema = z.object({
  badgeBucket: badgeBucketSchema,
});
export type MarkBadgeReadInput = z.infer<typeof markBadgeReadInputSchema>;

export const markBadgeReadResponseSchema = z.object({
  badgeCount: z.number().int().nonnegative(),
});
export type MarkBadgeReadResponse = z.infer<typeof markBadgeReadResponseSchema>;

export const clearBadgeBucketForUserInputSchema = z.object({
  userId: nonEmptyStringSchema,
  badgeBucket: badgeBucketSchema,
});
export type ClearBadgeBucketForUserInput = z.infer<typeof clearBadgeBucketForUserInputSchema>;

export const clearBadgeBucketForUserOutputSchema = markBadgeReadResponseSchema;
export type ClearBadgeBucketForUserOutput = z.infer<typeof clearBadgeBucketForUserOutputSchema>;

// ── sendInstanceLifecycleNotification ───────────────────────────────

export const sendInstanceLifecycleNotificationInputSchema = z.object({
  userId: nonEmptyStringSchema,
  sandboxId: nonEmptyStringSchema,
  event: instanceLifecycleEventSchema,
  instanceName: z.string().nullable(),
  errorMessage: z.string().optional(),
});
export type SendInstanceLifecycleNotificationParams = z.infer<
  typeof sendInstanceLifecycleNotificationInputSchema
>;

// Per-token delivery counters. Both send RPCs report the same tally, so it is
// declared once here and each result adds only the field that RPC owns.
const sendCountersSchema = z.object({
  tokenCount: z.number().int().nonnegative(),
  sent: z.number().int().nonnegative(),
  staleTokens: z.number().int().nonnegative(),
  receiptCount: z.number().int().nonnegative(),
  suppressedByPreference: z.boolean().optional(),
});

export const sendInstanceLifecycleNotificationOutputSchema = sendCountersSchema.extend({
  ticketErrors: z.object({
    total: z.number().int().nonnegative(),
    retryable: z.number().int().nonnegative(),
    terminal: z.number().int().nonnegative(),
  }),
});
export type SendInstanceLifecycleNotificationResult = z.infer<
  typeof sendInstanceLifecycleNotificationOutputSchema
>;

// ── sendScheduledActionNotice ─────────────────────────────────────────

export const sendScheduledActionNoticeInputSchema = z.object({
  userId: nonEmptyStringSchema,
  instanceId: nonEmptyStringSchema,
  sandboxId: nonEmptyStringSchema,
  event: scheduledActionEventSchema,
  instanceName: z.string().nullable(),
  scheduledAt: z.string(),
  targetImageTag: z.string().nullable().optional(),
});
export type SendScheduledActionNoticeParams = z.infer<typeof sendScheduledActionNoticeInputSchema>;

export const sendScheduledActionNoticeOutputSchema = sendCountersSchema;
export type SendScheduledActionNoticeResult = z.infer<typeof sendScheduledActionNoticeOutputSchema>;

// ── sendCloudAgentSessionNotification ───────────────────────────────

export const cloudAgentSessionPushStatusSchema = z.enum(['completed', 'failed', 'interrupted']);
export type CloudAgentSessionPushStatus = z.infer<typeof cloudAgentSessionPushStatusSchema>;

export const sendCloudAgentSessionNotificationInputSchema = z.object({
  userId: nonEmptyStringSchema,
  cliSessionId: nonEmptyStringSchema,
  executionId: nonEmptyStringSchema,
  status: cloudAgentSessionPushStatusSchema,
  body: z.string(),
  suppressIfViewingSession: z.boolean().optional(),
  // Absent category is treated as 'status' at the enforcement read site.
  category: cloudAgentSessionCategorySchema.optional(),
  // Needs-input raise detail: which answer the waiting agent wants, and the PR
  // that can be opened from the notification. Absent on status pushes.
  attentionKind: z.enum(NEEDS_INPUT_ATTENTION_KINDS).optional(),
  prUrl: nonEmptyStringSchema.optional(),
  ...i18nCopyFields,
});
export type SendCloudAgentSessionNotificationParams = z.infer<
  typeof sendCloudAgentSessionNotificationInputSchema
>;

export const sendCloudAgentSessionNotificationOutputSchema = z.object({
  dispatched: z.boolean(),
  reason: z.enum(['missing_session', 'dispatch_failed', 'suppressed_preference']).optional(),
});
export type SendCloudAgentSessionNotificationResult = z.infer<
  typeof sendCloudAgentSessionNotificationOutputSchema
>;

// Aggregate refreshes carry identity only; the server reads current status and scope.
export const refreshGlanceableSessionsInputSchema = z.object({
  userId: nonEmptyStringSchema,
  cliSessionIds: z.array(nonEmptyStringSchema).min(1),
  /**
   * The subset of `cliSessionIds` whose change moved a session into or out of
   * the `permission` status. `needsApproval` gates the Approve control on the
   * locked/background surfaces, so the delivery window may not defer those
   * scopes. The caller is the one that saw the previous status; the server
   * cannot read a past status. Naming the sessions lets the server exempt only
   * the scope that actually moved: one batch can span the personal scope and
   * several organizations, and exempting all of them would wake devices that
   * had no approval change.
   */
  approvalChangedSessionIds: z.array(nonEmptyStringSchema).optional(),
  /**
   * Sessions in `cliSessionIds` whose refresh must not happen unless a session
   * card follows them. The ingest service refreshes the card content after it
   * persists a new summary; a session nobody follows would otherwise pay for a
   * whole snapshot build. The notifications side checks the follow with one
   * indexed read and skips this call when none of the named sessions is
   * followed. Omitting the field keeps the previous behavior.
   */
  cardFollowSessionIds: z.array(nonEmptyStringSchema).optional(),
});
export type RefreshGlanceableSessionsParams = z.infer<typeof refreshGlanceableSessionsInputSchema>;

// ── glanceable scope refresh (POST /internal/v1/glanceable-refresh) ──
//
// Identity only: the notifications worker reads the scope's activity rows and
// builds the snapshot itself. Registering a replacement iOS activity token
// retires the previous live row, and only a refresh sends the retired token its
// `end`, so the web router asks for one at registration instead of waiting for
// the next agent-session transition to drive a delivery pass.

export const glanceableScopeRefreshRequestSchema = z.object({
  userId: nonEmptyStringSchema,
  organizationId: nonEmptyStringSchema.nullable(),
});
export type GlanceableScopeRefreshRequest = z.infer<typeof glanceableScopeRefreshRequestSchema>;

// ── sendSessionReadyNotification ────────────────────────────────────

export const sendSessionReadyNotificationInputSchema = z.object({
  userId: nonEmptyStringSchema,
  cliSessionId: nonEmptyStringSchema,
  title: z.string().optional(),
});
export type SendSessionReadyNotificationParams = z.infer<
  typeof sendSessionReadyNotificationInputSchema
>;

export const sendSessionReadyNotificationOutputSchema =
  sendCloudAgentSessionNotificationOutputSchema;
export type SendSessionReadyNotificationResult = z.infer<
  typeof sendSessionReadyNotificationOutputSchema
>;

// ── sendAgentSessionNotification ────────────────────────────────────
//
// Agent-callable push for an explicit `notify_user` tool call. Resolved
// session-side (no title supplied by callers). Sibling RPC to
// `sendCloudAgentSessionNotification`; intentionally not folded into that
// RPC so the existing completed/failed/interrupted enum stays unchanged.

export const sendAgentSessionNotificationInputSchema = z.object({
  userId: nonEmptyStringSchema,
  cliSessionId: nonEmptyStringSchema,
  notificationId: nonEmptyStringSchema.max(64),
  message: nonEmptyStringSchema.max(500),
});
export type SendAgentSessionNotificationParams = z.infer<
  typeof sendAgentSessionNotificationInputSchema
>;

export const sendAgentSessionNotificationReasonSchema = z.enum([
  'not_found',
  ...DELIVERY_OUTCOME_REASONS,
  'suppressed_rate_limit',
]);
export type SendAgentSessionNotificationReason = z.infer<
  typeof sendAgentSessionNotificationReasonSchema
>;

export const sendAgentSessionNotificationOutputSchema = z.object({
  dispatched: z.boolean(),
  reason: sendAgentSessionNotificationReasonSchema.optional(),
});
export type SendAgentSessionNotificationResult = z.infer<
  typeof sendAgentSessionNotificationOutputSchema
>;

// ── dispatchPush (internal DO RPC) ──────────────────────────────────

export const agentBriefingDispatchWindowSchema = z.object({
  localDate: z.string().date(),
  expiresAt: z.string().datetime(),
});

export const dispatchPushInputSchema = z.object({
  userId: nonEmptyStringSchema,
  presenceContext: nonEmptyStringSchema.nullable(),
  idempotencyKey: nonEmptyStringSchema,
  agentBriefing: agentBriefingDispatchWindowSchema.optional(),
  badge: z
    .object({
      badgeBucket: badgeBucketSchema,
      delta: z.number().int(),
    })
    .nullable(),
  push: z.object({
    title: z.string(),
    body: z.string(),
    data: pushDataSchema,
    sound: z.union([z.literal('default'), z.null()]).optional(),
    priority: z.enum(['default', 'high']).optional(),
    ...i18nCopyFields,
  }),
  // Optional per-call rate limit (sliding window). When set, the DO checks
  // the sliding window after idempotency/presence and before the Expo send;
  // an attempt that fails the check returns `suppressed_rate_limit` and
  // records its idempotency key with that outcome so replays dedup.
  rateLimit: z
    .object({
      key: nonEmptyStringSchema,
      limit: z.number().int().positive(),
      windowSeconds: z.number().int().positive(),
    })
    .optional(),
});
export type DispatchPushInput = z.infer<typeof dispatchPushInputSchema>;

export const dispatchPushOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('delivered'), tokenCount: z.number().int().nonnegative() }),
  payloadFreeOutcome('suppressed_presence'),
  payloadFreeOutcome('suppressed_rate_limit'),
  payloadFreeOutcome('suppressed_preference'),
  payloadFreeOutcome('suppressed_expired'),
  payloadFreeOutcome('suppressed_access'),
  payloadFreeOutcome('no_tokens'),
  payloadFreeOutcome('duplicate'),
  z.object({ kind: z.literal('failed'), error: z.string() }),
]);
export type DispatchPushOutcome = z.infer<typeof dispatchPushOutcomeSchema>;

// ── internal dispatch (POST /internal/v1/dispatch) ─────────────────

export const internalDispatchLowBalanceRequestSchema = z.object({
  kind: z.literal('low_balance'),
  recipientUserIds: z.array(nonEmptyStringSchema).min(1),
  organizationId: nonEmptyStringSchema,
  organizationName: nonEmptyStringSchema,
  minimumBalanceUsd: z.number().nonnegative(),
});
export type InternalDispatchLowBalanceRequest = z.infer<
  typeof internalDispatchLowBalanceRequestSchema
>;

/**
 * Spend-alert dispatch. `organizationId` is present only for an
 * `organization` scope; a `personal` scope carries the user's own spend and
 * nothing else. The dispatcher builds the push destination from these two
 * fields, so a scope and an id that disagree would route the tap to the wrong
 * spend view; the refinement refuses that before a push exists. `dedupeKey` is
 * the outbox row's identity, which carries the firing episode: it joins the
 * idempotency key alongside the alert kind and threshold, so a condition that
 * clears and crosses again inside the channel's idempotency window is a new
 * alert rather than a collapsed duplicate.
 */
export const internalDispatchSpendAlertRequestSchema = z
  .object({
    kind: z.literal('spend_alert'),
    recipientUserIds: z.array(nonEmptyStringSchema).min(1),
    ...spendAlertScopeShape,
    alertKind: z.enum(['threshold', 'anomaly']),
    scopeName: nonEmptyStringSchema,
    amountUsd: z.number().nonnegative(),
    thresholdUsd: z.number().nonnegative(),
    dedupeKey: nonEmptyStringSchema,
  })
  .superRefine(refineSpendAlertScope);
export type InternalDispatchSpendAlertRequest = z.infer<
  typeof internalDispatchSpendAlertRequestSchema
>;

export const internalDispatchSecurityFindingRequestSchema = z.object({
  kind: z.literal('security_finding'),
  recipientUserId: nonEmptyStringSchema,
  notificationId: nonEmptyStringSchema,
  findingId: nonEmptyStringSchema,
  scope: nonEmptyStringSchema,
  notificationKind: z.enum(['new_finding', 'sla_warning', 'sla_breach']),
  severity: nonEmptyStringSchema,
  repoFullName: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  ghsaId: nonEmptyStringSchema.nullable().optional(),
});
export type InternalDispatchSecurityFindingRequest = z.infer<
  typeof internalDispatchSecurityFindingRequestSchema
>;

// The event vocabulary is the shared schema from `notification-events.ts`
// (the same one the `security_lifecycle` push variant in `push-data.ts`
// uses); it is exported to package consumers from `notification-events`.

export const internalDispatchSecurityLifecycleRequestSchema = z.object({
  kind: z.literal('security_lifecycle'),
  ...securityLifecyclePayloadShape,
  recipientUserIds: z.array(nonEmptyStringSchema).min(1),
});
export type InternalDispatchSecurityLifecycleRequest = z.infer<
  typeof internalDispatchSecurityLifecycleRequestSchema
>;

export const internalDispatchAgentBriefingRequestSchema = agentBriefingDispatchWindowSchema.extend({
  kind: z.literal('agent_briefing'),
  userId: nonEmptyStringSchema,
});
export type InternalDispatchAgentBriefingRequest = z.infer<
  typeof internalDispatchAgentBriefingRequestSchema
>;

export const internalDispatchRequestSchema = z.discriminatedUnion('kind', [
  internalDispatchLowBalanceRequestSchema,
  internalDispatchSpendAlertRequestSchema,
  internalDispatchSecurityFindingRequestSchema,
  internalDispatchSecurityLifecycleRequestSchema,
  internalDispatchAgentBriefingRequestSchema,
]);
export type InternalDispatchRequest = z.infer<typeof internalDispatchRequestSchema>;
