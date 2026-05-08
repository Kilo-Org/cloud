import { z } from 'zod';

import {
  instanceLifecycleEventSchema,
  scheduledActionEventSchema,
  type InstanceLifecycleEvent,
  type ScheduledActionEvent,
} from './notification-events';
import { pushDataSchema } from './push-data';

export {
  instanceLifecycleEventSchema,
  scheduledActionEventSchema,
  type InstanceLifecycleEvent,
  type ScheduledActionEvent,
};

// ── sendPushForConversation ─────────────────────────────────────────

export const sendPushForConversationInputSchema = z.object({
  conversationId: z.string().min(1),
  sandboxId: z.string().min(1),
  senderUserId: z.union([z.string().min(1), z.null()]),
  recipientUserIds: z.array(z.string().min(1)).min(1),
  title: z.string().max(200),
  bodyPreview: z.string().max(200),
  messageId: z.string().min(1),
});
export type SendPushForConversationInput = z.infer<typeof sendPushForConversationInputSchema>;

export const perRecipientOutcomeSchema = z.enum([
  'delivered',
  'suppressed_presence',
  'no_tokens',
  'duplicate',
  'failed',
]);
export type PerRecipientOutcome = z.infer<typeof perRecipientOutcomeSchema>;

export const perRecipientResultSchema = z.object({
  userId: z.string(),
  outcome: perRecipientOutcomeSchema,
});
export type PerRecipientResult = z.infer<typeof perRecipientResultSchema>;

export const sendPushForConversationOutputSchema = z.object({
  perRecipient: z.array(perRecipientResultSchema),
});
export type SendPushForConversationOutput = z.infer<typeof sendPushForConversationOutputSchema>;

// ── badge HTTP routes ───────────────────────────────────────────────

export const badgeBucketSchema = z.string().min(1);
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
  userId: z.string().min(1),
  badgeBucket: badgeBucketSchema,
});
export type ClearBadgeBucketForUserInput = z.infer<typeof clearBadgeBucketForUserInputSchema>;

export const clearBadgeBucketForUserOutputSchema = markBadgeReadResponseSchema;
export type ClearBadgeBucketForUserOutput = z.infer<typeof clearBadgeBucketForUserOutputSchema>;

// ── sendInstanceLifecycleNotification ───────────────────────────────

export const sendInstanceLifecycleNotificationInputSchema = z.object({
  userId: z.string().min(1),
  sandboxId: z.string().min(1),
  event: instanceLifecycleEventSchema,
  instanceName: z.string().nullable(),
  errorMessage: z.string().optional(),
});
export type SendInstanceLifecycleNotificationParams = z.infer<
  typeof sendInstanceLifecycleNotificationInputSchema
>;

export const sendInstanceLifecycleNotificationOutputSchema = z.object({
  tokenCount: z.number().int().nonnegative(),
  sent: z.number().int().nonnegative(),
  staleTokens: z.number().int().nonnegative(),
  receiptCount: z.number().int().nonnegative(),
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
  userId: z.string().min(1),
  instanceId: z.string().min(1),
  sandboxId: z.string().min(1),
  event: scheduledActionEventSchema,
  instanceName: z.string().nullable(),
  scheduledAt: z.string(),
  targetImageTag: z.string().nullable().optional(),
});
export type SendScheduledActionNoticeParams = z.infer<typeof sendScheduledActionNoticeInputSchema>;

export const sendScheduledActionNoticeOutputSchema = z.object({
  tokenCount: z.number().int().nonnegative(),
  sent: z.number().int().nonnegative(),
  staleTokens: z.number().int().nonnegative(),
  receiptCount: z.number().int().nonnegative(),
});
export type SendScheduledActionNoticeResult = z.infer<typeof sendScheduledActionNoticeOutputSchema>;

// ── dispatchPush (internal DO RPC) ──────────────────────────────────

export const dispatchPushInputSchema = z.object({
  userId: z.string().min(1),
  presenceContext: z.string().min(1),
  idempotencyKey: z.string().min(1),
  badge: z
    .object({
      badgeBucket: z.string().min(1),
      delta: z.number().int(),
    })
    .nullable(),
  push: z.object({
    title: z.string(),
    body: z.string(),
    data: pushDataSchema,
    sound: z.union([z.literal('default'), z.null()]).optional(),
    priority: z.enum(['default', 'high']).optional(),
  }),
});
export type DispatchPushInput = z.infer<typeof dispatchPushInputSchema>;

export const dispatchPushOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('delivered'), tokenCount: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('suppressed_presence') }),
  z.object({ kind: z.literal('no_tokens') }),
  z.object({ kind: z.literal('duplicate') }),
  z.object({ kind: z.literal('failed'), error: z.string() }),
]);
export type DispatchPushOutcome = z.infer<typeof dispatchPushOutcomeSchema>;
