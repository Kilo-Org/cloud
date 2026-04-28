import { z } from 'zod';

/**
 * Shape of the `data` field on an Expo push notification. Parsed on the mobile
 * side when the notification is delivered or tapped (untyped JSON crossing the
 * OS boundary). Server-side this is a typechecked literal — no runtime parse.
 */
export const pushDataSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('chat.message'),
    sandboxId: z.string(),
    conversationId: z.string(),
    messageId: z.string(),
  }),
]);

export type PushData = z.infer<typeof pushDataSchema>;
