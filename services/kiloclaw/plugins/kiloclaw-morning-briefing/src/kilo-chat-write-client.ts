/**
 * Write client for posting the onboarding morning briefing into Kilo Chat.
 *
 * Mirrors the read-only `chat-summary-client.ts` (PR-12): both talk to the
 * kiloclaw controller's localhost `/_kilo/kilo-chat/*` proxy, which forwards
 * to the Kilo Chat bot API with the gateway bearer token. This client only
 * needs the create-conversation and send-message routes — both already exist
 * on the controller proxy, so no new controller route is required for the
 * writes themselves.
 *
 * Messages posted here are authored by the bot (`bot:kiloclaw:<sandboxId>`):
 * the controller's bot-auth middleware sets that sender id. They are NOT
 * posted as the user.
 */

const DEFAULT_CONTROLLER_BASE_URL = 'http://127.0.0.1:18789';
const DEFAULT_TIMEOUT_MS = 20_000;

type FetchImpl = typeof fetch;

export type KiloChatWriteClientOptions = {
  baseUrl?: string;
  token?: string;
  sandboxId?: string;
  kiloChatBaseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
};

export type KiloChatWriteClient = {
  configured: boolean;
  reason: string;
  /** Create a conversation with an explicit title. Returns its id. */
  createConversation: (title: string) => Promise<string>;
  /** Post a bot-authored text message. Returns the new message id. */
  sendTextMessage: (conversationId: string, text: string) => Promise<string>;
  /** Replace an existing bot message's text (used to clear the loading bubble). */
  editTextMessage: (conversationId: string, messageId: string, text: string) => Promise<void>;
  /** Emit a bot typing indicator. Auto-expires in the UI after ~5s; re-ping to sustain it. */
  sendTyping: (conversationId: string) => Promise<void>;
  /** Clear the bot typing indicator immediately. */
  stopTyping: (conversationId: string) => Promise<void>;
};

function normalizeBaseUrl(input: string | undefined): string {
  const raw = input?.trim() || DEFAULT_CONTROLLER_BASE_URL;
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function postJson(
  fetchImpl: FetchImpl,
  url: string,
  token: string,
  body: unknown,
  timeoutMs: number,
  method: 'POST' | 'PATCH' = 'POST'
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(
        `Kilo Chat controller responded ${response.status}: ${await response.text()}`
      );
    }
    // Edit returns a thin body; create/send return JSON we parse below.
    const text = await response.text();
    return text.length > 0 ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

const UNCONFIGURED_REASONS: Record<'token' | 'sandbox' | 'kiloChat', string> = {
  token: 'OPENCLAW_GATEWAY_TOKEN is not configured',
  sandbox: 'KILOCLAW_SANDBOX_ID is not configured',
  kiloChat: 'KILOCHAT_BASE_URL is not configured',
};

function unconfigured(reason: string): KiloChatWriteClient {
  const fail = async (): Promise<never> => {
    throw new Error(`Kilo Chat write client is not configured: ${reason}`);
  };
  return {
    configured: false,
    reason,
    createConversation: fail,
    sendTextMessage: fail,
    editTextMessage: fail,
    sendTyping: fail,
    stopTyping: fail,
  };
}

export function createKiloChatWriteClient(
  options: KiloChatWriteClientOptions = {}
): KiloChatWriteClient {
  const token = options.token ?? process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) return unconfigured(UNCONFIGURED_REASONS.token);

  const sandboxId = options.sandboxId ?? process.env.KILOCLAW_SANDBOX_ID;
  if (!sandboxId) return unconfigured(UNCONFIGURED_REASONS.sandbox);

  const kiloChatBaseUrl = options.kiloChatBaseUrl ?? process.env.KILOCHAT_BASE_URL;
  if (!kiloChatBaseUrl) return unconfigured(UNCONFIGURED_REASONS.kiloChat);

  // Re-bind the narrowed token so the closures below see `string`, not the
  // declared `string | undefined`. Mirrors `chat-summary-client.ts`.
  const gatewayToken = token;
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.KILOCLAW_CONTROLLER_URL);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function createConversation(title: string): Promise<string> {
    const payload = asObject(
      await postJson(
        fetchImpl,
        `${baseUrl}/_kilo/kilo-chat/conversations`,
        gatewayToken,
        { title },
        timeoutMs
      )
    );
    const conversationId = payload.conversationId;
    if (typeof conversationId !== 'string' || conversationId.length === 0) {
      throw new Error('Kilo Chat create-conversation returned no conversationId');
    }
    return conversationId;
  }

  async function sendTextMessage(conversationId: string, text: string): Promise<string> {
    const payload = asObject(
      await postJson(
        fetchImpl,
        `${baseUrl}/_kilo/kilo-chat/send`,
        gatewayToken,
        { conversationId, content: [{ type: 'text', text }] },
        timeoutMs
      )
    );
    const messageId = payload.messageId;
    if (typeof messageId !== 'string' || messageId.length === 0) {
      throw new Error('Kilo Chat send returned no messageId');
    }
    return messageId;
  }

  async function editTextMessage(
    conversationId: string,
    messageId: string,
    text: string
  ): Promise<void> {
    await postJson(
      fetchImpl,
      `${baseUrl}/_kilo/kilo-chat/messages/${encodeURIComponent(messageId)}`,
      gatewayToken,
      { conversationId, content: [{ type: 'text', text }], timestamp: Date.now() },
      timeoutMs,
      'PATCH'
    );
  }

  async function sendTyping(conversationId: string): Promise<void> {
    await postJson(
      fetchImpl,
      `${baseUrl}/_kilo/kilo-chat/typing`,
      gatewayToken,
      { conversationId },
      timeoutMs
    );
  }

  async function stopTyping(conversationId: string): Promise<void> {
    await postJson(
      fetchImpl,
      `${baseUrl}/_kilo/kilo-chat/typing/stop`,
      gatewayToken,
      { conversationId },
      timeoutMs
    );
  }

  return {
    configured: true,
    reason: 'Kilo Chat write client is configured',
    createConversation,
    sendTextMessage,
    editTextMessage,
    sendTyping,
    stopTyping,
  };
}
