export type KiloChatClientOptions = {
  controllerBaseUrl: string;
  gatewayToken: string;
  fetchImpl?: typeof fetch;
};

export type CreateMessageParams = { conversationId: string; text: string };
export type CreateMessageResult = { messageId: string; version: number };

export type EditMessageParams = {
  conversationId: string;
  messageId: string;
  text: string;
  version: number;
};

export type DeleteMessageParams = { conversationId: string; messageId: string };

export type SendTextParams = { conversationId: string; text: string };
export type SendTextResult = { messageId: string };

export type KiloChatClient = {
  createMessage(p: CreateMessageParams): Promise<CreateMessageResult>;
  editMessage(p: EditMessageParams): Promise<CreateMessageResult>;
  deleteMessage(p: DeleteMessageParams): Promise<void>;
  /** Back-compat alias for createMessage; returns only messageId. */
  sendText(p: SendTextParams): Promise<SendTextResult>;
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
      body: JSON.stringify({ conversationId: params.conversationId, text: params.text }),
    });
    if (!response.ok) {
      throw new Error(
        `kilo-chat: controller /send responded ${response.status}: ${await response.text()}`
      );
    }
    return parseCreateResult(await response.json());
  }

  // editMessage and deleteMessage are added in later tasks.
  async function editMessage(_params: EditMessageParams): Promise<CreateMessageResult> {
    throw new Error('kilo-chat: editMessage not yet implemented');
  }
  async function deleteMessage(_params: DeleteMessageParams): Promise<void> {
    throw new Error('kilo-chat: deleteMessage not yet implemented');
  }

  return {
    createMessage,
    editMessage,
    deleteMessage,
    async sendText(params) {
      const { messageId } = await createMessage(params);
      return { messageId };
    },
  };
}
