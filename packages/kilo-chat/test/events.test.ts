import { describe, expect, it } from 'vitest';
import { ACTION_LABEL_MAX_CHARS, CONVERSATION_TITLE_MAX_CHARS } from '../src/schemas';
import { getKiloChatEventPayloadSchema } from '../src/events';

const validConversationId = '01HXYZ00000ABCDEFGHJKMNPQR';
const validMessageId = '01HXYZ00000ABCDEFGHJKMNPQS';
const validReplyMessageId = '01HXYZ00000ABCDEFGHJKMNPQT';
const validClientId = '01HXYZ00000ABCDEFGHJKMNPQV';
const validOperationId = '01HXYZ00000ABCDEFGHJKMNPQW';
const uuidClientId = '8bb5a00b-98a3-4910-bda3-2669bcde23bc';

describe('kilo chat event payload schemas', () => {
  it('rejects malformed or empty event identifiers', () => {
    const messageCreatedSchema = getKiloChatEventPayloadSchema('message.created');
    expect(
      messageCreatedSchema.safeParse({
        messageId: '',
        senderId: 'bot:kiloclaw:sandbox-1',
        content: [{ type: 'text', text: 'hello' }],
        inReplyToMessageId: null,
        clientId: null,
      }).success
    ).toBe(false);
    expect(
      messageCreatedSchema.safeParse({
        messageId: validMessageId,
        senderId: 'bot:kiloclaw:sandbox-1',
        content: [{ type: 'text', text: 'hello' }],
        inReplyToMessageId: 'not-a-ulid',
        clientId: validClientId,
      }).success
    ).toBe(false);
    expect(
      messageCreatedSchema.safeParse({
        messageId: validMessageId,
        senderId: 'bot:kiloclaw:sandbox-1',
        content: [{ type: 'text', text: 'hello' }],
        inReplyToMessageId: validReplyMessageId,
        clientId: '',
      }).success
    ).toBe(false);
    expect(
      messageCreatedSchema.safeParse({
        messageId: validMessageId,
        senderId: 'bot:kiloclaw:sandbox-1',
        content: [{ type: 'text', text: 'hello' }],
        inReplyToMessageId: validReplyMessageId,
        clientId: uuidClientId,
      }).success
    ).toBe(false);

    const conversationSchema = getKiloChatEventPayloadSchema('conversation.created');
    expect(
      conversationSchema.safeParse({
        conversationId: 'not-a-ulid',
        conversation: {
          conversationId: 'not-a-ulid',
          title: null,
          lastActivityAt: null,
          lastReadAt: null,
          joinedAt: 1,
        },
      }).success
    ).toBe(false);
  });

  it('validates conversation.created list rows', () => {
    const conversationSchema = getKiloChatEventPayloadSchema('conversation.created');

    expect(
      conversationSchema.safeParse({
        conversationId: validConversationId,
        conversation: {
          conversationId: validConversationId,
          title: 'New chat',
          lastActivityAt: null,
          lastReadAt: null,
          joinedAt: 1,
        },
      }).success
    ).toBe(true);
    expect(
      conversationSchema.safeParse({
        conversationId: validConversationId,
        conversation: {
          conversationId: validReplyMessageId,
          title: 'New chat',
          lastActivityAt: null,
          lastReadAt: null,
          joinedAt: 1,
        },
      }).success
    ).toBe(false);
  });

  it('keeps actor and member identifiers non-empty without requiring ULIDs', () => {
    const typingSchema = getKiloChatEventPayloadSchema('typing');
    expect(typingSchema.safeParse({ memberId: 'bot:kiloclaw:sandbox-1' }).success).toBe(true);
    expect(typingSchema.safeParse({ memberId: '' }).success).toBe(false);

    const actionSchema = getKiloChatEventPayloadSchema('action.executed');
    expect(
      actionSchema.safeParse({
        conversationId: validConversationId,
        messageId: validMessageId,
        groupId: 'approval-group',
        value: 'allow-once',
        executedBy: '',
      }).success
    ).toBe(false);
  });

  it('rejects invalid action decisions and group IDs', () => {
    const actionSchema = getKiloChatEventPayloadSchema('action.executed');
    expect(
      actionSchema.safeParse({
        conversationId: validConversationId,
        messageId: validMessageId,
        groupId: 'approval-group',
        value: 'maybe',
        executedBy: 'user-1',
      }).success
    ).toBe(false);
    expect(
      actionSchema.safeParse({
        conversationId: validConversationId,
        messageId: validMessageId,
        groupId: '',
        value: 'deny',
        executedBy: 'user-1',
      }).success
    ).toBe(false);
    expect(
      actionSchema.safeParse({
        conversationId: validConversationId,
        messageId: validMessageId,
        groupId: 'g'.repeat(ACTION_LABEL_MAX_CHARS + 1),
        value: 'deny',
        executedBy: 'user-1',
      }).success
    ).toBe(false);
  });

  it('rejects negative and fractional event timestamps', () => {
    const readSchema = getKiloChatEventPayloadSchema('conversation.read');
    expect(
      readSchema.safeParse({
        conversationId: validConversationId,
        memberId: 'bot:kiloclaw:sandbox-1',
        lastReadAt: -1,
      }).success
    ).toBe(false);
    expect(
      readSchema.safeParse({
        conversationId: validConversationId,
        memberId: 'bot:kiloclaw:sandbox-1',
        lastReadAt: 1.5,
      }).success
    ).toBe(false);

    const botStatusSchema = getKiloChatEventPayloadSchema('bot.status');
    expect(
      botStatusSchema.safeParse({
        sandboxId: 'sandbox-1',
        online: true,
        at: 1.5,
      }).success
    ).toBe(false);
  });

  it('rejects negative and fractional status counters', () => {
    const statusSchema = getKiloChatEventPayloadSchema('conversation.status');
    expect(
      statusSchema.safeParse({
        conversationId: validConversationId,
        contextTokens: -1,
        contextWindow: 4096,
        model: null,
        provider: null,
        at: 1000,
      }).success
    ).toBe(false);
    expect(
      statusSchema.safeParse({
        conversationId: validConversationId,
        contextTokens: 0,
        contextWindow: 4096.5,
        model: null,
        provider: null,
        at: 1000,
      }).success
    ).toBe(false);
  });

  it('rejects invalid reaction emoji values', () => {
    const reactionAddedSchema = getKiloChatEventPayloadSchema('reaction.added');
    const reactionRemovedSchema = getKiloChatEventPayloadSchema('reaction.removed');

    expect(
      reactionAddedSchema.safeParse({
        messageId: validMessageId,
        operationId: validOperationId,
        memberId: 'user-1',
        emoji: '',
      }).success
    ).toBe(false);
    expect(
      reactionAddedSchema.safeParse({
        messageId: validMessageId,
        operationId: validOperationId,
        memberId: 'user-1',
        emoji: 'a'.repeat(65),
      }).success
    ).toBe(false);
    expect(
      reactionRemovedSchema.safeParse({
        messageId: validMessageId,
        operationId: validOperationId,
        memberId: 'user-1',
        emoji: 'ok\u0000',
      }).success
    ).toBe(false);
  });

  it('requires valid operation ids for reaction events', () => {
    const reactionAddedSchema = getKiloChatEventPayloadSchema('reaction.added');
    const reactionRemovedSchema = getKiloChatEventPayloadSchema('reaction.removed');

    expect(
      reactionAddedSchema.safeParse({
        messageId: validMessageId,
        operationId: validOperationId,
        memberId: 'user-1',
        emoji: '👍',
      }).success
    ).toBe(true);
    expect(
      reactionRemovedSchema.safeParse({
        messageId: validMessageId,
        operationId: validOperationId,
        memberId: 'user-1',
        emoji: '👍',
      }).success
    ).toBe(true);
    expect(
      reactionAddedSchema.safeParse({
        messageId: validMessageId,
        memberId: 'user-1',
        emoji: '👍',
      }).success
    ).toBe(false);
    expect(
      reactionRemovedSchema.safeParse({
        messageId: validMessageId,
        operationId: 'not-a-ulid',
        memberId: 'user-1',
        emoji: '👍',
      }).success
    ).toBe(false);
  });

  it('rejects blank and overlong renamed conversation titles', () => {
    const renamedSchema = getKiloChatEventPayloadSchema('conversation.renamed');

    expect(
      renamedSchema.safeParse({
        conversationId: validConversationId,
        title: '   ',
      }).success
    ).toBe(false);
    expect(
      renamedSchema.safeParse({
        conversationId: validConversationId,
        title: 'a'.repeat(CONVERSATION_TITLE_MAX_CHARS + 1),
      }).success
    ).toBe(false);
  });
});
