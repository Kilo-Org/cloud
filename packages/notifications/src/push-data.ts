import { z } from 'zod';

/**
 * Schema for the `data` blob attached to Expo push notifications.
 * This crosses the OS boundary as untyped JSON, so it MUST be
 * Zod-parsed by the mobile notification handler before use.
 */
export const pushDataSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('chat.message'),
    sandboxId: z.string(),
    conversationId: z.string(),
    messageId: z.string(),
  }),
  z.object({
    type: z.literal('instance-lifecycle'),
    event: z.enum(['ready', 'start_failed']),
    sandboxId: z.string().min(1),
  }),
]);

export type PushData = z.infer<typeof pushDataSchema>;
