import type { z } from 'zod';
import {
  actionDeliveryFailedRequestSchema,
  addReactionResponseSchema,
  botGetMembersResponseSchema,
  botListConversationsResponseSchema,
  botListMessagesResponseSchema,
  botStatusRequestSchema,
  conversationStatusRequestSchema,
  createBotConversationRequestSchema,
  createConversationResponseSchema,
  createMessageRequestSchema,
  createMessageResponseSchema,
  cursorPaginationQuerySchema,
  deleteMessageQuerySchema,
  editMessageRequestSchema,
  editMessageResponseSchema,
  listMessagesQuerySchema,
  messageDeliveryFailedRequestSchema,
  reactionRequestBodySchema,
  renameConversationRequestSchema,
  type botConversationSummarySchema,
  type contentBlockSchema,
  type enrichedConversationMemberSchema,
  type messageSchema,
} from './synced/schemas.js';

export type ContentBlock = z.infer<typeof contentBlockSchema>;
export type Message = z.infer<typeof messageSchema>;
export type BotConversationSummary = z.infer<typeof botConversationSummarySchema>;
export type EnrichedConversationMember = z.infer<typeof enrichedConversationMemberSchema>;
export type BotListConversationsResponse = z.infer<typeof botListConversationsResponseSchema>;
export type BotGetMembersResponse = z.infer<typeof botGetMembersResponseSchema>;

export type KiloChatClientOptions = {
  controllerBaseUrl: string;
  gatewayToken: string;
  fetchImpl?: typeof fetch;
};

export type CreateMessageParams = z.input<typeof createMessageRequestSchema>;
export type CreateMessageResult = { messageId: string };
export type EditMessageResult = { messageId: string; stale?: boolean };

export type EditMessageParams = { messageId: string } & z.input<typeof editMessageRequestSchema>;

export type DeleteMessageParams = { messageId: string } & z.input<typeof deleteMessageQuerySchema>;

export type SendTypingParams = { conversationId: string };

export type ListMessagesParams = { conversationId: string } & z.input<
  typeof listMessagesQuerySchema
>;
export type ListMessagesResult = { messages: Message[] };
export type GetMembersParams = { conversationId: string };
export type GetMembersResult = BotGetMembersResponse;

export type RenameConversationParams = { conversationId: string } & z.input<
  typeof renameConversationRequestSchema
>;

export type ListConversationsParams = z.input<typeof cursorPaginationQuerySchema>;
export type ConversationMember = EnrichedConversationMember;
export type ConversationSummary = BotConversationSummary;
export type ListConversationsResult = BotListConversationsResponse;

export type AddReactionParams = { messageId: string } & z.input<typeof reactionRequestBodySchema>;
export type AddReactionResult = { id: string };
export type RemoveReactionParams = { messageId: string } & z.input<
  typeof reactionRequestBodySchema
>;

export type CreateConversationParams = z.input<typeof createBotConversationRequestSchema>;
export type CreateConversationResult = { conversationId: string };

export type BotStatusParams = z.input<typeof botStatusRequestSchema>;
export type ConversationStatusParams = { conversationId: string } & z.input<
  typeof conversationStatusRequestSchema
>;

export type ReportMessageDeliveryFailedParams = {
  conversationId: string;
  messageId: string;
} & z.input<typeof messageDeliveryFailedRequestSchema>;

export type ReportActionDeliveryFailedParams = {
  conversationId: string;
  groupId: string;
} & z.input<typeof actionDeliveryFailedRequestSchema>;

