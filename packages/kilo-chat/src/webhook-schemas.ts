import { z } from 'zod';

import { attachmentMetadataSchema, execApprovalDecisionSchema } from './schemas';

// ── Inbound webhook payloads (kilo-chat → kiloclaw plugin) ──────────

export const messageCreatedWebhookSchema = z
  .object({
    type: z.literal('message.created'),
    conversationId: z.string().min(1),
    messageId: z.string().min(1),
    from: z.string().min(1),
    text: z.string(),
    sentAt: z.string().datetime(),
    inReplyToMessageId: z.string().min(1).optional(),
    inReplyToBody: z.string().min(1).optional(),
    inReplyToSender: z.string().min(1).optional(),
    attachments: z.array(attachmentMetadataSchema).max(10).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.text.length === 0 && (data.attachments?.length ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'text must be non-empty when no attachments are present',
        path: ['text'],
      });
    }
  });

export const actionExecutedWebhookSchema = z.object({
  type: z.literal('action.executed'),
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
  groupId: z.string().min(1),
  value: execApprovalDecisionSchema,
  executedBy: z.string().min(1),
  executedAt: z.string().min(1),
});

// Sent when a subscribed client polls for bot status. The plugin replies by
// POSTing the current heartbeat back via `sendBotStatus`. No payload fields —
// `sandboxId` is carried by the rpc-level `targetBotId`.
export const botStatusRequestWebhookSchema = z.object({
  type: z.literal('bot.status_request'),
});

export const chatWebhookSchema = z.discriminatedUnion('type', [
  messageCreatedWebhookSchema,
  actionExecutedWebhookSchema,
  botStatusRequestWebhookSchema,
]);

export const chatWebhookRpcSchema = z.discriminatedUnion('type', [
  messageCreatedWebhookSchema.extend({ targetBotId: z.string().min(1) }),
  actionExecutedWebhookSchema.extend({ targetBotId: z.string().min(1) }),
  botStatusRequestWebhookSchema.extend({ targetBotId: z.string().min(1) }),
]);
