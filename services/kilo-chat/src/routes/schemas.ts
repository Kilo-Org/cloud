import { z } from 'zod';

export const ulidSchema = z.string().ulid();

export const SANDBOX_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const sandboxIdSchema = z.string().regex(SANDBOX_ID_PATTERN, 'Invalid sandboxId');

const actionItemSchema = z.object({
  label: z.string().min(1).max(200),
  style: z.enum(['primary', 'danger', 'secondary']),
  value: z.string().min(1).max(200),
});

const actionsBlockSchema = z.object({
  type: z.literal('actions'),
  groupId: z.string().min(1).max(200),
  actions: z.array(actionItemSchema).min(1).max(10),
  resolved: z
    .object({
      value: z.string(),
      resolvedBy: z.string(),
      resolvedAt: z.number(),
    })
    .optional(),
});

export const contentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1).max(8000) }),
  actionsBlockSchema,
]);

export const createMessageSchema = z.object({
  conversationId: ulidSchema,
  content: z.array(contentBlockSchema).min(1).max(20),
  inReplyToMessageId: ulidSchema.optional(),
  clientId: ulidSchema.optional(),
});

export const editMessageSchema = z.object({
  conversationId: ulidSchema,
  content: z.array(contentBlockSchema).min(1).max(20),
  timestamp: z.number().int().positive(),
});

// 1-64 bytes UTF-8, no C0 (0x00-0x1F) or C1 (0x7F-0x9F) control chars.
export const emojiSchema = z
  .string()
  .min(1, 'emoji required')
  .refine(v => new TextEncoder().encode(v).length <= 64, { message: 'emoji too long' })
  .refine(
    v => {
      for (let i = 0; i < v.length; i++) {
        const c = v.charCodeAt(i);
        if ((c >= 0x00 && c <= 0x1f) || (c >= 0x7f && c <= 0x9f)) return false;
      }
      return true;
    },
    { message: 'emoji contains control chars' }
  );

export const reactionBodySchema = z.object({
  conversationId: ulidSchema,
  emoji: emojiSchema,
});

export const renameConversationSchema = z.object({
  title: z.string().min(1).max(200),
});

export const executeActionSchema = z.object({
  groupId: z.string().min(1).max(200),
  value: z.string().min(1).max(200),
});

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const listMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: ulidSchema.optional(),
});

export const createBotConversationSchema = z.object({
  title: z.string().max(200).optional(),
  additionalMembers: z.array(z.string().min(1)).max(20).optional(),
});
