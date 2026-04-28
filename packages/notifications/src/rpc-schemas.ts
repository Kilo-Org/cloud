import { z } from 'zod';

export const sendPushForConversationInputSchema = z.object({
  conversationId: z.string(),
  sandboxId: z.string(),
  /** null when the sender is a bot. */
  senderUserId: z.string().nullable(),
  recipientUserIds: z.array(z.string()).min(1),
  title: z.string().max(200),
  bodyPreview: z.string().max(200),
  /** Used as part of the per-recipient idempotency key. */
  messageId: z.string(),
});

export type SendPushForConversationInput = z.infer<
  typeof sendPushForConversationInputSchema
>;

export const perRecipientResultSchema = z.object({
  userId: z.string(),
  outcome: z.enum([
    'delivered',
    'suppressed_presence',
    'no_tokens',
    'duplicate',
    'failed',
  ]),
});

export type PerRecipientResult = z.infer<typeof perRecipientResultSchema>;

export const sendPushForConversationOutputSchema = z.object({
  perRecipient: z.array(perRecipientResultSchema),
});

export type SendPushForConversationOutput = z.infer<
  typeof sendPushForConversationOutputSchema
>;
