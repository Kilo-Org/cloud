import type { ContentBlock } from '@kilocode/kilo-chat';

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

export type AddReactionParams = { conversationId: string; messageId: string; emoji: string };
export type AddReactionResult = { id: string };
export type RemoveReactionParams = { conversationId: string; messageId: string; emoji: string };

export type KiloChatClient = {
  createMessage(p: CreateMessageParams): Promise<CreateMessageResult>;
  editMessage(p: EditMessageParams): Promise<EditMessageResult>;
  deleteMessage(p: DeleteMessageParams): Promise<void>;
  sendTyping(p: SendTypingParams): Promise<void>;
  sendTypingStop(p: SendTypingParams): Promise<void>;
  addReaction(p: AddReactionParams): Promise<AddReactionResult>;
  removeReaction(p: RemoveReactionParams): Promise<void>;
};

function authHeaders(token: string): HeadersInit {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  };
}

function parseCreateResult(data: unknown): CreateMessageResult {
  const o = (data ?? {}) as { messageId?: unknown };
  if (typeof o.messageId !== 'string' || o.messageId.length === 0) {
    throw new Error('kilo-chat: response missing messageId');
  }
  return { messageId: o.messageId };
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
    const response = await fetchImpl(
      `${base}/_kilo/kilo-chat/messages/${encodeURIComponent(params.messageId)}`,
      {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ conversationId: params.conversationId }),
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
    const data = (await response.json()) as { id?: unknown };
    if (typeof data.id !== 'string' || data.id.length === 0) {
      throw new Error('kilo-chat: response missing reaction id');
    }
    return { id: data.id };
  }

  async function removeReaction(params: RemoveReactionParams): Promise<void> {
    const response = await fetchImpl(
      `${base}/_kilo/kilo-chat/messages/${encodeURIComponent(params.messageId)}/reactions`,
      {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ conversationId: params.conversationId, emoji: params.emoji }),
      }
    );
    if (!response.ok) {
      throw new Error(
        `kilo-chat: controller DELETE reactions responded ${response.status}: ${await response.text()}`
      );
    }
    void response.body?.cancel();
  }

  return {
    createMessage,
    editMessage,
    deleteMessage,
    sendTyping,
    sendTypingStop,
    addReaction,
    removeReaction,
  };
}
