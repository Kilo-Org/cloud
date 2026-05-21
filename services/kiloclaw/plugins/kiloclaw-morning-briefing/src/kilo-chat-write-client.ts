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
/**
 * Per-call timeout for a controller proxy hop. Only one such call —
 * `createConversation` — sits in the synchronous onboarding route path
 * that the worker awaits (the loading message and the briefing itself are
 * sent from the fire-and-forget delivery), so this stays comfortably
 * under the worker-to-controller request budget.
 */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Per-text-block character cap in Kilo Chat. Keep in sync with
 * `MESSAGE_TEXT_MAX_CHARS` in `packages/kilo-chat/src/schemas.ts` — the
 * plugin is across the service boundary so it cannot import the constant.
 * A message accepts up to 20 such blocks; the chat UI concatenates a
 * message's text blocks back into one rendered bubble, so splitting here
 * respects the per-block cap without changing what the user sees.
 */
const KILO_CHAT_TEXT_BLOCK_MAX = 8000;

/**
 * Max text content blocks Kilo Chat accepts per message. Keep in sync with
 * the message-content limit in `packages/kilo-chat/src/schemas.ts`.
 */
const KILO_CHAT_MAX_TEXT_BLOCKS = 20;

/** Largest text a single message can carry: 20 blocks of 8000 chars. */
const KILO_CHAT_MESSAGE_TEXT_MAX = KILO_CHAT_TEXT_BLOCK_MAX * KILO_CHAT_MAX_TEXT_BLOCKS;

/** Appended when text is truncated to fit the per-message limit. */
const KILO_CHAT_TRUNCATION_MARKER = '\n\n[Briefing truncated.]';

type FetchImpl = typeof fetch;

/**
 * Split text into Kilo Chat text content blocks no larger than the
 * per-block cap. Most messages fit in a single block; a long briefing
 * spills into a few. The chat client re-joins a message's text blocks
 * with no separator, so the split point does not affect rendering.
 *
 * Kilo Chat also caps a message at 20 text blocks. A briefing should
 * never approach 160k characters, but a runaway upstream payload would
 * otherwise produce >20 blocks and fail Kilo Chat's message validation —
 * dropping the whole briefing. Guard that by truncating with a marker so
 * the result always fits in a single valid message.
 */
export function toTextContentBlocks(text: string): Array<{ type: 'text'; text: string }> {
  const safeText =
    text.length > KILO_CHAT_MESSAGE_TEXT_MAX
      ? text.slice(0, KILO_CHAT_MESSAGE_TEXT_MAX - KILO_CHAT_TRUNCATION_MARKER.length) +
        KILO_CHAT_TRUNCATION_MARKER
      : text;
  if (safeText.length <= KILO_CHAT_TEXT_BLOCK_MAX) {
    return [{ type: 'text', text: safeText }];
  }
  const blocks: Array<{ type: 'text'; text: string }> = [];
  for (let i = 0; i < safeText.length; i += KILO_CHAT_TEXT_BLOCK_MAX) {
    blocks.push({ type: 'text', text: safeText.slice(i, i + KILO_CHAT_TEXT_BLOCK_MAX) });
  }
  return blocks;
}

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
  // The client itself only uses the gateway token and controller URL below.
  // KILOCLAW_SANDBOX_ID and KILOCHAT_BASE_URL are not consumed here, but the
  // controller's `/_kilo/kilo-chat/*` proxy only works when both are set on
  // the instance — so their absence is checked up front to short-circuit
  // with a clear reason instead of an opaque mid-operation HTTP failure.
  const token = options.token ?? process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) return unconfigured(UNCONFIGURED_REASONS.token);
  if (!(options.sandboxId ?? process.env.KILOCLAW_SANDBOX_ID)) {
    return unconfigured(UNCONFIGURED_REASONS.sandbox);
  }
  if (!(options.kiloChatBaseUrl ?? process.env.KILOCHAT_BASE_URL)) {
    return unconfigured(UNCONFIGURED_REASONS.kiloChat);
  }

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
        { conversationId, content: toTextContentBlocks(text) },
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
      { conversationId, content: toTextContentBlocks(text), timestamp: Date.now() },
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
