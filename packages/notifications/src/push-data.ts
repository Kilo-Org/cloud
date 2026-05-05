import { z } from 'zod';

import { instanceLifecycleEventSchema, scheduledActionEventSchema } from './notification-events';

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
    event: instanceLifecycleEventSchema,
    sandboxId: z.string().min(1),
  }),
  z.object({
    type: z.literal('scheduled-action'),
    event: scheduledActionEventSchema,
    sandboxId: z.string().min(1),
  }),
]);

export type PushData = z.infer<typeof pushDataSchema>;
