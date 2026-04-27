import { z } from 'zod';

// ── Length caps (shared with the UI) ────────────────────────────────

/** Maximum characters allowed in a single `text` content block. */
export const MESSAGE_TEXT_MAX_CHARS = 8000;
/** Maximum characters allowed in a conversation title (auto or user-set). */
export const CONVERSATION_TITLE_MAX_CHARS = 200;
/** Maximum characters allowed in an action button label or group id. */
export const ACTION_LABEL_MAX_CHARS = 200;

// ── Primitives ──────────────────────────────────────────────────────

export const ulidSchema = z.string().ulid();

const SANDBOX_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const sandboxIdSchema = z.string().regex(SANDBOX_ID_PATTERN, 'Invalid sandboxId');

// Approval decision values produced by openclaw's approval runtime. Kept in
// lockstep with `ExecApprovalDecision` from `openclaw/plugin-sdk/approval-runtime`.
export const execApprovalDecisionSchema = z.enum(['allow-once', 'allow-always', 'deny']);

// Accepts strings up to `max` chars, trims leading/trailing whitespace, and
// rejects values that become empty after trimming. Control characters are
// intentionally NOT filtered — if users send garbage, so be it; the concern
// here is only catching blank/whitespace-only titles that would render as
// empty rows in the UI.
const trimmedNonEmptyString = (max: number) =>
  z
    .string()
    .max(max)
    .transform(s => s.trim())
    .refine(s => s.length >= 1, { message: 'must not be empty or whitespace-only' });

// 1-64 bytes UTF-8, no C0 (0x00-0x1F) or C1 (0x7F-0x9F) control chars.
export const emojiSchema = z
  .string()
  .min(1, 'emoji required')
  .refine(v => new TextEncoder().encode(v).length <= 64, { message: 'emoji too long' })
  .refine(
    v => {
      for (let i = 0; i < v.length; i++) {
        const c = v.charCodeAt(i);
        if ((c >= 0x00 && c <= 0x1f) || (c >= 0x7f && c <= 0x9f)) return false;
      }
      return true;
    },
    { message: 'emoji contains control chars' }
  );

// ── Content blocks ──────────────────────────────────────────────────

export const actionItemSchema = z.object({
  label: z.string().min(1).max(ACTION_LABEL_MAX_CHARS),
  style: z.enum(['primary', 'danger', 'secondary']),
  value: execApprovalDecisionSchema,
});

export const actionsBlockSchema = z
  .object({
    type: z.literal('actions'),
    groupId: z.string().min(1).max(ACTION_LABEL_MAX_CHARS),
    actions: z.array(actionItemSchema).max(10),
    resolved: z
      .object({
        value: execApprovalDecisionSchema,
        resolvedBy: z.string(),
        resolvedAt: z.number(),
      })
      .optional(),
  })
  .refine(block => block.resolved !== undefined || block.actions.length >= 1, {
    message: 'actions must contain at least one item unless the block is resolved',
    path: ['actions'],
  });

export const textBlockSchema = z.object({
  type: z.literal('text'),
  text: trimmedNonEmptyString(MESSAGE_TEXT_MAX_CHARS),
});

export const contentBlockSchema = z.discriminatedUnion('type', [
  textBlockSchema,
  actionsBlockSchema,
]);

// ── Reactions ───────────────────────────────────────────────────────

export const reactionSummarySchema = z.object({
  emoji: z.string(),
  count: z.number(),
  memberIds: z.array(z.string()),
});

// ── Messages ────────────────────────────────────────────────────────

export const messageSchema = z.object({
  id: z.string(),
  senderId: z.string(),
  content: z.array(contentBlockSchema),
  inReplyToMessageId: z.string().nullable(),
  updatedAt: z.number().nullable(),
  clientUpdatedAt: z.number().nullable(),
  deleted: z.boolean(),
  deliveryFailed: z.boolean(),
  reactions: z.array(reactionSummarySchema),
});

// ── Conversation members ────────────────────────────────────────────

export const memberKindSchema = z.enum(['user', 'bot']);

export const conversationMemberSchema = z.object({
  id: z.string(),
  kind: memberKindSchema,
});

export const enrichedConversationMemberSchema = z.object({
  id: z.string(),
  kind: z.string(),
  displayName: z.string().nullish(),
  avatarUrl: z.string().nullish(),
});

// ── Conversations ───────────────────────────────────────────────────

