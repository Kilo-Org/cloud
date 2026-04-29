import { z } from 'zod';

import { pushDataSchema } from './push-data';

// ── sendPushForConversation ─────────────────────────────────────────

export const sendPushForConversationInputSchema = z.object({
  conversationId: z.string().min(1),
  sandboxId: z.string().min(1),
  senderUserId: z.string().nullable(),
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
