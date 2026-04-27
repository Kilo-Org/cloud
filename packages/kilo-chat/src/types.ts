import type { z } from 'zod';
import type { EventServiceClient } from '@kilocode/event-service';
import type {
  actionItemSchema,
  actionsBlockSchema,
  textBlockSchema,
  contentBlockSchema,
  reactionSummarySchema,
  messageSchema,
  conversationListItemSchema,
  conversationDetailSchema,
  conversationMemberSchema,
  enrichedConversationMemberSchema,
  createConversationRequestSchema,
  createConversationResponseSchema,
  createMessageRequestSchema,
  createMessageResponseSchema,
  editMessageRequestSchema,
  editMessageResponseSchema,
  deleteMessageRequestSchema,
  renameConversationRequestSchema,
  conversationListResponseSchema,
  messageListResponseSchema,
  conversationDetailResponseSchema,
  okResponseSchema,
  addReactionResponseSchema,
  executeActionRequestSchema,
  execApprovalDecisionSchema,
  botListConversationsResponseSchema,
  botListMessagesResponseSchema,
  botGetMembersResponseSchema,
  botConversationSummarySchema,
  botStatusRequestSchema,
  conversationStatusRequestSchema,
  botStatusRecordSchema,
  conversationStatusRecordSchema,
  getBotStatusResponseSchema,
  getConversationStatusResponseSchema,
} from './schemas';
import type {
  messageCreatedEventSchema,
  messageUpdatedEventSchema,
  messageDeletedEventSchema,
  messageDeliveryFailedEventSchema,
  typingEventSchema,
  reactionAddedEventSchema,
  reactionRemovedEventSchema,
  conversationCreatedEventSchema,
  conversationRenamedEventSchema,
  conversationLeftEventSchema,
  conversationReadEventSchema,
  conversationActivityEventSchema,
  actionExecutedEventSchema,
  actionDeliveryFailedEventSchema,
  botStatusEventSchema,
  conversationStatusEventSchema,
} from './events';

// ── Configuration ───────────────────────────────────────────────────
export type KiloChatClientConfig = {
  eventService: EventServiceClient;
  baseUrl: string;
  getToken: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
};

// ── Content blocks ──────────────────────────────────────────────────
export type TextBlock = z.infer<typeof textBlockSchema>;
export type ActionItem = z.infer<typeof actionItemSchema>;
export type ActionsBlock = z.infer<typeof actionsBlockSchema>;
export type ContentBlock = z.infer<typeof contentBlockSchema>;

// ── Reactions ───────────────────────────────────────────────────────
export type ReactionSummary = z.infer<typeof reactionSummarySchema>;

// ── Conversations ───────────────────────────────────────────────────
export type ConversationListItem = z.infer<typeof conversationListItemSchema>;
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;
export type ConversationMember = z.infer<typeof conversationMemberSchema>;
export type EnrichedConversationMember = z.infer<typeof enrichedConversationMemberSchema>;
export type BotConversationSummary = z.infer<typeof botConversationSummarySchema>;

// ── Messages ────────────────────────────────────────────────────────
export type Message = z.infer<typeof messageSchema>;

// ── Events ──────────────────────────────────────────────────────────
export type MessageCreatedEvent = z.infer<typeof messageCreatedEventSchema>;
export type MessageUpdatedEvent = z.infer<typeof messageUpdatedEventSchema>;
export type MessageDeletedEvent = z.infer<typeof messageDeletedEventSchema>;
export type MessageDeliveryFailedEvent = z.infer<typeof messageDeliveryFailedEventSchema>;
export type TypingEvent = z.infer<typeof typingEventSchema>;
export type ReactionAddedEvent = z.infer<typeof reactionAddedEventSchema>;
export type ReactionRemovedEvent = z.infer<typeof reactionRemovedEventSchema>;
export type ConversationCreatedEvent = z.infer<typeof conversationCreatedEventSchema>;
export type ConversationRenamedEvent = z.infer<typeof conversationRenamedEventSchema>;
export type ConversationLeftEvent = z.infer<typeof conversationLeftEventSchema>;
export type ConversationReadEvent = z.infer<typeof conversationReadEventSchema>;
export type ConversationActivityEvent = z.infer<typeof conversationActivityEventSchema>;
export type ActionExecutedEvent = z.infer<typeof actionExecutedEventSchema>;
export type ActionDeliveryFailedEvent = z.infer<typeof actionDeliveryFailedEventSchema>;
export type BotStatusEvent = z.infer<typeof botStatusEventSchema>;
export type ConversationStatusEvent = z.infer<typeof conversationStatusEventSchema>;

// ── API request/response types ──────────────────────────────────────
export type CreateConversationRequest = z.infer<typeof createConversationRequestSchema>;
export type CreateConversationResponse = z.infer<typeof createConversationResponseSchema>;
export type CreateMessageRequest = z.infer<typeof createMessageRequestSchema>;
export type CreateMessageResponse = z.infer<typeof createMessageResponseSchema>;
export type EditMessageRequest = z.infer<typeof editMessageRequestSchema>;
export type EditMessageResponse = z.infer<typeof editMessageResponseSchema>;
export type DeleteMessageRequest = z.infer<typeof deleteMessageRequestSchema>;
export type RenameConversationRequest = z.infer<typeof renameConversationRequestSchema>;
export type OkResponse = z.infer<typeof okResponseSchema>;
export type AddReactionResponse = z.infer<typeof addReactionResponseSchema>;
export type ExecuteActionRequest = z.infer<typeof executeActionRequestSchema>;
export type ExecApprovalDecision = z.infer<typeof execApprovalDecisionSchema>;
export type ConversationListResponse = z.infer<typeof conversationListResponseSchema>;
export type MessageListResponse = z.infer<typeof messageListResponseSchema>;
export type ConversationDetailResponse = z.infer<typeof conversationDetailResponseSchema>;

// Response types for the bot/plugin HTTP client (controller-proxied)
export type BotListConversationsResponse = z.infer<typeof botListConversationsResponseSchema>;
export type BotListMessagesResponse = z.infer<typeof botListMessagesResponseSchema>;
export type BotGetMembersResponse = z.infer<typeof botGetMembersResponseSchema>;

// ── Bot/conversation status (persisted via SandboxStatusDO) ─────────
export type BotStatusRequest = z.infer<typeof botStatusRequestSchema>;
export type ConversationStatusRequest = z.infer<typeof conversationStatusRequestSchema>;
export type BotStatusRecord = z.infer<typeof botStatusRecordSchema>;
export type ConversationStatusRecord = z.infer<typeof conversationStatusRecordSchema>;
export type GetBotStatusResponse = z.infer<typeof getBotStatusResponseSchema>;
export type GetConversationStatusResponse = z.infer<typeof getConversationStatusResponseSchema>;