export const conversationListItemSchema = z.object({
  conversationId: z.string(),
  title: z.string().nullable(),
  lastActivityAt: z.number().nullable(),
  lastReadAt: z.number().nullable(),
  joinedAt: z.number(),
});

export const conversationDetailSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.number(),
  members: z.array(conversationMemberSchema),
});

// ── Request / response schemas ──────────────────────────────────────

export const createConversationRequestSchema = z.object({
  sandboxId: sandboxIdSchema,
  title: trimmedNonEmptyString(CONVERSATION_TITLE_MAX_CHARS).optional(),
});

export const createConversationResponseSchema = z.object({
  conversationId: ulidSchema,
});

export const okResponseSchema = z.object({ ok: z.literal(true) });

export const createMessageRequestSchema = z.object({
  conversationId: ulidSchema,
  content: z.array(contentBlockSchema).min(1).max(20),
  inReplyToMessageId: ulidSchema.optional(),
  clientId: ulidSchema.optional(),
});

export const createMessageResponseSchema = z.object({
  messageId: z.string().min(1),
  clientId: z.string().optional(),
});

export const editMessageRequestSchema = z.object({
  conversationId: ulidSchema,
  content: z.array(contentBlockSchema).min(1).max(20),
  timestamp: z.number().int().positive(),
});

export const editMessageResponseSchema = z.object({
  messageId: z.string().optional(),
});

export const deleteMessageRequestSchema = z.object({
  conversationId: ulidSchema,
});

export const renameConversationRequestSchema = z.object({
  title: trimmedNonEmptyString(CONVERSATION_TITLE_MAX_CHARS),
});

export const executeActionRequestSchema = z.object({
  groupId: z.string().min(1).max(ACTION_LABEL_MAX_CHARS),
  value: execApprovalDecisionSchema,
});

export const reactionRequestBodySchema = z.object({
  conversationId: ulidSchema,
  emoji: emojiSchema,
});

export const addReactionResponseSchema = z.object({
  id: z.string().min(1),
});

export const conversationListResponseSchema = z.object({
  conversations: z.array(conversationListItemSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

export const messageListResponseSchema = z.object({
  messages: z.array(messageSchema),
});

export const conversationDetailResponseSchema = conversationDetailSchema;

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const cursorPaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});

export const listConversationsQuerySchema = cursorPaginationQuerySchema.extend({
  sandboxId: sandboxIdSchema.optional(),
});

export const deleteMessageQuerySchema = z.object({
  conversationId: ulidSchema,
});

export const listMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: ulidSchema.optional(),
});

export const botStatusRequestSchema = z.object({
  online: z.boolean(),
  at: z.number(),
});

export const conversationStatusRequestSchema = z.object({
  contextTokens: z.number(),
  contextWindow: z.number(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  at: z.number(),
});

export const botStatusRecordSchema = z.object({
  online: z.boolean(),
  at: z.number(),
  updatedAt: z.number(),
});

export const conversationStatusRecordSchema = z.object({
  conversationId: z.string(),
  contextTokens: z.number(),
  contextWindow: z.number(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  at: z.number(),
  updatedAt: z.number(),
});

export const getBotStatusResponseSchema = z.object({
  status: botStatusRecordSchema.nullable(),
});

export const getConversationStatusResponseSchema = z.object({
  status: conversationStatusRecordSchema.nullable(),
});

// Diagnostic-only body; reason is logged and dropped. `loose()` accepts extra keys.
export const messageDeliveryFailedRequestSchema = z
  .object({ reason: z.string().max(1000).optional() })
  .loose();

export const actionDeliveryFailedRequestSchema = z.object({
  messageId: z.string().min(1),
  reason: z.string().max(1000).optional(),
});

export const createBotConversationRequestSchema = z.object({
  title: trimmedNonEmptyString(CONVERSATION_TITLE_MAX_CHARS).optional(),
  additionalMembers: z.array(z.string().min(1)).max(20).optional(),
});

// ── Plugin client response schemas (controller-proxied bot endpoints) ───────

export const botGetMembersResponseSchema = z.object({
  members: z.array(enrichedConversationMemberSchema),
});

export const botConversationSummarySchema = z.object({
  conversationId: z.string(),
  title: z.string().nullable(),
  lastActivityAt: z.number().nullable(),
  members: z.array(enrichedConversationMemberSchema),
});

export const botListConversationsResponseSchema = z.object({
  conversations: z.array(botConversationSummarySchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

export const botListMessagesResponseSchema = z.object({
  messages: z.array(messageSchema),
});
