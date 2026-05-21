import {
  type ChatSummaryConversation,
  type ChatSummaryMessage,
  type ChatSummaryWindow,
  ulidToTimestampMs,
} from './chat-summary-utils';

const DEFAULT_CONTROLLER_BASE_URL = 'http://127.0.0.1:18789';
const DEFAULT_TIMEOUT_MS = 20_000;
const PAGE_LIMIT = 100;
const MAX_CONVERSATION_PAGES = 10;
const MAX_MESSAGE_PAGES_PER_CONVERSATION = 20;

type FetchImpl = typeof fetch;

type KiloChatConversationListItem = {
  conversationId: string;
  lastActivityAt: number | null;
};

type KiloChatMessage = ChatSummaryMessage;

type ConversationsResponse = {
  conversations: KiloChatConversationListItem[];
  hasMore: boolean;
  nextCursor: string | null;
};

type MessagesResponse = {
  messages: KiloChatMessage[];
  hasMore: boolean;
  nextCursor: string | null;
};

export type KiloChatSummaryClientOptions = {
  baseUrl?: string;
  token?: string;
  sandboxId?: string;
  kiloChatBaseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
};

export type KiloChatWindowResult = {
  conversations: ChatSummaryConversation[];
  /** True when a page cap was hit and the result may under-count activity. */
  truncated: boolean;
};

