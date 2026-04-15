export type KiloChatClientOptions = {
  controllerBaseUrl: string;
  gatewayToken: string;
  fetchImpl?: typeof fetch;
};

export type ContentBlock = { type: string; [key: string]: unknown };

export type CreateMessageParams = {
  conversationId: string;
  content: ContentBlock[];
};
export type CreateMessageResult = { messageId: string; version: number };
export type EditMessageResult = CreateMessageResult & { dropped?: boolean };

export type EditMessageParams = {
  conversationId: string;
  messageId: string;
  content: ContentBlock[];
  version: number;
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
  const o = (data ?? {}) as { messageId?: unknown; version?: unknown };
  if (typeof o.messageId !== 'string' || o.messageId.length === 0) {
    throw new Error('kilo-chat: response missing messageId');
  }
  const version =
    typeof o.version === 'number' && Number.isFinite(o.version) && o.version > 0 ? o.version : 1;
  return { messageId: o.messageId, version };
}

export function createKiloChatClient(options: KiloChatClientOptions): KiloChatClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.controllerBaseUrl;
  const headers = authHeaders(options.gatewayToken);

  async function createMessage(params: CreateMessageParams): Promise<CreateMessageResult> {
    const response = await fetchImpl(`${base}/_kilo/kilo-chat/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ conversationId: params.conversationId, content: params.content }),
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
          version: params.version,
        }),
      }
    );
    if (response.status === 409) {
      // Stale version — benign drop. Read the server's authoritative current
      // version from the 409 body so the caller can re-base subsequent edits
      // on the real server state instead of echoing the stale client version.
      let serverVersion = params.version;
      try {
        const body = (await response.json()) as { version?: unknown };
        if (typeof body.version === 'number' && Number.isFinite(body.version) && body.version > 0) {
          serverVersion = body.version;
        }
      } catch {
        // Body missing or not JSON — fall back to the client-sent version.
      }
      return { messageId: params.messageId, version: serverVersion, dropped: true };
    }
    if (!response.ok) {
      throw new Error(
        `kilo-chat: controller PATCH responded ${response.status}: ${await response.text()}`
      );
    }
    return parseCreateResult(await response.json());
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
    addReaction,
    removeReaction,
  };
}
