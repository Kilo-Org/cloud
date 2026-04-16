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
  version: number;
  updatedAt: number | null;
  deleted: boolean;
};

/** Raw message row from the API — content is JSON-stringified */
export type MessageRow = {
  id: string;
  senderId: string;
  content: string;
  inReplyToMessageId: string | null;
  version: number;
  updatedAt: number | null;
  deleted: boolean;
};

// ── SSE events ──────────────────────────────────────────────────────
export type MessageCreatedEvent = {
  messageId: string;
  senderId: string;
  content: ContentBlock[];
  version: number;
  inReplyToMessageId: string | null;
};

export type MessageUpdatedEvent = {
  messageId: string;
  content: ContentBlock[];
  version: number;
};

export type MessageDeletedEvent = {
  messageId: string;
};

export type TypingEvent = {
  memberId: string;
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
};

export type CreateMessageResponse = {
  messageId: string;
  version: number;
};

export type EditMessageRequest = {
  conversationId: string;
  content: ContentBlock[];
  version: number;
};

export type EditMessageResponse = {
  messageId: string;
  version: number;
};

export type DeleteMessageRequest = {
  conversationId: string;
};

export type ConversationListResponse = {
  conversations: ConversationListItem[];
};

export type MessageListResponse = {
  messages: MessageRow[];
};

export type ConversationDetailResponse = ConversationDetail;
