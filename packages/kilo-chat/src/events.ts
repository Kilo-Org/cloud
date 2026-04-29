import { z } from 'zod';
import { contentBlockSchema } from './schemas';

// ── Per-event payload schemas ───────────────────────────────────────

export const messageCreatedEventSchema = z.object({
  messageId: z.string(),
  senderId: z.string(),
  content: z.array(contentBlockSchema),
  inReplyToMessageId: z.string().nullable(),
  clientId: z.string().nullable(),
});

export const messageUpdatedEventSchema = z.object({
  messageId: z.string(),
  content: z.array(contentBlockSchema),
  clientUpdatedAt: z.number().nullable(),
});

export const messageDeletedEventSchema = z.object({
  messageId: z.string(),
});

export const messageDeliveryFailedEventSchema = z.object({
  messageId: z.string(),
});

export const typingEventSchema = z.object({
  memberId: z.string(),
});

export const reactionAddedEventSchema = z.object({
  messageId: z.string(),
  memberId: z.string(),
  emoji: z.string(),
});

export const reactionRemovedEventSchema = z.object({
  messageId: z.string(),
  memberId: z.string(),
  emoji: z.string(),
});

export const conversationCreatedEventSchema = z.object({
  conversationId: z.string(),
});

export const conversationRenamedEventSchema = z.object({
  conversationId: z.string(),
  title: z.string(),
});

export const conversationLeftEventSchema = z.object({
  conversationId: z.string(),
});

export const conversationReadEventSchema = z.object({
  conversationId: z.string(),
  memberId: z.string(),
  lastReadAt: z.number(),
});

export const conversationActivityEventSchema = z.object({
  conversationId: z.string(),
  lastActivityAt: z.number(),
});

export const actionExecutedEventSchema = z.object({
  conversationId: z.string(),
  messageId: z.string(),
  groupId: z.string(),
  value: z.string(),
  executedBy: z.string(),
});

export const actionDeliveryFailedEventSchema = z.object({
  conversationId: z.string(),
  messageId: z.string(),
  groupId: z.string(),
});

export const botStatusEventSchema = z.object({
  sandboxId: z.string(),
  online: z.boolean(),
  at: z.number(),
});

export const conversationStatusEventSchema = z.object({
  conversationId: z.string(),
  contextTokens: z.number(),
  contextWindow: z.number(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  at: z.number(),
});

// ── Discriminated union keyed on `event` literal ────────────────────

export const kiloChatEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('message.created'), payload: messageCreatedEventSchema }),
  z.object({ event: z.literal('message.updated'), payload: messageUpdatedEventSchema }),
  z.object({ event: z.literal('message.deleted'), payload: messageDeletedEventSchema }),
  z.object({
    event: z.literal('message.delivery_failed'),
    payload: messageDeliveryFailedEventSchema,
  }),
  z.object({ event: z.literal('typing'), payload: typingEventSchema }),
  z.object({ event: z.literal('typing.stop'), payload: typingEventSchema }),
  z.object({ event: z.literal('reaction.added'), payload: reactionAddedEventSchema }),
  z.object({ event: z.literal('reaction.removed'), payload: reactionRemovedEventSchema }),
  z.object({ event: z.literal('conversation.created'), payload: conversationCreatedEventSchema }),
  z.object({ event: z.literal('conversation.renamed'), payload: conversationRenamedEventSchema }),
  z.object({ event: z.literal('conversation.left'), payload: conversationLeftEventSchema }),
  z.object({ event: z.literal('conversation.read'), payload: conversationReadEventSchema }),
  z.object({ event: z.literal('conversation.activity'), payload: conversationActivityEventSchema }),
  z.object({ event: z.literal('action.executed'), payload: actionExecutedEventSchema }),
  z.object({
    event: z.literal('action.delivery_failed'),
    payload: actionDeliveryFailedEventSchema,
  }),
  z.object({ event: z.literal('bot.status'), payload: botStatusEventSchema }),
  z.object({
    event: z.literal('conversation.status'),
    payload: conversationStatusEventSchema,
  }),
]);

export type KiloChatEvent = z.infer<typeof kiloChatEventSchema>;
export type KiloChatEventName = KiloChatEvent['event'];

export type KiloChatEventOf<N extends KiloChatEventName> = Extract<
  KiloChatEvent,
  { event: N }
>['payload'];

// Per-event payload schemas keyed by event name, so callers can look up a
// payload-only validator for a specific event without needing a cast.
const payloadSchemaRegistry: { [K in KiloChatEventName]: z.ZodType<KiloChatEventOf<K>> } = {
  'message.created': messageCreatedEventSchema,
  'message.updated': messageUpdatedEventSchema,
  'message.deleted': messageDeletedEventSchema,
  'message.delivery_failed': messageDeliveryFailedEventSchema,
  typing: typingEventSchema,
  'typing.stop': typingEventSchema,
  'reaction.added': reactionAddedEventSchema,
  'reaction.removed': reactionRemovedEventSchema,
  'conversation.created': conversationCreatedEventSchema,
  'conversation.renamed': conversationRenamedEventSchema,
  'conversation.left': conversationLeftEventSchema,
  'conversation.read': conversationReadEventSchema,
  'conversation.activity': conversationActivityEventSchema,
  'action.executed': actionExecutedEventSchema,
  'action.delivery_failed': actionDeliveryFailedEventSchema,
  'bot.status': botStatusEventSchema,
  'conversation.status': conversationStatusEventSchema,
};

export function getKiloChatEventPayloadSchema<N extends KiloChatEventName>(
  event: N
): z.ZodType<KiloChatEventOf<N>> {
  return payloadSchemaRegistry[event];
}
