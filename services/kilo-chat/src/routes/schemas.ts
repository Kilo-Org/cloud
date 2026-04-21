import { z } from 'zod';

export const ulidSchema = z.string().ulid();

export const SANDBOX_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const sandboxIdSchema = z.string().regex(SANDBOX_ID_PATTERN, 'Invalid sandboxId');

export const contentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1).max(8000) }),
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