export type KiloChatClient = {
  createMessage(p: CreateMessageParams): Promise<CreateMessageResult>;
  editMessage(p: EditMessageParams): Promise<EditMessageResult>;
  deleteMessage(p: DeleteMessageParams): Promise<void>;
  sendTyping(p: SendTypingParams): Promise<void>;
  sendTypingStop(p: SendTypingParams): Promise<void>;
  addReaction(p: AddReactionParams): Promise<AddReactionResult>;
  removeReaction(p: RemoveReactionParams): Promise<void>;
  listMessages(p: ListMessagesParams): Promise<ListMessagesResult>;
  getMembers(p: GetMembersParams): Promise<GetMembersResult>;
  renameConversation(p: RenameConversationParams): Promise<void>;
  listConversations(p: ListConversationsParams): Promise<ListConversationsResult>;
  createConversation(p: CreateConversationParams): Promise<CreateConversationResult>;
  /**
   * Fire-and-forget bot presence/context update. Never throws; errors are logged.
   */
  sendBotStatus(p: BotStatusParams): Promise<void>;
  /**
   * Fire-and-forget per-conversation post-turn snapshot. Never throws; errors are logged.
   */
  sendConversationStatus(p: ConversationStatusParams): Promise<void>;
  /**
   * Best-effort "message delivery failed" report. Never throws; errors are logged.
   */
  reportMessageDeliveryFailed(p: ReportMessageDeliveryFailedParams): Promise<void>;
  /**
   * Best-effort "action delivery failed" report. Never throws; errors are logged.
   */
  reportActionDeliveryFailed(p: ReportActionDeliveryFailedParams): Promise<void>;
};

function authHeaders(token: string): HeadersInit {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  };
}

// Turns Zod schema failures into flat, human-readable errors. Keeps the first
// issue's path + message so callers (and tests) can match on the missing-field
// name rather than on a stringified issue array.
function parseOrThrow<T>(
  schema: z.ZodType<T>,
  data: unknown,
  label: string,
  fieldNames?: Record<string, string>
): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const key = String(issue.path[0] ?? '');
  const name = fieldNames?.[key] ?? key;
  throw new Error(`kilo-chat: ${label}: ${name ? `missing ${name}` : issue.message}`);
}

function parseCreateResult(data: unknown): CreateMessageResult {
  return parseOrThrow(createMessageResponseSchema, data, 'createMessage', {
    messageId: 'messageId',
  });
}

