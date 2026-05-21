import { z } from 'zod';
import {
  actionGroupIdSchema,
  capabilitySchema,
  conversationListItemSchema,
  conversationTitleSchema,
  contentBlockSchema,
  emojiSchema,
  execApprovalDecisionSchema,
  nonEmptyStringSchema,
  nonNegativeIntegerSchema,
  replyToMessageSnapshotSchema,
  sandboxIdSchema,
  ulidSchema,
} from './schemas';

// ── Per-event payload schemas ───────────────────────────────────────

export const messageCreatedEventSchema = z.object({
  messageId: ulidSchema,
  senderId: nonEmptyStringSchema,
  content: z.array(contentBlockSchema),
  inReplyToMessageId: ulidSchema.nullable(),
  replyTo: replyToMessageSnapshotSchema.nullable(),
  clientId: ulidSchema.nullable(),
});

export const messageUpdatedEventSchema = z.object({
  messageId: ulidSchema,
  content: z.array(contentBlockSchema),
  clientUpdatedAt: nonNegativeIntegerSchema.nullable(),
});

export const messageDeletedEventSchema = z.object({
  messageId: ulidSchema,
});

export const messageDeliveryFailedEventSchema = z.object({
  messageId: ulidSchema,
});

export const typingEventSchema = z.object({
  memberId: nonEmptyStringSchema,
});

export const reactionAddedEventSchema = z.object({
  messageId: ulidSchema,
  operationId: ulidSchema,
  memberId: nonEmptyStringSchema,
  emoji: emojiSchema,
});

export const reactionRemovedEventSchema = z.object({
  messageId: ulidSchema,
  operationId: ulidSchema,
  memberId: nonEmptyStringSchema,
  emoji: emojiSchema,
});

export const conversationCreatedEventSchema = z
  .object({
    conversationId: ulidSchema,
    conversation: conversationListItemSchema,
  })
  .refine(event => event.conversation.conversationId === event.conversationId);

export const conversationRenamedEventSchema = z.object({
  conversationId: ulidSchema,
  title: conversationTitleSchema,
});

export const conversationLeftEventSchema = z.object({
  conversationId: ulidSchema,
});

export const conversationReadEventSchema = z.object({
  conversationId: ulidSchema,
  memberId: nonEmptyStringSchema,
  lastReadAt: nonNegativeIntegerSchema,
});

export const conversationActivityEventSchema = z.object({
  conversationId: ulidSchema,
  lastActivityAt: nonNegativeIntegerSchema,
});

export const actionExecutedEventSchema = z.object({
  conversationId: ulidSchema,
  messageId: ulidSchema,
  groupId: actionGroupIdSchema,
  value: execApprovalDecisionSchema,
  executedBy: nonEmptyStringSchema,
});

export const actionDeliveryFailedEventSchema = z.object({
  conversationId: ulidSchema,
  messageId: ulidSchema,
  groupId: actionGroupIdSchema,
});

export const botStatusEventSchema = z.object({
  sandboxId: sandboxIdSchema,
  online: z.boolean(),
  at: nonNegativeIntegerSchema,
  capabilities: z.array(capabilitySchema).optional(),
});

export const conversationStatusEventSchema = z.object({
  conversationId: ulidSchema,
  contextTokens: nonNegativeIntegerSchema,
  contextWindow: nonNegativeIntegerSchema,
  model: z.string().nullable(),
  provider: z.string().nullable(),
  at: nonNegativeIntegerSchema,
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
