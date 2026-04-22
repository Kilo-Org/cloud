import type { ContentBlock } from '@kilocode/kilo-chat';
import { z } from 'zod';

export type KiloChatClientOptions = {
  controllerBaseUrl: string;
  gatewayToken: string;
  fetchImpl?: typeof fetch;
};

export type { ContentBlock };

export type CreateMessageParams = {
  conversationId: string;
  content: ContentBlock[];
  inReplyToMessageId?: string;
};
export type CreateMessageResult = { messageId: string };
export type EditMessageResult = { messageId: string; stale?: boolean };

export type EditMessageParams = {
  conversationId: string;
  messageId: string;
  content: ContentBlock[];
  timestamp: number;
};

export type DeleteMessageParams = { conversationId: string; messageId: string };

export type SendTypingParams = { conversationId: string };

export type ListMessagesParams = { conversationId: string; before?: string; limit?: number };
export type ListMessagesResult = { messages: Array<Record<string, unknown>> };
export type GetMembersParams = { conversationId: string };
export type GetMembersResult = {
  members: Array<{
    id: string;
    kind: string;
    displayName: string | null;
    avatarUrl: string | null;
  }>;
};

export type RenameConversationParams = { conversationId: string; title: string };

export type ListConversationsParams = { limit?: number; offset?: number };
export type ConversationMember = {
  id: string;
  kind: string;
  displayName: string | null;
  avatarUrl: string | null;
};
export type ConversationSummary = {
  conversationId: string;
  title: string | null;
  lastActivityAt: number | null;
  members: ConversationMember[];
};
export type ListConversationsResult = {
  conversations: ConversationSummary[];
  total: number;
  limit: number;
  offset: number;
};

export type AddReactionParams = { conversationId: string; messageId: string; emoji: string };
export type AddReactionResult = { id: string };
export type RemoveReactionParams = { conversationId: string; messageId: string; emoji: string };

export type CreateConversationParams = { title?: string; additionalMembers?: string[] };
export type CreateConversationResult = { conversationId: string };

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
};

function authHeaders(token: string): HeadersInit {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  };
}

const createResultSchema = z.object({ messageId: z.string().min(1) });
const addReactionResultSchema = z.object({ id: z.string().min(1) });
const createConversationResultSchema = z.object({ conversationId: z.string().min(1) });

function parseCreateResult(data: unknown): CreateMessageResult {
  return createResultSchema.parse(data);
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
    const body = (await response.json()) as { messageId?: string };
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
    return addReactionResultSchema.parse(await response.json());
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
    return (await response.json()) as ListMessagesResult;
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
    return (await response.json()) as GetMembersResult;
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
    if (params.offset !== undefined) qs.set('offset', String(params.offset));
    const query = qs.toString();
    const url = `${base}/_kilo/kilo-chat/conversations${query ? `?${query}` : ''}`;
    const response = await fetchImpl(url, { method: 'GET', headers });
    if (!response.ok) {
      throw new Error(
        `kilo-chat: controller GET conversations responded ${response.status}: ${await response.text()}`
      );
    }
    return (await response.json()) as ListConversationsResult;
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
    return createConversationResultSchema.parse(await response.json());
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
  };
}
