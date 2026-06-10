import {
  attachmentInitRequestSchema,
  buildReplyToMessageSnapshot,
  type ContentBlock,
  type ActionsBlock,
  type Message,
  type ReactionSummary,
  type ExecApprovalDecision,
} from '@kilocode/kilo-chat';
import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import { logger } from '../util/logger';
import { headObject } from '../util/presigner';
import {
  deliverToBot,
  deliverActionExecutedToBot,
  type ActionExecutedWebhookMessage,
  type WebhookMessage,
} from '../webhook/deliver';

/**
 * Parses stored message content JSON. Content was validated by Zod at write
 * time (route handler → createMessage/editMessage), so we trust the stored
 * shape and use a type assertion instead of re-validating on every read.
 */
function parseStoredContent(rawContent: string, messageId: string): ContentBlock[] {
  try {
    return JSON.parse(rawContent) as ContentBlock[];
  } catch (err) {
    logger.error('Unparseable message content', {
      messageId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { eq, lt, gte, desc, and, sql, inArray } from 'drizzle-orm';
import {
  attachments,
  botMessageNotifications,
  conversation,
  members,
  messages,
  reactions,
} from '../db/conversation-schema';
import { buildAttachmentR2Key } from '../util/attachment-key';
import {
  BOT_MESSAGE_NOTIFICATION_MIN_TEXT_CHARS,
  BOT_MESSAGE_NOTIFICATION_TIMEOUT_MS,
  botMessageNotificationTextLength,
  sendConversationMessagePush,
} from '../services/push-notifications';
import migrations from '../../drizzle/conversation/migrations';
import { monotonicFactory } from 'ulid';

type StoredMessageRow = typeof messages.$inferSelect;
type BotMessageNotificationReason = 'length' | 'typing_stop' | 'timeout';
type StoredAttachmentRow = typeof attachments.$inferSelect;

const INIT_DEDUPE_WINDOW_MS = 30_000;
const MAX_ATTACHMENTS_PER_MESSAGE = 10;

class AttachmentAlreadyLinkedError extends Error {}

// Validates the RPC input for initAttachment. Reuses the size/mimeType/filename
// rules from the public request schema so the DO and the HTTP route stay in
// lockstep — only swapping conversationId for the trusted uploaderId.
const initAttachmentInternalSchema = attachmentInitRequestSchema
  .omit({ conversationId: true })
  .extend({ uploaderId: z.string().min(1) });

function buildReplySnapshot(
  messageId: string,
  parent: StoredMessageRow | undefined
): Message['replyTo'] {
  return buildReplyToMessageSnapshot(
    messageId,
    parent
      ? {
          senderId: parent.sender_id,
          deleted: parent.deleted === 1,
          content: parent.deleted === 1 ? [] : parseStoredContent(parent.content, parent.id),
        }
      : null
  );
}

function storedMessageRowToMessage(
  row: StoredMessageRow,
  replyParentById: Map<string, StoredMessageRow>,
  reactionsByMessage: Map<string, ReactionSummary[]>
): Message {
  return {
    id: row.id,
    senderId: row.sender_id,
    content: row.deleted === 1 ? [] : parseStoredContent(row.content, row.id),
    inReplyToMessageId: row.in_reply_to_message_id,
    replyTo: row.in_reply_to_message_id
      ? buildReplySnapshot(
          row.in_reply_to_message_id,
          replyParentById.get(row.in_reply_to_message_id)
        )
      : null,
    updatedAt: row.updated_at,
    clientUpdatedAt: row.client_updated_at,
    deleted: row.deleted === 1,
    deliveryFailed: row.delivery_failed === 1,
    reactions: reactionsByMessage.get(row.id) ?? [],
  };
}

export type MemberContext = {
  humanMemberIds: string[];
  sandboxId: string | null;
};

type ActiveMemberRow = {
  id: string;
  kind: 'user' | 'bot';
};

export type InitializeParams = {
  id: string;
  title: string | null;
  createdBy: string;
  createdAt: number;
  members: Array<{ id: string; kind: 'user' | 'bot' }>;
};

export type ConversationInfo = {
  id: string;
  title: string | null;
  createdBy: string;
  createdAt: number;
  members: Array<{ id: string; kind: 'user' | 'bot' }>;
};

export type UpdateTitleIfMemberResult =
  | { ok: true; members: Array<{ id: string; kind: 'user' | 'bot' }> }
  | { ok: false; code: 'forbidden'; error: string };

export type LeaveMemberIfMemberResult =
  | {
      ok: true;
      remainingUsers: Array<{ id: string }>;
      botMembers: Array<{ id: string }>;
    }
  | { ok: false; code: 'forbidden'; error: string };

export type DestroyResult = {
  members: Array<{ id: string; kind: 'user' | 'bot' }>;
} | null;

export type CreateMessageParams = {
  senderId: string;
  content: ContentBlock[];
  inReplyToMessageId?: string;
};

export type CreateMessageResult =
  | { ok: true; messageId: string; message: MessageRow; info: ConversationInfo }
  | { ok: false; code: 'forbidden' | 'invalid' | 'conflict' | 'internal'; error: string };

export type ListMessagesParams = {
  limit: number;
  before?: string;
};

export type MessageReactionSummary = ReactionSummary;

export type GetMessageResult = {
  id: string;
  senderId: string;
  content: ContentBlock[];
  deleted: boolean;
} | null;

export type ResolveMarkReadResult =
  | {
      ok: true;
      sandboxId: string | null;
      latestNonDeletedMessageId: string | null;
    }
  | { ok: false; code: 'forbidden' | 'invalid'; error: string };

export type MessageRow = Message;

export type ListMessagesResult = {
  messages: MessageRow[];
  hasMore: boolean;
  nextCursor: string | null;
};

export type EditMessageParams = {
  messageId: string;
  senderId: string;
  content: ContentBlock[];
  clientTimestamp: number;
};

export type EditMessageResult =
  | {
      ok: true;
      stale: false;
      messageId: string;
      content: ContentBlock[];
      memberContext: MemberContext;
    }
  | { ok: true; stale: true; messageId: string }
  | { ok: false; code: 'not_found' | 'forbidden' | 'conflict'; error: string };

export type DeleteMessageParams = {
  messageId: string;
  senderId: string;
};

export type DeleteMessageResult =
  | { ok: true; memberContext: MemberContext }
  | { ok: false; code: 'not_found' | 'forbidden'; error: string };

export type ExecuteActionParams = {
  messageId: string;
  memberId: string;
  groupId: string;
  value: ExecApprovalDecision;
};

export type ExecuteActionResult =
  | {
      ok: true;
      content: ContentBlock[];
      messageSenderId: string;
      memberContext: MemberContext;
      targetBotId: string | null;
      resolved: {
        groupId: string;
        value: ExecApprovalDecision;
        resolvedBy: string;
        resolvedAt: number;
      };
    }
  | {
      ok: false;
      code: 'not_found' | 'forbidden' | 'already_resolved' | 'invalid_value';
      error: string;
    };

export type RevertActionResolutionResult =
  | { ok: true; reverted: boolean }
  | { ok: false; code: 'not_found'; error: string };

export type NotifyDeliveryFailedResult =
  | { ok: true; changed: boolean }
  | { ok: false; code: 'not_found'; error: string };

export type InitAttachmentParams = {
  uploaderId: string;
  mimeType: string;
  size: number;
  filename: string;
  idempotencyKey?: string;
};

export type InitAttachmentOk = {
  ok: true;
  attachmentId: string;
  r2Key: string;
};
export type InitAttachmentErr = {
  ok: false;
  code: 'forbidden' | 'invalid';
  error: string;
};
export type InitAttachmentResult = InitAttachmentOk | InitAttachmentErr;

export type AttachmentForRead = {
  id: string;
  r2Key: string;
  mimeType: string;
  size: number;
  filename: string;
};

export type GetAttachmentForReadParams = { requesterId: string; attachmentId: string };
export type GetAttachmentForReadResult =
  | { ok: true; row: AttachmentForRead | null }
  | { ok: false; code: 'forbidden'; error: string };

export type AddReactionParams = { messageId: string; memberId: string; emoji: string };
export type AddReactionResult =
  | { ok: true; added: true; id: string; memberContext: MemberContext }
  | { ok: true; added: false; id: string }
  | { ok: false; code: 'forbidden' | 'not_found' | 'internal'; error: string };
export type RemoveReactionParams = { messageId: string; memberId: string; emoji: string };
export type RemoveReactionResult =
  | { ok: true; removed: true; removed_id: string; memberContext: MemberContext }
  | { ok: true; removed: false; removed_id: string | null }
  | { ok: false; code: 'forbidden' | 'not_found' | 'internal'; error: string };

export class ConversationDO extends DurableObject<Env> {
  private db;
  private nextUlid = monotonicFactory();
  private keyPrefix: string;
  private static readonly ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;

  // Per-conversation serializer for outbound bot webhooks. createMessage
  // RPCs are already serialized by the DO's single-threaded model, so the
  // ULIDs are monotonic on arrival. But the original fan-out spawned each
  // delivery in an independent worker-level `ctx.waitUntil`, letting rapid
  // sends reorder in flight. Chaining all deliveries through this promise
  // guarantees the bot sees messages in DO-arrival order. A rejection on
  // the chain is swallowed so a single failed delivery doesn't block
  // subsequent ones (matches the client-side send queue's policy in
  // packages/kilo-chat/src/client.ts).
  //
  // If the DO is evicted mid-burst, any in-flight delivery continues under
  // its own `ctx.waitUntil` and the next-session chain starts fresh. That
  // window is rare and doesn't affect the common case.
  private webhookChain: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });
    this.keyPrefix = env.KEY_PREFIX ?? '';
    void ctx.blockConcurrencyWhile(() => migrate(this.db, migrations));
  }

  /**
   * Returns the canonical conversation id used for R2 key construction.
   * Falls back to `ctx.id.name` (set when the DO is referenced via
   * `idFromName`) if `initialize` has not been called.
   */
  private getConversationId(): string {
    const info = this.getInfo();
    const id = info?.id ?? this.ctx.id.name;
    if (!id) {
      throw new Error('ConversationDO: conversation id not available');
    }
    return id;
  }

  private async scheduleR2Deletes(keys: readonly string[]): Promise<void> {
    await Promise.all(
      keys.map(k =>
        this.env.MEDIA_BUCKET.delete(k).catch((err: unknown) => {
          logger.warn('R2 delete failed', { key: k, error: String(err) });
        })
      )
    );
  }

  private async validateUploadedAttachmentObjects(
    rows: readonly StoredAttachmentRow[]
  ): Promise<{ code: 'conflict'; error: string } | null> {
    for (const row of rows) {
      const object = await this.headUploadedAttachmentObject(row.r2_key);
      if (!object) {
        return { code: 'conflict', error: 'Attachment upload is missing' };
      }
      if (object.size !== row.size) {
        return {
          code: 'conflict',
          error: `Attachment upload size ${object.size} does not match declared size ${row.size}`,
        };
      }
    }
    return null;
  }

  private async headUploadedAttachmentObject(key: string): Promise<{ size: number } | null> {
    const object = await this.env.MEDIA_BUCKET.head(key);
    if (object) return { size: object.size };

    // Local dev can upload through a presigned R2 URL before Wrangler's remote
    // R2 binding sees the object. Fall back to the same S3-compatible API path
    // used for the upload so we still reject truly missing objects.
    const [accessKeyId, secretAccessKey] = await Promise.all([
      this.env.R2_ACCESS_KEY_ID.get().catch(() => null),
      this.env.R2_SECRET_ACCESS_KEY.get().catch(() => null),
    ]);
    if (!accessKeyId || !secretAccessKey) return null;

    try {
      return await headObject({
        accountId: this.env.R2_ACCOUNT_ID,
        bucket: this.env.R2_BUCKET_NAME,
        accessKeyId,
        secretAccessKey,
        key,
      });
    } catch (err) {
      logger.warn('remote R2 HEAD fallback failed', { key, error: String(err) });
      return null;
    }
  }

  private canonicalizeAttachmentBlocks(
    content: readonly ContentBlock[],
    attachmentRows: readonly StoredAttachmentRow[]
  ): ContentBlock[] {
    if (attachmentRows.length === 0) return [...content];
    const attachmentsById = new Map(attachmentRows.map(row => [row.id, row]));
    return content.map(block => {
      if (block.type !== 'attachment') return block;
      const row = attachmentsById.get(block.attachmentId);
      if (!row) return block;
      return {
        type: 'attachment',
        attachmentId: row.id,
        mimeType: row.mime_type,
        size: row.size,
        filename: row.filename,
      };
    });
  }

  async enqueueMessageWebhook(msg: WebhookMessage, convContext: MemberContext): Promise<void> {
    this.webhookChain = this.webhookChain
      .catch(() => {})
      .then(() => deliverToBot(this.env, msg, convContext));
    this.ctx.waitUntil(this.webhookChain);
  }

  async enqueueActionExecutedWebhook(msg: ActionExecutedWebhookMessage): Promise<void> {
    this.webhookChain = this.webhookChain
      .catch(() => {})
      .then(() => deliverActionExecutedToBot(this.env, msg));
    this.ctx.waitUntil(this.webhookChain);
  }

  notifyDeliveryFailed(messageId: string): NotifyDeliveryFailedResult {
    const row = this.db.select().from(messages).where(eq(messages.id, messageId)).get();
    if (!row || row.deleted === 1) {
      return { ok: false, code: 'not_found', error: 'Message not found' };
    }

    if (row.delivery_failed === 1) {
      return { ok: true, changed: false };
    }

    this.db.update(messages).set({ delivery_failed: 1 }).where(eq(messages.id, messageId)).run();
    return { ok: true, changed: true };
  }

  revertActionResolution(params: {
    messageId: string;
    groupId: string;
  }): RevertActionResolutionResult {
    const row = this.db.select().from(messages).where(eq(messages.id, params.messageId)).get();
    if (!row || row.deleted === 1) {
      return { ok: false, code: 'not_found', error: 'Message not found' };
    }
    const content = parseStoredContent(row.content, row.id);
    const actionsBlock = content.find(
      (b): b is ActionsBlock => b.type === 'actions' && b.groupId === params.groupId
    );
    if (!actionsBlock) {
      return { ok: false, code: 'not_found', error: 'Action group not found' };
    }
    // Idempotent: already unresolved is a no-op success.
    if (!actionsBlock.resolved) {
      return { ok: true, reverted: false };
    }
    actionsBlock.resolved = undefined;
    const newVersion = row.version + 1;
    this.db
      .update(messages)
      .set({
        content: JSON.stringify(content),
        version: newVersion,
        updated_at: Date.now(),
      })
      .where(eq(messages.id, params.messageId))
      .run();
    return { ok: true, reverted: true };
  }

  initialize(params: InitializeParams): { ok: true } | { ok: false; error: string } {
    try {
      this.db.transaction(tx => {
        // Insert members before conversation — conversation.created_by has FK to members.id
        tx.insert(members)
          .values(
            params.members.map(member => ({
              id: member.id,
              kind: member.kind,
              joined_at: params.createdAt,
            }))
          )
          .onConflictDoNothing()
          .run();

        tx.insert(conversation)
          .values({
            id: params.id,
            title: params.title,
            created_by: params.createdBy,
            created_at: params.createdAt,
          })
          .onConflictDoNothing()
          .run();
      });

      return { ok: true };
    } catch (err) {
      if (err instanceof Error && /constraint/i.test(err.message)) {
        return { ok: false, error: err.message };
      }
      throw err;
    }
  }

  getInfo(): ConversationInfo | null {
    const convRow = this.db.select().from(conversation).get();
    if (!convRow) return null;

    const memberRows = this.getActiveMemberRows();

    return {
      id: convRow.id,
      title: convRow.title,
      createdBy: convRow.created_by,
      createdAt: convRow.created_at,
      members: memberRows,
    };
  }

  isMember(memberId: string): boolean {
    const row = this.db
      .select()
      .from(members)
      .where(and(eq(members.id, memberId), sql`${members.left_at} IS NULL`))
      .get();
    return row !== undefined;
  }

  private getActiveMemberRows(): ActiveMemberRow[] {
    return this.db
      .select({ id: members.id, kind: members.kind })
      .from(members)
      .where(sql`${members.left_at} IS NULL`)
      .all()
      .map(member => ({ id: member.id, kind: member.kind === 'user' ? 'user' : 'bot' }));
  }

  private getMemberContextFromRows(activeMembers: ActiveMemberRow[]): MemberContext {
    const humanMemberIds = activeMembers.filter(m => m.kind === 'user').map(m => m.id);
    const botMember = activeMembers.find(m => m.kind === 'bot');
    const sandboxId = botMember ? (botMember.id.match(/^bot:kiloclaw:(.+)$/)?.[1] ?? null) : null;

    return { humanMemberIds, sandboxId };
  }

  private getMemberContextIfActive(memberId: string): MemberContext | null {
    const activeMembers = this.getActiveMemberRows();
    if (!activeMembers.some(member => member.id === memberId)) {
      return null;
    }
    return this.getMemberContextFromRows(activeMembers);
  }

  private getMemberContext(): MemberContext {
    return this.getMemberContextFromRows(this.getActiveMemberRows());
  }

  private isBotMember(memberId: string): boolean {
    return this.getActiveMemberRows().some(
      member => member.id === memberId && member.kind === 'bot'
    );
  }

  private scheduleBotNotificationAlarm(notifyAfter: number): void {
    this.ctx.waitUntil(
      (async () => {
        const currentAlarm = await this.ctx.storage.getAlarm();
        if (currentAlarm === null || notifyAfter < currentAlarm) {
          await this.ctx.storage.setAlarm(notifyAfter);
        }
      })()
    );
  }

  private registerBotMessageNotification(
    messageId: string,
    botId: string,
    content: ContentBlock[]
  ): void {
    const createdAt = Date.now();
    const notifyAfter = createdAt + BOT_MESSAGE_NOTIFICATION_TIMEOUT_MS;

    this.db
      .insert(botMessageNotifications)
      .values({
        message_id: messageId,
        bot_id: botId,
        content: JSON.stringify(content),
        created_at: createdAt,
        notify_after: notifyAfter,
      })
      .run();

    this.scheduleBotNotificationAlarm(notifyAfter);
  }

  private claimBotMessageNotification(
    messageId: string,
    reason: BotMessageNotificationReason
  ): { messageId: string; botId: string; content: ContentBlock[] } | null {
    const row = this.db
      .select()
      .from(botMessageNotifications)
      .where(eq(botMessageNotifications.message_id, messageId))
      .get();

    if (!row || row.notified_at !== null) return null;

    const notifiedAt = Date.now();
    this.db
      .update(botMessageNotifications)
      .set({ notified_at: notifiedAt, notified_reason: reason })
      .where(
        and(
          eq(botMessageNotifications.message_id, messageId),
          sql`${botMessageNotifications.notified_at} IS NULL`
        )
      )
      .run();

    const claimed = this.db
      .select()
      .from(botMessageNotifications)
      .where(eq(botMessageNotifications.message_id, messageId))
      .get();

    if (!claimed || claimed.notified_at !== notifiedAt) return null;

    return {
      messageId: claimed.message_id,
      botId: claimed.bot_id,
      content: parseStoredContent(claimed.content, claimed.message_id),
    };
  }

  private dispatchClaimedBotMessageNotification(
    claimed: { messageId: string; botId: string; content: ContentBlock[] },
    reason: BotMessageNotificationReason
  ): void {
    const info = this.getInfo();
    if (!info) return;
    const memberContext = this.getMemberContext();
    if (!memberContext.sandboxId) return;

    const logContext =
      reason === 'length'
        ? 'bot.length'
        : reason === 'typing_stop'
          ? 'bot.typing_stop'
          : 'bot.timeout';

    this.ctx.waitUntil(
      sendConversationMessagePush(this.env, {
        conversationId: info.id,
        sandboxId: memberContext.sandboxId,
        title: info.title,
        humanMemberIds: memberContext.humanMemberIds,
        senderId: claimed.botId,
        senderIsHuman: false,
        messageId: claimed.messageId,
        content: claimed.content,
        recipientMode: 'all-human-members',
        logContext,
      })
    );
  }

  private notifyBotMessageIfClaimable(
    messageId: string,
    reason: BotMessageNotificationReason
  ): boolean {
    const claimed = this.claimBotMessageNotification(messageId, reason);
    if (!claimed) return false;
    this.dispatchClaimedBotMessageNotification(claimed, reason);
    return true;
  }

  async createMessage(params: CreateMessageParams): Promise<CreateMessageResult> {
    const info = this.getInfo();
    if (!info) return { ok: false, code: 'internal', error: 'Conversation not initialized' };

    if (!info.members.some(member => member.id === params.senderId)) {
      return {
        ok: false,
        code: 'forbidden',
        error: `Sender ${params.senderId} is not a member of this conversation`,
      };
    }

    // Validate attachment blocks (status must be pending, uploader must match
    // sender). The actual link UPDATE is performed after the message INSERT.
    const attachmentBlocks = params.content.filter(
      (b): b is Extract<ContentBlock, { type: 'attachment' }> => b.type === 'attachment'
    );
    if (attachmentBlocks.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      return {
        ok: false,
        code: 'invalid',
        error: `At most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`,
      };
    }
    const attachmentRows: StoredAttachmentRow[] = [];
    for (const block of attachmentBlocks) {
      const row = this.db
        .select()
        .from(attachments)
        .where(eq(attachments.id, block.attachmentId))
        .get();
      if (!row) {
        return { ok: false, code: 'invalid', error: 'Attachment not found' };
      }
      if (row.status !== 'pending') {
        return { ok: false, code: 'conflict', error: 'Attachment is already linked' };
      }
      if (row.uploader_id !== params.senderId) {
        return { ok: false, code: 'forbidden', error: 'Attachment uploader does not match sender' };
      }
      attachmentRows.push(row);
    }
    const uploadError = await this.validateUploadedAttachmentObjects(attachmentRows);
    if (uploadError) {
      return { ok: false, ...uploadError };
    }
    const content = this.canonicalizeAttachmentBlocks(params.content, attachmentRows);

    const messageId = this.nextUlid();

    // The pending-status check above is necessary but not sufficient: the
    // R2 HEAD await in validateUploadedAttachmentObjects releases the DO
    // input gate, so a concurrent createMessage can race past the same
    // check before we get here. The UPDATE below guards against that by
    // requiring status='pending' and aborting the transaction if the row
    // has already been claimed.
    try {
      this.db.transaction(tx => {
        tx.insert(messages)
          .values({
            id: messageId,
            sender_id: params.senderId,
            content: JSON.stringify(content),
            in_reply_to_message_id: params.inReplyToMessageId ?? null,
            version: 1,
            deleted: 0,
          })
          .run();

        for (const row of attachmentRows) {
          const linked = tx
            .update(attachments)
            .set({ status: 'linked', message_id: messageId })
            .where(and(eq(attachments.id, row.id), eq(attachments.status, 'pending')))
            .returning({ id: attachments.id })
            .all();
          if (linked.length === 0) {
            throw new AttachmentAlreadyLinkedError();
          }
        }
      });
    } catch (err) {
      if (err instanceof AttachmentAlreadyLinkedError) {
        return { ok: false, code: 'conflict', error: 'Attachment is already linked' };
      }
      if (err instanceof Error && /constraint/i.test(err.message)) {
        return { ok: false, code: 'internal', error: err.message };
      }
      throw err;
    }

    const row = this.db.select().from(messages).where(eq(messages.id, messageId)).get();
    if (!row) {
      return { ok: false, code: 'internal', error: `Message ${messageId} was not created` };
    }

    const replyParentRow = row.in_reply_to_message_id
      ? this.db.select().from(messages).where(eq(messages.id, row.in_reply_to_message_id)).get()
      : undefined;
    const replyParentById = replyParentRow
      ? new Map([[replyParentRow.id, replyParentRow]])
      : new Map<string, StoredMessageRow>();

    if (this.isBotMember(params.senderId)) {
      this.registerBotMessageNotification(messageId, params.senderId, content);
      if (botMessageNotificationTextLength(content) >= BOT_MESSAGE_NOTIFICATION_MIN_TEXT_CHARS) {
        this.notifyBotMessageIfClaimable(messageId, 'length');
      }
    }

    return {
      ok: true,
      messageId,
      message: storedMessageRowToMessage(row, replyParentById, new Map()),
      info,
    };
  }

  getMessage(messageId: string): GetMessageResult {
    const row = this.db.select().from(messages).where(eq(messages.id, messageId)).get();
    if (!row) return null;
    return {
      id: row.id,
      senderId: row.sender_id,
      content: row.deleted === 1 ? [] : parseStoredContent(row.content, row.id),
      deleted: row.deleted === 1,
    };
  }

  getLatestNonDeletedMessageId(): string | null {
    const row = this.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.deleted, 0))
      .orderBy(desc(messages.id))
      .limit(1)
      .get();
    return row?.id ?? null;
  }

  resolveMarkRead(memberId: string, lastSeenMessageId: string): ResolveMarkReadResult {
    const activeMembers = this.getActiveMemberRows();
    if (!activeMembers.some(member => member.id === memberId)) {
      return { ok: false, code: 'forbidden', error: 'Forbidden' };
    }

    const marker = this.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.id, lastSeenMessageId))
      .get();
    if (!marker) {
      return {
        ok: false,
        code: 'invalid',
        error: 'Message does not belong to conversation',
      };
    }

    return {
      ok: true,
      sandboxId: this.getMemberContextFromRows(activeMembers).sandboxId,
      latestNonDeletedMessageId: this.getLatestNonDeletedMessageId(),
    };
  }

  listMessages(params: ListMessagesParams): ListMessagesResult {
    const query = this.db.select().from(messages);

    const rowsWithSentinel = params.before
      ? query
          .where(lt(messages.id, params.before))
          .orderBy(desc(messages.id))
          .limit(params.limit + 1)
          .all()
      : query
          .orderBy(desc(messages.id))
          .limit(params.limit + 1)
          .all();

    const hasMore = rowsWithSentinel.length > params.limit;
    const rows = rowsWithSentinel.slice(0, params.limit);
    const nextCursor = hasMore ? (rows[rows.length - 1]?.id ?? null) : null;
    if (rows.length === 0) {
      return { messages: [], hasMore: false, nextCursor: null };
    }

    const ids = rows.map(r => r.id);
    const replyParentIds = [
      ...new Set(rows.flatMap(r => (r.in_reply_to_message_id ? [r.in_reply_to_message_id] : []))),
    ];
    const replyParentRows =
      replyParentIds.length > 0
        ? this.db.select().from(messages).where(inArray(messages.id, replyParentIds)).all()
        : [];
    const replyParentById = new Map(replyParentRows.map(row => [row.id, row]));

    const reactionRows = this.db
      .select()
      .from(reactions)
      .where(and(inArray(reactions.message_id, ids), sql`${reactions.deleted_at} IS NULL`))
      .all();

    const reactionsByMessage = new Map<string, MessageReactionSummary[]>();
    for (const r of reactionRows) {
      const list = reactionsByMessage.get(r.message_id) ?? [];
      let bucket = list.find(b => b.emoji === r.emoji);
      if (!bucket) {
        bucket = { emoji: r.emoji, count: 0, memberIds: [] };
        list.push(bucket);
      }
      bucket.count += 1;
      bucket.memberIds.push(r.member_id);
      reactionsByMessage.set(r.message_id, list);
    }

    return {
      messages: rows.map(row =>
        storedMessageRowToMessage(row, replyParentById, reactionsByMessage)
      ),
      hasMore,
      nextCursor,
    };
  }

  /**
   * Combined membership check + listMessages in a single RPC call.
   * Returns null if the caller is not a member (i.e. 403).
   */
  listMessagesIfMember(memberId: string, params: ListMessagesParams): ListMessagesResult | null {
    if (!this.isMember(memberId)) return null;
    return this.listMessages(params);
  }

  editMessage(params: EditMessageParams): EditMessageResult {
    const row = this.db.select().from(messages).where(eq(messages.id, params.messageId)).get();
    if (!row || row.deleted === 1) {
      return {
        ok: false,
        code: 'not_found',
        error: `Message ${params.messageId} not found`,
      };
    }

    if (params.senderId !== row.sender_id) {
      return {
        ok: false,
        code: 'forbidden',
        error: `Sender ${params.senderId} is not the owner of message ${params.messageId}`,
      };
    }

    const memberContext = this.getMemberContextIfActive(params.senderId);
    if (!memberContext) {
      return {
        ok: false,
        code: 'forbidden',
        error: `Sender ${params.senderId} is not a member of this conversation`,
      };
    }

    // Discard out-of-order edits: if the client's timestamp is older than the
    // last accepted edit, silently drop it.
    if (row.client_updated_at != null && params.clientTimestamp <= row.client_updated_at) {
      return { ok: true, stale: true, messageId: params.messageId };
    }

    // Attachment reconciliation: edits may drop existing attachments but
    // never add new ones (uploads must go through initAttachment + a fresh
    // createMessage). Rows removed from the message are deleted and their
    // R2 objects are purged best-effort.
    const existingAttachmentRows = this.db
      .select()
      .from(attachments)
      .where(eq(attachments.message_id, params.messageId))
      .all();
    const existingIds = new Set(existingAttachmentRows.map(r => r.id));
    const newAttachmentIds = new Set(
      params.content
        .filter((b): b is Extract<ContentBlock, { type: 'attachment' }> => b.type === 'attachment')
        .map(b => b.attachmentId)
    );
    for (const id of newAttachmentIds) {
      if (!existingIds.has(id)) {
        return { ok: false, code: 'conflict', error: 'Cannot add attachments' };
      }
    }
    const removedRows = existingAttachmentRows.filter(r => !newAttachmentIds.has(r.id));
    const content = this.canonicalizeAttachmentBlocks(params.content, existingAttachmentRows);
    if (removedRows.length > 0) {
      const removedIds = removedRows.map(r => r.id);
      this.db.delete(attachments).where(inArray(attachments.id, removedIds)).run();
      const removedKeys = removedRows.map(r => r.r2_key);
      this.ctx.waitUntil(this.scheduleR2Deletes(removedKeys));
    }

    const newVersion = row.version + 1;
    this.db
      .update(messages)
      .set({
        content: JSON.stringify(content),
        version: newVersion,
        updated_at: Date.now(),
        client_updated_at: params.clientTimestamp,
      })
      .where(eq(messages.id, params.messageId))
      .run();

    if (this.isBotMember(params.senderId)) {
      this.db
        .update(botMessageNotifications)
        .set({ content: JSON.stringify(content) })
        .where(
          and(
            eq(botMessageNotifications.message_id, params.messageId),
            sql`${botMessageNotifications.notified_at} IS NULL`
          )
        )
        .run();

      if (botMessageNotificationTextLength(content) >= BOT_MESSAGE_NOTIFICATION_MIN_TEXT_CHARS) {
        this.notifyBotMessageIfClaimable(params.messageId, 'length');
      }
    }

    return {
      ok: true,
      stale: false,
      messageId: params.messageId,
      content,
      memberContext,
    };
  }

  notifyLatestBotMessageOnTypingStop(
    botId: string
  ): { ok: true; notified: boolean } | { ok: false; error: string } {
    if (!this.isBotMember(botId)) {
      return { ok: false, error: 'Not a bot member' };
    }

    const row = this.db
      .select({ messageId: botMessageNotifications.message_id })
      .from(botMessageNotifications)
      .where(
        and(
          eq(botMessageNotifications.bot_id, botId),
          sql`${botMessageNotifications.notified_at} IS NULL`
        )
      )
      .orderBy(desc(botMessageNotifications.created_at))
      .limit(1)
      .get();

    if (!row) {
      return { ok: true, notified: false };
    }

    return { ok: true, notified: this.notifyBotMessageIfClaimable(row.messageId, 'typing_stop') };
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const dueRows = this.db
      .select()
      .from(botMessageNotifications)
      .where(
        and(
          sql`${botMessageNotifications.notified_at} IS NULL`,
          sql`${botMessageNotifications.notify_after} <= ${now}`
        )
      )
      .all();

    for (const row of dueRows) {
      this.notifyBotMessageIfClaimable(row.message_id, 'timeout');
    }

    const next = this.db
      .select({ notifyAfter: botMessageNotifications.notify_after })
      .from(botMessageNotifications)
      .where(sql`${botMessageNotifications.notified_at} IS NULL`)
      .orderBy(botMessageNotifications.notify_after)
      .limit(1)
      .get();

    if (next) {
      await this.ctx.storage.setAlarm(next.notifyAfter);
    }

    await this.sweepOrphanAttachments();
  }

  setTyping(
    memberId: string
  ): { ok: true; memberContext: MemberContext } | { ok: false; error: string } {
    const memberContext = this.getMemberContextIfActive(memberId);
    if (!memberContext) {
      return { ok: false, error: 'Not a member' };
    }
    return { ok: true, memberContext };
  }

  deleteMessage(params: DeleteMessageParams): DeleteMessageResult {
    const row = this.db.select().from(messages).where(eq(messages.id, params.messageId)).get();
    if (!row) {
      return {
        ok: false,
        code: 'not_found',
        error: `Message ${params.messageId} not found`,
      };
    }

    if (params.senderId !== row.sender_id) {
      return {
        ok: false,
        code: 'forbidden',
        error: `Sender ${params.senderId} is not the owner of message ${params.messageId}`,
      };
    }

    const memberContext = this.getMemberContextIfActive(params.senderId);
    if (!memberContext) {
      return {
        ok: false,
        code: 'forbidden',
        error: `Sender ${params.senderId} is not a member of this conversation`,
      };
    }

    // Already deleted — idempotent success (only for the original sender)
    if (row.deleted === 1) {
      return { ok: true, memberContext };
    }

    const attachmentRows = this.db
      .select()
      .from(attachments)
      .where(eq(attachments.message_id, params.messageId))
      .all();

    const clearPendingBotNotification = this.isBotMember(params.senderId);
    this.db.transaction(tx => {
      tx.update(messages)
        .set({ deleted: 1, updated_at: Date.now() })
        .where(eq(messages.id, params.messageId))
        .run();

      if (attachmentRows.length > 0) {
        tx.delete(attachments).where(eq(attachments.message_id, params.messageId)).run();
      }

      if (clearPendingBotNotification) {
        tx.delete(botMessageNotifications)
          .where(
            and(
              eq(botMessageNotifications.message_id, params.messageId),
              sql`${botMessageNotifications.notified_at} IS NULL`
            )
          )
          .run();
      }
    });

    if (attachmentRows.length > 0) {
      const keys = attachmentRows.map(r => r.r2_key);
      this.ctx.waitUntil(this.scheduleR2Deletes(keys));
    }

    return { ok: true, memberContext };
  }

  executeAction(params: ExecuteActionParams): ExecuteActionResult {
    const activeMembers = this.getActiveMemberRows();
    if (!activeMembers.some(member => member.id === params.memberId)) {
      return { ok: false, code: 'forbidden', error: 'Not a member' };
    }

    const row = this.db.select().from(messages).where(eq(messages.id, params.messageId)).get();
    if (!row || row.deleted === 1) {
      return { ok: false, code: 'not_found', error: 'Message not found' };
    }

    const content = parseStoredContent(row.content, row.id);
    const actionsBlock = content.find(
      (b): b is ActionsBlock => b.type === 'actions' && b.groupId === params.groupId
    );
    if (!actionsBlock) {
      return { ok: false, code: 'not_found', error: 'Action group not found' };
    }
    if (actionsBlock.resolved) {
      return { ok: false, code: 'already_resolved', error: 'Action already resolved' };
    }
    if (!actionsBlock.actions.some(a => a.value === params.value)) {
      return { ok: false, code: 'invalid_value', error: 'Value does not match any offered action' };
    }

    const resolved = {
      value: params.value,
      resolvedBy: params.memberId,
      resolvedAt: Date.now(),
    };
    actionsBlock.resolved = resolved;

    const newVersion = row.version + 1;
    this.db
      .update(messages)
      .set({
        content: JSON.stringify(content),
        version: newVersion,
        updated_at: Date.now(),
      })
      .where(eq(messages.id, params.messageId))
      .run();

    return {
      ok: true,
      content,
      messageSenderId: row.sender_id,
      memberContext: this.getMemberContextFromRows(activeMembers),
      targetBotId: activeMembers.some(
        member => member.id === row.sender_id && member.kind === 'bot'
      )
        ? row.sender_id
        : null,
      resolved: { groupId: params.groupId, ...resolved },
    };
  }

  addReaction(params: AddReactionParams): AddReactionResult {
    const memberContext = this.getMemberContextIfActive(params.memberId);
    if (!memberContext) {
      return { ok: false, code: 'forbidden' as const, error: 'Not a member' };
    }
    const message = this.db.select().from(messages).where(eq(messages.id, params.messageId)).get();
    if (!message || message.deleted === 1) {
      return { ok: false, code: 'not_found', error: 'Message not found' };
    }

    try {
      const existing = this.db
        .select()
        .from(reactions)
        .where(
          and(
            eq(reactions.message_id, params.messageId),
            eq(reactions.member_id, params.memberId),
            eq(reactions.emoji, params.emoji)
          )
        )
        .get();

      const now = Date.now();

      if (!existing) {
        const id = this.nextUlid();
        this.db
          .insert(reactions)
          .values({
            message_id: params.messageId,
            member_id: params.memberId,
            emoji: params.emoji,
            id,
            added_at: now,
            deleted_at: null,
            removed_id: null,
          })
          .run();
        return { ok: true, added: true, id, memberContext };
      }

      if (existing.deleted_at === null) {
        return { ok: true, added: false, id: existing.id };
      }

      // Dead row — re-activate.
      const id = this.nextUlid();
      this.db
        .update(reactions)
        .set({ id, added_at: now, deleted_at: null, removed_id: null })
        .where(
          and(
            eq(reactions.message_id, params.messageId),
            eq(reactions.member_id, params.memberId),
            eq(reactions.emoji, params.emoji)
          )
        )
        .run();
      return { ok: true, added: true, id, memberContext };
    } catch (err) {
      if (err instanceof Error && /constraint/i.test(err.message)) {
        return { ok: false, code: 'internal', error: err.message };
      }
      throw err;
    }
  }

  removeReaction(params: RemoveReactionParams): RemoveReactionResult {
    const memberContext = this.getMemberContextIfActive(params.memberId);
    if (!memberContext) {
      return { ok: false, code: 'forbidden' as const, error: 'Not a member' };
    }
    const message = this.db.select().from(messages).where(eq(messages.id, params.messageId)).get();
    if (!message || message.deleted === 1) {
      return { ok: false, code: 'not_found', error: 'Message not found' };
    }

    try {
      const existing = this.db
        .select()
        .from(reactions)
        .where(
          and(
            eq(reactions.message_id, params.messageId),
            eq(reactions.member_id, params.memberId),
            eq(reactions.emoji, params.emoji)
          )
        )
        .get();

      if (!existing) return { ok: true, removed: false, removed_id: null };
      if (existing.deleted_at !== null) {
        if (existing.removed_id === null) {
          return {
            ok: false,
            code: 'internal',
            error: 'Deleted reaction is missing remove operation id',
          };
        }
        return { ok: true, removed: false, removed_id: existing.removed_id };
      }

      const removedId = this.nextUlid();
      this.db
        .update(reactions)
        .set({ deleted_at: Date.now(), removed_id: removedId })
        .where(
          and(
            eq(reactions.message_id, params.messageId),
            eq(reactions.member_id, params.memberId),
            eq(reactions.emoji, params.emoji)
          )
        )
        .run();
      return {
        ok: true,
        removed: true,
        removed_id: removedId,
        memberContext,
      };
    } catch (err) {
      if (err instanceof Error && /constraint/i.test(err.message)) {
        return { ok: false, code: 'internal', error: err.message };
      }
      throw err;
    }
  }

  /**
   * Writes the auto-title without a membership check only when the conversation
   * is still untitled. Human-initiated renames must go through
   * updateTitleIfMember.
   */
  updateTitleIfNullInternal(title: string): { ok: true; applied: boolean } {
    const row = this.db.select({ title: conversation.title }).from(conversation).get();
    if (!row || row.title !== null) {
      return { ok: true, applied: false };
    }

    this.db.update(conversation).set({ title }).run();
    return { ok: true, applied: true };
  }

  leaveMember(memberId: string): {
    remainingUsers: Array<{ id: string }>;
    botMembers: Array<{ id: string }>;
  } {
    this.db.update(members).set({ left_at: Date.now() }).where(eq(members.id, memberId)).run();
    const active = this.db
      .select({ id: members.id, kind: members.kind })
      .from(members)
      .where(sql`${members.left_at} IS NULL`)
      .all();
    return {
      remainingUsers: active.filter(m => m.kind === 'user'),
      botMembers: active.filter(m => m.kind === 'bot'),
    };
  }

  updateTitleIfMember(memberId: string, title: string): UpdateTitleIfMemberResult {
    if (!this.isMember(memberId)) {
      return { ok: false, code: 'forbidden', error: 'Not a member' };
    }
    this.db.update(conversation).set({ title }).run();
    const activeMembers = this.db
      .select({ id: members.id, kind: members.kind })
      .from(members)
      .where(sql`${members.left_at} IS NULL`)
      .all();
    return {
      ok: true,
      members: activeMembers.map(m => ({ id: m.id, kind: m.kind as 'user' | 'bot' })),
    };
  }

  leaveMemberIfMember(memberId: string): LeaveMemberIfMemberResult {
    if (!this.isMember(memberId)) {
      return { ok: false, code: 'forbidden', error: 'Not a member' };
    }
    this.db.update(members).set({ left_at: Date.now() }).where(eq(members.id, memberId)).run();
    const active = this.db
      .select({ id: members.id, kind: members.kind })
      .from(members)
      .where(sql`${members.left_at} IS NULL`)
      .all();
    const remainingUsers = active.filter(m => m.kind === 'user');
    const botMembers = active.filter(m => m.kind === 'bot');
    if (remainingUsers.length === 0 && botMembers.length > 0) {
      this.db
        .update(members)
        .set({ left_at: Date.now() })
        .where(and(eq(members.kind, 'bot'), sql`${members.left_at} IS NULL`))
        .run();
    }
    return {
      ok: true,
      remainingUsers,
      botMembers,
    };
  }

  initAttachment(rawParams: InitAttachmentParams): InitAttachmentResult {
    const parsed = initAttachmentInternalSchema.safeParse(rawParams);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const path = first?.path.join('.') || 'input';
      return { ok: false, code: 'invalid', error: `${path}: ${first?.message ?? 'invalid'}` };
    }
    const params = parsed.data;
    if (!this.isMember(params.uploaderId)) {
      return { ok: false, code: 'forbidden', error: 'Forbidden' };
    }

    const now = Date.now();

    // Dedupe is opt-in via idempotencyKey. Without it, every init mints a
    // fresh attachment id — two genuinely distinct files with identical
    // metadata uploaded back-to-back will not collide. Clients that want
    // retry-safety pass a key; we bound replay reuse to INIT_DEDUPE_WINDOW_MS.
    if (params.idempotencyKey !== undefined) {
      const dedupeCutoff = now - INIT_DEDUPE_WINDOW_MS;
      const existing = this.db
        .select()
        .from(attachments)
        .where(
          and(
            eq(attachments.uploader_id, params.uploaderId),
            eq(attachments.idempotency_key, params.idempotencyKey),
            eq(attachments.status, 'pending'),
            gte(attachments.created_at, dedupeCutoff)
          )
        )
        .orderBy(desc(attachments.created_at))
        .limit(1)
        .get();
      if (existing) {
        return {
          ok: true,
          attachmentId: existing.id,
          r2Key: existing.r2_key,
        };
      }
    }

    const conversationId = this.getConversationId();
    const attachmentId = this.nextUlid();
    const r2Key = buildAttachmentR2Key({
      keyPrefix: this.keyPrefix,
      conversationId,
      uploaderId: params.uploaderId,
      attachmentId,
    });

    this.db
      .insert(attachments)
      .values({
        id: attachmentId,
        uploader_id: params.uploaderId,
        r2_key: r2Key,
        mime_type: params.mimeType,
        size: params.size,
        filename: params.filename,
        status: 'pending',
        message_id: null,
        idempotency_key: params.idempotencyKey ?? null,
        created_at: now,
      })
      .run();

    this.scheduleOrphanSweepIfNeeded();

    return { ok: true, attachmentId, r2Key };
  }

  getAttachmentForRead(params: GetAttachmentForReadParams): GetAttachmentForReadResult {
    if (!this.isMember(params.requesterId)) {
      return { ok: false, code: 'forbidden', error: 'Forbidden' };
    }
    const row = this.db
      .select()
      .from(attachments)
      .where(eq(attachments.id, params.attachmentId))
      .get();
    if (!row || row.status !== 'linked') return { ok: true, row: null };
    return {
      ok: true,
      row: {
        id: row.id,
        r2Key: row.r2_key,
        mimeType: row.mime_type,
        size: row.size,
        filename: row.filename,
      },
    };
  }

  /**
   * Ensures an alarm is set so the orphan sweep eventually runs. Storage
   * alarm APIs are async; the sync `initAttachment` path schedules via
   * `ctx.waitUntil`. The DO shares one alarm slot with bot-notification
   * timeouts. Bot-notification alarms always fire within seconds-to-minutes,
   * so they are always earlier than the ~24h orphan-sweep target. We set the
   * alarm when there is none, when the existing alarm is already past, or when
   * the existing alarm is *later* than our target (which only happens when the
   * existing alarm is itself an old orphan-sweep alarm — safe to pull in).
   */
  private scheduleOrphanSweepIfNeeded(): void {
    this.ctx.waitUntil(
      (async () => {
        const existing = await this.ctx.storage.getAlarm();
        const target = Date.now() + ConversationDO.ORPHAN_TTL_MS;
        if (existing === null || existing < Date.now() || existing > target) {
          await this.ctx.storage.setAlarm(target);
        }
      })()
    );
  }

  private async sweepOrphanAttachments(): Promise<void> {
    const cutoff = Date.now() - ConversationDO.ORPHAN_TTL_MS;
    const stale = this.db
      .select()
      .from(attachments)
      .where(and(eq(attachments.status, 'pending'), lt(attachments.created_at, cutoff)))
      .all();
    if (stale.length > 0) {
      const ids = stale.map(r => r.id);
      this.db.delete(attachments).where(inArray(attachments.id, ids)).run();
      await this.scheduleR2Deletes(stale.map(r => r.r2_key));
    }

    // If anything is still pending, re-arm the alarm so we sweep it later.
    const remaining = this.db
      .select({ id: attachments.id })
      .from(attachments)
      .where(eq(attachments.status, 'pending'))
      .limit(1)
      .get();
    if (remaining) {
      const existing = await this.ctx.storage.getAlarm();
      const target = Date.now() + ConversationDO.ORPHAN_TTL_MS;
      if (existing === null || existing < Date.now() || existing > target) {
        await this.ctx.storage.setAlarm(target);
      }
    }
  }

  async destroyAndReturnMembers(): Promise<DestroyResult> {
    const info = this.getInfo();
    if (!info) return null;
    const membersCopy = info.members;

    // Walk every R2 object under this conversation's prefix and delete it.
    // This covers attachments whose DB rows we'll wipe below as well as any
    // orphaned objects (e.g. uploads that completed after the row was
    // expired by the orphan sweeper).
    //
    // Known gap (accepted): a client that obtained a presigned PUT URL before
    // destroy can still upload bytes *after* this list() — up to the URL's
    // remaining TTL (PUT_URL_TTL_SECONDS in handler.ts). Those bytes will
    // remain in R2 with no DB row and no future sweeper, since this DO is
    // gone. The window is short and worst-case cost is a few KB per destroyed
    // conversation; revisit by shortening the PUT TTL if it ever shows up in
    // R2 usage.
    const prefix = `${this.keyPrefix}attachments/${info.id}/`;
    let cursor: string | undefined;
    do {
      const listed = await this.env.MEDIA_BUCKET.list({ prefix, cursor });
      const keys = listed.objects.map(o => o.key);
      if (keys.length > 0) {
        await this.scheduleR2Deletes(keys);
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    this.db.transaction(tx => {
      tx.delete(attachments).run();
      tx.delete(reactions).run();
      tx.delete(botMessageNotifications).run();
      tx.delete(messages).run();
      tx.delete(conversation).run();
      tx.delete(members).run();
    });
    return { members: membersCopy };
  }
}
