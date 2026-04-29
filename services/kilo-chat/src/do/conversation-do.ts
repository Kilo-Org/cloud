import type {
  ContentBlock,
  ActionsBlock,
  Message,
  ReactionSummary,
  ExecApprovalDecision,
  actionExecutedWebhookSchema,
} from '@kilocode/kilo-chat';
import type { z } from 'zod';
import { DurableObject } from 'cloudflare:workers';
import { logger } from '../util/logger';
import { deliverToBot, deliverActionExecutedToBot, type WebhookMessage } from '../webhook/deliver';

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
import { eq, lt, desc, and, sql, inArray } from 'drizzle-orm';
import { conversation, members, messages, reactions } from '../db/conversation-schema';
import migrations from '../../drizzle/conversation/migrations';
import { monotonicFactory } from 'ulid';

export type MemberContext = {
  humanMemberIds: string[];
  sandboxId: string | null;
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
  | { ok: true; messageId: string; info: ConversationInfo }
  | { ok: false; code: 'forbidden' | 'internal'; error: string };

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

export type MessageRow = Message;

export type ListMessagesResult = {
  messages: MessageRow[];
};

export type EditMessageParams = {
  messageId: string;
  senderId: string;
  content: ContentBlock[];
  clientTimestamp: number;
};

export type EditMessageResult =
  | { ok: true; stale: false; messageId: string; memberContext: MemberContext }
  | { ok: true; stale: true; messageId: string }
  | { ok: false; code: 'not_found' | 'forbidden'; error: string };

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
  | { ok: true; content: ContentBlock[]; messageSenderId: string }
  | {
      ok: false;
      code: 'not_found' | 'forbidden' | 'already_resolved' | 'invalid_value';
      error: string;
    };

export type RevertActionResolutionResult =
  | { ok: true }
  | { ok: false; code: 'not_found'; error: string };

export type AddReactionParams = { messageId: string; memberId: string; emoji: string };
export type AddReactionResult =
  | { ok: true; added: true; id: string; memberContext: MemberContext }
  | { ok: true; added: false; id: string }
  | { ok: false; code: 'forbidden' | 'not_found' | 'internal'; error: string };
export type RemoveReactionParams = { messageId: string; memberId: string; emoji: string };
export type RemoveReactionResult =
  | { ok: true; removed: true; removed_id: string; memberContext: MemberContext }
  | { ok: true; removed: false }
  | { ok: false; code: 'forbidden' | 'not_found' | 'internal'; error: string };

export class ConversationDO extends DurableObject<Env> {
  private db;
  private nextUlid = monotonicFactory();

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
    void ctx.blockConcurrencyWhile(() => migrate(this.db, migrations));
  }

  async enqueueMessageWebhook(msg: WebhookMessage, convContext: MemberContext): Promise<void> {
    this.webhookChain = this.webhookChain
      .catch(() => {})
      .then(() => deliverToBot(this.env, msg, convContext));
    this.ctx.waitUntil(this.webhookChain);
  }

  async enqueueActionExecutedWebhook(
    msg: z.infer<typeof actionExecutedWebhookSchema> & { targetBotId: string }
  ): Promise<void> {
    this.webhookChain = this.webhookChain
      .catch(() => {})
      .then(() => deliverActionExecutedToBot(this.env, msg));
    this.ctx.waitUntil(this.webhookChain);
  }

  notifyDeliveryFailed(messageId: string): void {
    this.db.update(messages).set({ delivery_failed: 1 }).where(eq(messages.id, messageId)).run();
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
      return { ok: true };
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
    return { ok: true };
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

    const memberRows = this.db
      .select()
      .from(members)
      .where(sql`${members.left_at} IS NULL`)
      .all();

    return {
      id: convRow.id,
      title: convRow.title,
      createdBy: convRow.created_by,
      createdAt: convRow.created_at,
      members: memberRows.map(m => ({ id: m.id, kind: m.kind as 'user' | 'bot' })),
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

  private getMemberContext(): MemberContext {
    const activeMembers = this.db
      .select({ id: members.id, kind: members.kind })
      .from(members)
      .where(sql`${members.left_at} IS NULL`)
      .all();

    const humanMemberIds = activeMembers.filter(m => m.kind === 'user').map(m => m.id);
    const botMember = activeMembers.find(m => m.kind === 'bot');
    const sandboxId = botMember ? (botMember.id.match(/^bot:kiloclaw:(.+)$/)?.[1] ?? null) : null;

    return { humanMemberIds, sandboxId };
  }

  createMessage(params: CreateMessageParams): CreateMessageResult {
    if (!this.isMember(params.senderId)) {
      return {
        ok: false,
        code: 'forbidden',
        error: `Sender ${params.senderId} is not a member of this conversation`,
      };
    }

    const messageId = this.nextUlid();

    try {
      this.db
        .insert(messages)
        .values({
          id: messageId,
          sender_id: params.senderId,
          content: JSON.stringify(params.content),
          in_reply_to_message_id: params.inReplyToMessageId ?? null,
          version: 1,
          deleted: 0,
        })
        .run();
    } catch (err) {
      if (err instanceof Error && /constraint/i.test(err.message)) {
        return { ok: false, code: 'internal', error: err.message };
      }
      throw err;
    }

    const info = this.getInfo();
    if (!info) return { ok: false, code: 'internal', error: 'Conversation not initialized' };
    return { ok: true, messageId, info };
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

  listMessages(params: ListMessagesParams): ListMessagesResult {
    const query = this.db.select().from(messages);

    const rows = params.before
      ? query
          .where(lt(messages.id, params.before))
          .orderBy(desc(messages.id))
          .limit(params.limit)
          .all()
      : query.orderBy(desc(messages.id)).limit(params.limit).all();

    if (rows.length === 0) {
      return { messages: [] };
    }

    const ids = rows.map(r => r.id);
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
      messages: rows.map(row => ({
        id: row.id,
        senderId: row.sender_id,
        content: row.deleted === 1 ? [] : parseStoredContent(row.content, row.id),
        inReplyToMessageId: row.in_reply_to_message_id,
        updatedAt: row.updated_at,
        clientUpdatedAt: row.client_updated_at,
        deleted: row.deleted === 1,
        deliveryFailed: row.delivery_failed === 1,
        reactions: reactionsByMessage.get(row.id) ?? [],
      })),
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

    // Discard out-of-order edits: if the client's timestamp is older than the
    // last accepted edit, silently drop it.
    if (row.client_updated_at != null && params.clientTimestamp <= row.client_updated_at) {
      return { ok: true, stale: true, messageId: params.messageId };
    }

    const newVersion = row.version + 1;
    this.db
      .update(messages)
      .set({
        content: JSON.stringify(params.content),
        version: newVersion,
        updated_at: Date.now(),
        client_updated_at: params.clientTimestamp,
      })
      .where(eq(messages.id, params.messageId))
      .run();

    return {
      ok: true,
      stale: false,
      messageId: params.messageId,
      memberContext: this.getMemberContext(),
    };
  }

  setTyping(
    memberId: string
  ): { ok: true; memberContext: MemberContext } | { ok: false; error: string } {
    if (!this.isMember(memberId)) {
      return { ok: false, error: 'Not a member' };
    }
    return { ok: true, memberContext: this.getMemberContext() };
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

    // Already deleted — idempotent success (only for the original sender)
    if (row.deleted === 1) {
      return { ok: true, memberContext: this.getMemberContext() };
    }

    this.db
      .update(messages)
      .set({ deleted: 1, updated_at: Date.now() })
      .where(eq(messages.id, params.messageId))
      .run();

    return { ok: true, memberContext: this.getMemberContext() };
  }

  executeAction(params: ExecuteActionParams): ExecuteActionResult {
    if (!this.isMember(params.memberId)) {
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

    actionsBlock.resolved = {
      value: params.value,
      resolvedBy: params.memberId,
      resolvedAt: Date.now(),
    };

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

    return { ok: true, content, messageSenderId: row.sender_id };
  }

  addReaction(params: AddReactionParams): AddReactionResult {
    if (!this.isMember(params.memberId)) {
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
        return { ok: true, added: true, id, memberContext: this.getMemberContext() };
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
      return { ok: true, added: true, id, memberContext: this.getMemberContext() };
    } catch (err) {
      if (err instanceof Error && /constraint/i.test(err.message)) {
        return { ok: false, code: 'internal', error: err.message };
      }
      throw err;
    }
  }

  removeReaction(params: RemoveReactionParams): RemoveReactionResult {
    if (!this.isMember(params.memberId)) {
      return { ok: false, code: 'forbidden' as const, error: 'Not a member' };
    }
    const message = this.db.select().from(messages).where(eq(messages.id, params.messageId)).get();
    if (!message || message.deleted === 1) {
      return { ok: false, code: 'not_found', error: 'Message not found' };
    }

    try {
      const live = this.db
        .select()
        .from(reactions)
        .where(
          and(
            eq(reactions.message_id, params.messageId),
            eq(reactions.member_id, params.memberId),
            eq(reactions.emoji, params.emoji),
            sql`${reactions.deleted_at} IS NULL`
          )
        )
        .get();

      if (!live) return { ok: true, removed: false };

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
        memberContext: this.getMemberContext(),
      };
    } catch (err) {
      if (err instanceof Error && /constraint/i.test(err.message)) {
        return { ok: false, code: 'internal', error: err.message };
      }
      throw err;
    }
  }

  /**
   * Writes the conversation title without a membership check. Used only by
   * internal code paths that have already authorized the change (e.g. the
   * auto-title flow after the first bot reply commits). Human-initiated
   * renames must go through updateTitleIfMember.
   */
  updateTitleInternal(title: string): { ok: true } {
    this.db.update(conversation).set({ title }).run();
    return { ok: true };
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
    return {
      ok: true,
      remainingUsers: active.filter(m => m.kind === 'user'),
      botMembers: active.filter(m => m.kind === 'bot'),
    };
  }

  destroyAndReturnMembers(): DestroyResult {
    const info = this.getInfo();
    if (!info) return null;
    const membersCopy = info.members;
    this.db.transaction(tx => {
      tx.delete(reactions).run();
      tx.delete(messages).run();
      tx.delete(conversation).run();
      tx.delete(members).run();
    });
    return { members: membersCopy };
  }
}
