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
export const nonNegativeIntegerSchema = z.number().int().nonnegative();

const SANDBOX_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const sandboxIdSchema = z.string().regex(SANDBOX_ID_PATTERN, 'Invalid sandboxId');
export const nonEmptyStringSchema = z.string().min(1);

// Approval decision values produced by openclaw's approval runtime. Kept in
// lockstep with `ExecApprovalDecision` from `openclaw/plugin-sdk/approval-runtime`.
export const execApprovalDecisionSchema = z.enum(['allow-once', 'allow-always', 'deny']);
export const actionGroupIdSchema = z.string().min(1).max(ACTION_LABEL_MAX_CHARS);

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

export const conversationTitleSchema = trimmedNonEmptyString(CONVERSATION_TITLE_MAX_CHARS);

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

export const actionResolutionSchema = z.object({
  value: execApprovalDecisionSchema,
  resolvedBy: nonEmptyStringSchema,
  resolvedAt: nonNegativeIntegerSchema,
});

export const inputActionsBlockSchema = z.object({
  type: z.literal('actions'),
  groupId: actionGroupIdSchema,
  actions: z.array(actionItemSchema).min(1).max(10),
  resolved: z.never().optional(),
});

export const actionsBlockSchema = z
  .object({
    type: z.literal('actions'),
    groupId: actionGroupIdSchema,
    actions: z.array(actionItemSchema).max(10),
    resolved: actionResolutionSchema.optional(),
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

export const inputContentBlockSchema = z.discriminatedUnion('type', [
  textBlockSchema,
  inputActionsBlockSchema,
]);

// ── Reactions ───────────────────────────────────────────────────────

export const reactionSummarySchema = z.object({
  emoji: z.string(),
  count: z.number(),
  memberIds: z.array(z.string()),
});

// ── Messages ────────────────────────────────────────────────────────

export const replyToMessageSnapshotSchema = z.object({
  messageId: z.string(),
  senderId: z.string().nullable(),
  deleted: z.boolean(),
  previewText: z.string().nullable(),
});

export const messageSchema = z.object({
  id: z.string(),
  senderId: z.string(),
  content: z.array(contentBlockSchema),
  inReplyToMessageId: z.string().nullable(),
  replyTo: replyToMessageSnapshotSchema.nullable(),
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

export const conversationDetailMemberSchema = conversationMemberSchema.extend({
  displayName: z.string().nullish(),
  avatarUrl: z.string().nullish(),
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

export const conversationCursorSchema = z.object({
  t: z.number().int().nonnegative(),
  c: ulidSchema,
});

export const conversationDetailSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.number(),
  members: z.array(conversationDetailMemberSchema),
});

// ── Request / response schemas ──────────────────────────────────────

export const createConversationRequestSchema = z.object({
  sandboxId: sandboxIdSchema,
  title: conversationTitleSchema.optional(),
});

export const createConversationResponseSchema = z.object({
  conversationId: ulidSchema,
  conversation: conversationListItemSchema,
});

export const okResponseSchema = z.object({ ok: z.literal(true) });

export const createMessageRequestSchema = z.object({
  conversationId: ulidSchema,
  content: z.array(inputContentBlockSchema).min(1).max(20),
  inReplyToMessageId: ulidSchema.optional(),
  clientId: ulidSchema.optional(),
});

export const createMessageResponseSchema = z.object({
  messageId: z.string().min(1),
  clientId: z.string().optional(),
  message: messageSchema,
});

export const editMessageRequestSchema = z.object({
  conversationId: ulidSchema,
  content: z.array(inputContentBlockSchema).min(1).max(20),
  timestamp: z.number().int().positive(),
});

export const editMessageResponseSchema = z.object({
  messageId: z.string().optional(),
});

export const deleteMessageRequestSchema = z.object({
  conversationId: ulidSchema,
});

export const renameConversationRequestSchema = z.object({
  title: conversationTitleSchema,
});

export const markConversationReadRequestSchema = z.object({
  lastSeenMessageId: ulidSchema,
});

export const badgeClearResponseSchema = z.object({
  badgeBucket: z.string().min(1),
  badgeCount: nonNegativeIntegerSchema,
});

export const markConversationReadResponseSchema = okResponseSchema.extend({
  applied: z.boolean(),
  lastReadAt: nonNegativeIntegerSchema,
  badgeClear: badgeClearResponseSchema.nullable(),
});

export const executeActionRequestSchema = z.object({
  groupId: actionGroupIdSchema,
  value: execApprovalDecisionSchema,
});

export const executeActionResponseSchema = okResponseSchema.extend({
  messageId: ulidSchema,
  content: z.array(contentBlockSchema),
  resolved: z.object({
    groupId: actionGroupIdSchema,
    value: execApprovalDecisionSchema,
    resolvedBy: z.string().min(1),
    resolvedAt: nonNegativeIntegerSchema,
  }),
});

export const reactionRequestBodySchema = z.object({
  conversationId: ulidSchema,
  emoji: emojiSchema,
});

export const addReactionResponseSchema = z.object({
  id: z.string().min(1),
});

export const removeReactionResponseSchema = z.discriminatedUnion('removed', [
  z.object({ removed: z.literal(true), id: z.string().min(1) }),
  z.object({ removed: z.literal(false), id: z.string().min(1).nullable() }),
]);

export const conversationListResponseSchema = z.object({
  conversations: z.array(conversationListItemSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

export const messageListResponseSchema = z.object({
  messages: z.array(messageSchema),
  hasMore: z.boolean().default(false),
  nextCursor: ulidSchema.nullable().default(null),
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
  at: nonNegativeIntegerSchema,
});

export const conversationStatusRequestSchema = z.object({
  contextTokens: nonNegativeIntegerSchema,
  contextWindow: nonNegativeIntegerSchema,
  model: z.string().nullable(),
  provider: z.string().nullable(),
  at: nonNegativeIntegerSchema,
});

export const botStatusRecordSchema = z.object({
  online: z.boolean(),
  at: nonNegativeIntegerSchema,
  updatedAt: nonNegativeIntegerSchema,
});

export const conversationStatusRecordSchema = z.object({
  conversationId: z.string(),
  contextTokens: nonNegativeIntegerSchema,
  contextWindow: nonNegativeIntegerSchema,
  model: z.string().nullable(),
  provider: z.string().nullable(),
  at: nonNegativeIntegerSchema,
  updatedAt: nonNegativeIntegerSchema,
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

export const typingRequestSchema = z.object({
  conversationId: z.string().min(1),
});

export const createBotConversationRequestSchema = z.object({
  title: conversationTitleSchema.optional(),
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
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});
