import { z } from 'zod';

import { execApprovalDecisionSchema } from './schemas';

// ── Inbound webhook payloads (kilo-chat → kiloclaw plugin) ──────────

export const messageCreatedWebhookSchema = z.object({
  type: z.literal('message.created'),
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
  from: z.string().min(1),
  text: z.string().min(1),
  sentAt: z.string().datetime(),
  inReplyToMessageId: z.string().min(1).optional(),
  inReplyToBody: z.string().min(1).optional(),
  inReplyToSender: z.string().min(1).optional(),
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

export const chatWebhookSchema = z.discriminatedUnion('type', [
  messageCreatedWebhookSchema,
  actionExecutedWebhookSchema,
]);

export const chatWebhookRpcSchema = z.discriminatedUnion('type', [
  messageCreatedWebhookSchema.extend({ targetBotId: z.string().min(1) }),
  actionExecutedWebhookSchema.extend({ targetBotId: z.string().min(1) }),
]);
