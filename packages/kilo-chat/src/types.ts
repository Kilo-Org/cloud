import type { EventServiceClient } from '@kilocode/event-service';

// ── Configuration ───────────────────────────────────────────────────
export type KiloChatClientConfig = {
  eventService: EventServiceClient;
  baseUrl: string;
  getToken: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
};

// ── Content blocks ──────────────────────────────────────────────────
export type TextBlock = { type: 'text'; text: string };
export type ContentBlock = TextBlock; // union — extend when new types land

// ── Reactions ───────────────────────────────────────────────────────
export type ReactionSummary = {
  emoji: string;
  count: number;
  memberIds: string[];
};

// ── Conversations ───────────────────────────────────────────────────
export type ConversationListItem = {
  conversationId: string;
  conversationTitle: string | null;
  lastActivityAt: number | null;
  lastReadAt: number | null;
  joinedAt: number;
};

export type ConversationDetail = {
  id: string;
  title: string | null;
  createdBy: string;
  createdAt: number;
  members: Array<{ id: string; kind: 'user' | 'bot' }>;
};

// ── Messages ────────────────────────────────────────────────────────
export type Message = {
  id: string;
  senderId: string;
  content: ContentBlock[];
  inReplyToMessageId: string | null;
  updatedAt: number | null;
  clientUpdatedAt: number | null;
  deleted: boolean;
  deliveryFailed: boolean;
  reactions: ReactionSummary[];
};

export type MessageRow = {
  id: string;
  senderId: string;
  content: string;
  inReplyToMessageId: string | null;
  updatedAt: number | null;
  clientUpdatedAt: number | null;
  deleted: boolean;
  deliveryFailed: boolean;
  reactions: ReactionSummary[];
};

// ── Events ──────────────────────────────────────────────────────────
export type MessageCreatedEvent = {
  messageId: string;
  senderId: string;
  content: ContentBlock[];
  inReplyToMessageId: string | null;
  clientId: string | null;
};

export type MessageUpdatedEvent = {
  messageId: string;
  content: ContentBlock[];
  clientUpdatedAt: number | null;
};

export type MessageDeletedEvent = {
  messageId: string;
};

export type MessageDeliveryFailedEvent = {
  messageId: string;
};

export type TypingEvent = {
  memberId: string;
};

export type ReactionAddedEvent = {
  messageId: string;
  memberId: string;
  emoji: string;
};

export type ReactionRemovedEvent = {
  messageId: string;
  memberId: string;
  emoji: string;
};

export type ConversationCreatedEvent = {
  conversationId: string;
};

export type ConversationRenamedEvent = {
  conversationId: string;
  title: string;
};

export type ConversationLeftEvent = {
  conversationId: string;
};

export type ConversationReadEvent = {
  conversationId: string;
  memberId: string;
  lastReadAt: number;
};

export type ConversationActivityEvent = {
  conversationId: string;
  lastActivityAt: number;
};

// ── API request/response types ──────────────────────────────────────
export type CreateConversationRequest = {
  sandboxId: string;
  title?: string;
};

export type CreateConversationResponse = {
  conversationId: string;
};

export type CreateMessageRequest = {
  conversationId: string;
  content: ContentBlock[];
  inReplyToMessageId?: string;
  clientId?: string;
};

export type CreateMessageResponse = {
  messageId: string;
  clientId?: string;
};

export type EditMessageRequest = {
  conversationId: string;
  content: ContentBlock[];
  timestamp: number;
};

export type EditMessageResponse = {
  messageId: string;
};

export type DeleteMessageRequest = {
  conversationId: string;
};

export type RenameConversationRequest = {
  title: string;
};

export type ConversationListResponse = {
  conversations: ConversationListItem[];
  total: number;
  limit: number;
  offset: number;
};

export type MessageListResponse = {
  messages: MessageRow[];
};

export type ConversationDetailResponse = ConversationDetail;