export function createKiloChatClient(options: KiloChatClientOptions): KiloChatClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.controllerBaseUrl;
  const headers = authHeaders(options.gatewayToken);

  async function createMessage(params: CreateMessageParams): Promise<CreateMessageResult> {
    const response = await fetchImpl(`${base}/_kilo/kilo-chat/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        conversationId: params.conversationId,
        content: params.content,
        ...(params.inReplyToMessageId !== undefined && {
          inReplyToMessageId: params.inReplyToMessageId,
        }),
      }),
    });
    if (!response.ok) {
      throw new Error(
        `kilo-chat: controller /send responded ${response.status}: ${await response.text()}`
      );
    }
    return parseCreateResult(await response.json());
  }

  async function editMessage(params: EditMessageParams): Promise<EditMessageResult> {
    const response = await fetchImpl(
      `${base}/_kilo/kilo-chat/messages/${encodeURIComponent(params.messageId)}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          conversationId: params.conversationId,
          content: params.content,
          timestamp: params.timestamp,
        }),
      }
    );
    if (response.status === 409) {
      return { messageId: params.messageId, stale: true };
    }
    if (!response.ok) {
      throw new Error(
        `kilo-chat: controller PATCH responded ${response.status}: ${await response.text()}`
      );
    }
    const body = editMessageResponseSchema.parse(await response.json());
    return {
      messageId: body.messageId ?? params.messageId,
      stale: false,
    };
  }
  async function deleteMessage(params: DeleteMessageParams): Promise<void> {
    const qs = new URLSearchParams({ conversationId: params.conversationId });
    const response = await fetchImpl(
      `${base}/_kilo/kilo-chat/messages/${encodeURIComponent(params.messageId)}?${qs}`,
      {
        method: 'DELETE',
        headers,
      }
    );
    if (!response.ok) {
      throw new Error(
        `kilo-chat: controller DELETE responded ${response.status}: ${await response.text()}`
      );
    }
  }

  async function sendTyping(params: SendTypingParams): Promise<void> {
    const response = await fetchImpl(`${base}/_kilo/kilo-chat/typing`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ conversationId: params.conversationId }),
    });
    if (!response.ok) {
      throw new Error(
        `kilo-chat: controller /typing responded ${response.status}: ${await response.text()}`
      );
    }
    void response.body?.cancel();
  }

  async function sendTypingStop(params: SendTypingParams): Promise<void> {
    const response = await fetchImpl(`${base}/_kilo/kilo-chat/typing/stop`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ conversationId: params.conversationId }),
    });
    if (!response.ok) {
      throw new Error(
        `kilo-chat: controller /typing/stop responded ${response.status}: ${await response.text()}`
      );
    }
    void response.body?.cancel();
  }

  async function addReaction(params: AddReactionParams): Promise<AddReactionResult> {
    const response = await fetchImpl(
      `${base}/_kilo/kilo-chat/messages/${encodeURIComponent(params.messageId)}/reactions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ conversationId: params.conversationId, emoji: params.emoji }),
      }
    );
    if (!response.ok) {
      throw new Error(
        `kilo-chat: controller POST reactions responded ${response.status}: ${await response.text()}`
      );
    }
    return parseOrThrow(addReactionResponseSchema, await response.json(), 'addReaction', {
      id: 'reaction id',
    });
  }

  async function removeReaction(params: RemoveReactionParams): Promise<void> {
    const qs = new URLSearchParams({
      conversationId: params.conversationId,
      emoji: params.emoji,
    });
    const response = await fetchImpl(
      `${base}/_kilo/kilo-chat/messages/${encodeURIComponent(params.messageId)}/reactions?${qs}`,
      {
        method: 'DELETE',
        headers,
      }
    );
    if (!response.ok) {
      throw new Error(
        `kilo-chat: controller DELETE reactions responded ${response.status}: ${await response.text()}`
      );
    }
    void response.body?.cancel();
  }

  async function listMessages(params: ListMessagesParams): Promise<ListMessagesResult> {
    const qs = new URLSearchParams();
    if (params.before !== undefined) qs.set('before', params.before);
    if (params.limit !== undefined) qs.set('limit', String(params.limit));
    const query = qs.toString();
    const url = `${base}/_kilo/kilo-chat/conversations/${encodeURIComponent(params.conversationId)}/messages${query ? `?${query}` : ''}`;
    const response = await fetchImpl(url, { method: 'GET', headers });
    if (!response.ok) {
      throw new Error(
        `kilo-chat: controller GET messages responded ${response.status}: ${await response.text()}`
      );
    }
    return botListMessagesResponseSchema.parse(await response.json());
  }

  async function getMembers(params: GetMembersParams): Promise<GetMembersResult> {
    const response = await fetchImpl(
      `${base}/_kilo/kilo-chat/conversations/${encodeURIComponent(params.conversationId)}/members`,
      { method: 'GET', headers }
    );
    if (!response.ok) {
      throw new Error(
        `kilo-chat: controller GET members responded ${response.status}: ${await response.text()}`
      );
    }
    return botGetMembersResponseSchema.parse(await response.json());
  }

  async function renameConversation(params: RenameConversationParams): Promise<void> {
    const response = await fetchImpl(
      `${base}/_kilo/kilo-chat/conversations/${encodeURIComponent(params.conversationId)}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ title: params.title }),
      }
    );
    if (!response.ok) {
      throw new Error(
        `kilo-chat: controller PATCH conversations responded ${response.status}: ${await response.text()}`
      );
    }
    void response.body?.cancel();
  }

  async function listConversations(
    params: ListConversationsParams
  ): Promise<ListConversationsResult> {
    const qs = new URLSearchParams();
    if (params.limit !== undefined) qs.set('limit', String(params.limit));
    if (params.cursor !== undefined) qs.set('cursor', params.cursor);
    const query = qs.toString();
    const url = `${base}/_kilo/kilo-chat/conversations${query ? `?${query}` : ''}`;
    const response = await fetchImpl(url, { method: 'GET', headers });
    if (!response.ok) {
      throw new Error(
        `kilo-chat: controller GET conversations responded ${response.status}: ${await response.text()}`
      );
    }
    return botListConversationsResponseSchema.parse(await response.json());
  }

  async function createConversation(
    params: CreateConversationParams
  ): Promise<CreateConversationResult> {
    const response = await fetchImpl(`${base}/_kilo/kilo-chat/conversations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...(params.title !== undefined && { title: params.title }),
        ...(params.additionalMembers !== undefined && {
          additionalMembers: params.additionalMembers,
        }),
      }),
    });
    if (!response.ok) {
      throw new Error(
        `kilo-chat: controller POST conversations responded ${response.status}: ${await response.text()}`
      );
    }
    return parseOrThrow(
      createConversationResponseSchema,
      await response.json(),
      'createConversation',
      { conversationId: 'conversationId' }
    );
  }

  async function sendBotStatus(params: BotStatusParams): Promise<void> {
    try {
      const response = await fetchImpl(`${base}/_kilo/kilo-chat/bot-status`, {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
      });
      if (!response.ok) {
        console.warn(
          `[kilo-chat] bot-status responded ${response.status}: ${await response.text().catch(() => '')}`
        );
      } else {
        void response.body?.cancel();
      }
    } catch (err) {
      console.warn('[kilo-chat] bot-status request failed:', err);
    }
  }

  async function sendConversationStatus(params: ConversationStatusParams): Promise<void> {
    try {
      const { conversationId, ...body } = params;
      const response = await fetchImpl(
        `${base}/_kilo/kilo-chat/conversations/${encodeURIComponent(conversationId)}/conversation-status`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        }
      );
      if (!response.ok) {
        console.warn(
          `[kilo-chat] conversation-status responded ${response.status}: ${await response.text().catch(() => '')}`
        );
      } else {
        void response.body?.cancel();
      }
    } catch (err) {
      console.warn('[kilo-chat] conversation-status request failed:', err);
    }
  }

  async function reportMessageDeliveryFailed(
    params: ReportMessageDeliveryFailedParams
  ): Promise<void> {
    try {
      const response = await fetchImpl(
        `${base}/_kilo/kilo-chat/conversations/${encodeURIComponent(
          params.conversationId
        )}/messages/${encodeURIComponent(params.messageId)}/delivery-failed`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            ...(params.reason !== undefined && { reason: params.reason }),
          }),
        }
      );
      if (!response.ok) {
        console.warn(
          `[kilo-chat] reportMessageDeliveryFailed responded ${response.status}: ${await response.text().catch(() => '')}`
        );
      } else {
        void response.body?.cancel();
      }
    } catch (err) {
      console.warn('[kilo-chat] reportMessageDeliveryFailed request failed:', err);
    }
  }

  async function reportActionDeliveryFailed(
    params: ReportActionDeliveryFailedParams
  ): Promise<void> {
    try {
      const response = await fetchImpl(
        `${base}/_kilo/kilo-chat/conversations/${encodeURIComponent(
          params.conversationId
        )}/actions/${encodeURIComponent(params.groupId)}/delivery-failed`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            messageId: params.messageId,
            ...(params.reason !== undefined && { reason: params.reason }),
          }),
        }
      );
      if (!response.ok) {
        console.warn(
          `[kilo-chat] reportActionDeliveryFailed responded ${response.status}: ${await response.text().catch(() => '')}`
        );
      } else {
        void response.body?.cancel();
      }
    } catch (err) {
      console.warn('[kilo-chat] reportActionDeliveryFailed request failed:', err);
    }
  }

  return {
    createMessage,
    editMessage,
    deleteMessage,
    sendTyping,
    sendTypingStop,
    addReaction,
    removeReaction,
    listMessages,
    getMembers,
    renameConversation,
    listConversations,
    createConversation,
    sendBotStatus,
    sendConversationStatus,
    reportMessageDeliveryFailed,
    reportActionDeliveryFailed,
  };
}