export type KiloChatSummaryClient = {
  configured: boolean;
  reason: string;
  listConversationsForWindow: (window: ChatSummaryWindow) => Promise<KiloChatWindowResult>;
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

function parseConversationsResponse(value: unknown): ConversationsResponse {
  const obj = asObject(value);
  const conversationsRaw = Array.isArray(obj.conversations) ? obj.conversations : [];
  const conversations = conversationsRaw.flatMap(item => {
    const row = asObject(item);
    return typeof row.conversationId === 'string'
      ? [
          {
            conversationId: row.conversationId,
            lastActivityAt: typeof row.lastActivityAt === 'number' ? row.lastActivityAt : null,
          },
        ]
      : [];
  });
  return {
    conversations,
    hasMore: obj.hasMore === true,
    nextCursor: typeof obj.nextCursor === 'string' ? obj.nextCursor : null,
  };
}

function parseMessagesResponse(value: unknown): MessagesResponse {
  const obj = asObject(value);
  const messagesRaw = Array.isArray(obj.messages) ? obj.messages : [];
  const messages = messagesRaw.flatMap(item => {
    const row = asObject(item);
    return typeof row.id === 'string' && typeof row.senderId === 'string'
      ? [
          {
            id: row.id,
            senderId: row.senderId,
            deleted: row.deleted === true,
          },
        ]
      : [];
  });
  return {
    messages,
    hasMore: obj.hasMore === true,
    nextCursor: typeof obj.nextCursor === 'string' ? obj.nextCursor : null,
  };
}

async function fetchJson(
  fetchImpl: FetchImpl,
  url: string,
  token: string,
  timeoutMs: number
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(
        `Kilo Chat controller responded ${response.status}: ${await response.text()}`
      );
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A conversation is worth scanning when its most recent activity is at or
 * after the window start. The upper bound is deliberately omitted: a thread
 * that continued past the window (for example one spanning midnight) still
 * holds in-window messages, and `summarizeChatActivity` filters per message
 * by timestamp. Conversations last active before the window start cannot
 * contribute any in-window messages, so they are skipped.
 */
function shouldInspectConversation(
  conversation: KiloChatConversationListItem,
  window: ChatSummaryWindow
): boolean {
  return conversation.lastActivityAt !== null && conversation.lastActivityAt >= window.startMs;
}

function shouldStopConversationScan(
  conversations: KiloChatConversationListItem[],
  window: ChatSummaryWindow
): boolean {
  let previousActivityAt: number | null = null;
  for (const conversation of conversations) {
    if (conversation.lastActivityAt === null) continue;
    if (previousActivityAt !== null && conversation.lastActivityAt > previousActivityAt) {
      return false;
    }
    previousActivityAt = conversation.lastActivityAt;
  }

  return conversations.some(
    conversation =>
      conversation.lastActivityAt !== null && conversation.lastActivityAt < window.startMs
  );
}

/**
 * Mirrors `shouldStopConversationScan` for message pages. Only stop paging
 * when the page is genuinely sorted newest-first AND reaches past the window
 * start. If a page is not strictly descending we cannot trust the early stop,
 * so we keep paginating rather than silently under-counting messages.
 */
function shouldStopMessageScan(messages: ChatSummaryMessage[], window: ChatSummaryWindow): boolean {
  let previousTimestamp: number | null = null;
  let reachedBeforeWindow = false;
  for (const message of messages) {
    const timestamp = ulidToTimestampMs(message.id);
    if (timestamp === null) continue;
    if (previousTimestamp !== null && timestamp > previousTimestamp) {
      return false;
    }
    previousTimestamp = timestamp;
    if (timestamp < window.startMs) reachedBeforeWindow = true;
  }
  return reachedBeforeWindow;
}

export function createKiloChatSummaryClient(
  options: KiloChatSummaryClientOptions = {}
): KiloChatSummaryClient {
  const token = options.token ?? process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) {
    return {
      configured: false,
      reason: 'OPENCLAW_GATEWAY_TOKEN is not configured',
      listConversationsForWindow: async () => ({ conversations: [], truncated: false }),
    };
  }

  const sandboxId = options.sandboxId ?? process.env.KILOCLAW_SANDBOX_ID;
  if (!sandboxId) {
    return {
      configured: false,
      reason: 'KILOCLAW_SANDBOX_ID is not configured',
      listConversationsForWindow: async () => ({ conversations: [], truncated: false }),
    };
  }

  const kiloChatBaseUrl = options.kiloChatBaseUrl ?? process.env.KILOCHAT_BASE_URL;
  if (!kiloChatBaseUrl) {
    return {
      configured: false,
      reason: 'KILOCHAT_BASE_URL is not configured',
      listConversationsForWindow: async () => ({ conversations: [], truncated: false }),
    };
  }

  const gatewayToken = token;
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.KILOCLAW_CONTROLLER_URL);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function listMessagesForConversation(
    conversation: KiloChatConversationListItem,
    window: ChatSummaryWindow
  ): Promise<{ messages: ChatSummaryMessage[]; truncated: boolean }> {
    const messages: ChatSummaryMessage[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_MESSAGE_PAGES_PER_CONVERSATION; page += 1) {
      const qs = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      if (cursor) qs.set('before', cursor);
      const payload = await fetchJson(
        fetchImpl,
        `${baseUrl}/_kilo/kilo-chat/conversations/${encodeURIComponent(
          conversation.conversationId
        )}/messages?${qs}`,
        gatewayToken,
        timeoutMs
      );
      const parsed = parseMessagesResponse(payload);
      messages.push(...parsed.messages);
      if (!parsed.hasMore || !parsed.nextCursor || parsed.messages.length === 0) {
        return { messages, truncated: false };
      }
      if (shouldStopMessageScan(parsed.messages, window)) {
        return { messages, truncated: false };
      }
      cursor = parsed.nextCursor;
    }
    // Fell out of the loop because the page cap was hit; older messages remain.
    return { messages, truncated: true };
  }

  async function listConversationsForWindow(
    window: ChatSummaryWindow
  ): Promise<KiloChatWindowResult> {
    const conversations: ChatSummaryConversation[] = [];
    let cursor: string | null = null;
    let truncated = false;
    for (let page = 0; page < MAX_CONVERSATION_PAGES; page += 1) {
      const qs = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      if (cursor) qs.set('cursor', cursor);
      const payload = await fetchJson(
        fetchImpl,
        `${baseUrl}/_kilo/kilo-chat/conversations?${qs}`,
        gatewayToken,
        timeoutMs
      );
      const parsed = parseConversationsResponse(payload);
      for (const conversation of parsed.conversations) {
        if (!shouldInspectConversation(conversation, window)) continue;
        const result = await listMessagesForConversation(conversation, window);
        if (result.truncated) truncated = true;
        conversations.push({ ...conversation, messages: result.messages });
      }
      if (
        !parsed.hasMore ||
        !parsed.nextCursor ||
        shouldStopConversationScan(parsed.conversations, window)
      ) {
        return { conversations, truncated };
      }
      cursor = parsed.nextCursor;
    }
    // Fell out of the loop because the page cap was hit; older conversations remain.
    return { conversations, truncated: true };
  }

  return {
    configured: true,
    reason: 'Kilo Chat controller is configured',
    listConversationsForWindow,
  };
}
