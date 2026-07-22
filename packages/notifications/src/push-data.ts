import { z } from 'zod';

import { instanceLifecycleEventSchema, scheduledActionEventSchema } from './notification-events';

const nonEmptyStringSchema = z.string().min(1);

// Discriminates between attention-requiring and status-only cloud agent
// session notifications. Optional everywhere it appears so old producers
// in a rolling deploy still validate; the default ('status') is applied
// at the enforcement read site.
export const cloudAgentSessionCategorySchema = z.enum(['attention', 'status']);
export type CloudAgentSessionCategory = z.infer<typeof cloudAgentSessionCategorySchema>;

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
  z.object({
    type: z.literal('cloud_agent_session'),
    cliSessionId: nonEmptyStringSchema,
    category: cloudAgentSessionCategorySchema.optional(),
  }),
]);

export type PushData = z.infer<typeof pushDataSchema>;
