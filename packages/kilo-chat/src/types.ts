// ── Configuration ───────────────────────────────────────────────────
export type KiloChatConfig = {
  baseUrl: string;
  getToken: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
};

// ── Content blocks ──────────────────────────────────────────────────
export type TextBlock = { type: 'text'; text: string };
export type ContentBlock = TextBlock; // union — extend when new types land

// ── Conversations ───────────────────────────────────────────────────
export type ConversationListItem = {
  conversationId: string;
  conversationTitle: string | null;
  lastMessageId: string | null;
  lastReadMessageId: string | null;
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
};

// ── SSE events ──────────────────────────────────────────────────────
export type MessageCreatedEvent = {
  messageId: string;
  senderId: string;
  content: ContentBlock[];
  inReplyToMessageId: string | null;
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

export type SSEEventHandler = {
  onMessageCreated?: (event: MessageCreatedEvent) => void;
  onMessageUpdated?: (event: MessageUpdatedEvent) => void;
  onMessageDeleted?: (event: MessageDeletedEvent) => void;
  onMessageDeliveryFailed?: (event: MessageDeliveryFailedEvent) => void;
  onTyping?: (event: TypingEvent) => void;
  onError?: (error: Error) => void;
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
};

export type MessageListResponse = {
  messages: MessageRow[];
};

export type ConversationDetailResponse = ConversationDetail;
