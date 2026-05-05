import { z } from 'zod';

const nonEmptyStringSchema = z.string().min(1);

/**
 * Schema for the `data` blob attached to Expo push notifications.
 * This crosses the OS boundary as untyped JSON, so it MUST be
 * Zod-parsed by the mobile notification handler before use.
 */
export const pushDataSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('chat.message'),
    sandboxId: nonEmptyStringSchema,
    conversationId: nonEmptyStringSchema,
    messageId: nonEmptyStringSchema,
  }),
  z.object({
    type: z.literal('instance-lifecycle'),
    event: z.enum(['ready', 'start_failed']),
    sandboxId: z.string().min(1),
  }),
  z.object({
    type: z.literal('scheduled-action'),
    event: z.enum([
      'scheduled_restart_notice',
      'scheduled_restart_cancelled',
      'scheduled_version_change_notice',
      'scheduled_version_change_cancelled',
    ]),
    sandboxId: z.string().min(1),
  }),
]);

export type PushData = z.infer<typeof pushDataSchema>;
