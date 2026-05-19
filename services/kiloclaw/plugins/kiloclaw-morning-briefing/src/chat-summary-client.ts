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
  title: string | null;
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
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
};

export type KiloChatSummaryClient = {
  configured: boolean;
  reason: string;
  listConversationsForWindow: (window: ChatSummaryWindow) => Promise<ChatSummaryConversation[]>;
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
            title: typeof row.title === 'string' ? row.title : null,
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
      headers: { authorization: `Bearer ${token}` },
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

function shouldInspectConversation(
  conversation: KiloChatConversationListItem,
  window: ChatSummaryWindow
): boolean {
  return (
    conversation.lastActivityAt !== null &&
    conversation.lastActivityAt >= window.startMs &&
    conversation.lastActivityAt < window.endMs
  );
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

export function createKiloChatSummaryClient(
  options: KiloChatSummaryClientOptions = {}
): KiloChatSummaryClient {
  const token = options.token ?? process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) {
    return {
      configured: false,
      reason: 'OPENCLAW_GATEWAY_TOKEN is not configured',
      listConversationsForWindow: async () => [],
    };
  }

  const gatewayToken = token;
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.KILOCLAW_CONTROLLER_URL);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function listMessagesForConversation(
    conversation: KiloChatConversationListItem,
    window: ChatSummaryWindow
  ): Promise<ChatSummaryMessage[]> {
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
      if (!parsed.hasMore || !parsed.nextCursor || parsed.messages.length === 0) break;

      const oldestTimestamp = ulidToTimestampMs(
        parsed.messages[parsed.messages.length - 1]?.id ?? ''
      );
      if (oldestTimestamp !== null && oldestTimestamp < window.startMs) {
        // Pagination returns newest first. Once the page's oldest message is
        // older than yesterday, later pages cannot contribute stats.
        break;
      }
      cursor = parsed.nextCursor;
    }
    return messages;
  }

  async function listConversationsForWindow(
    window: ChatSummaryWindow
  ): Promise<ChatSummaryConversation[]> {
    const conversations: ChatSummaryConversation[] = [];
    let cursor: string | null = null;
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
        conversations.push({
          ...conversation,
          messages: await listMessagesForConversation(conversation, window),
        });
      }
      if (
        !parsed.hasMore ||
        !parsed.nextCursor ||
        shouldStopConversationScan(parsed.conversations, window)
      ) {
        break;
      }
      cursor = parsed.nextCursor;
    }
    return conversations;
  }

  return {
    configured: true,
    reason: 'Kilo Chat controller is configured',
    listConversationsForWindow,
  };
}
