import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { eq, lt, desc, ne, and, sql, inArray } from 'drizzle-orm';
import { conversation, members, messages, reactions } from '../db/conversation-schema';
import migrations from '../../drizzle/conversation/migrations';
import { monotonicFactory } from 'ulid';

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
  members: Array<{ id: string; kind: string }>;
};

export type CreateMessageParams = {
  senderId: string;
  content: Array<{ type: string; [key: string]: unknown }>;
  inReplyToMessageId?: string;
};

export type CreateMessageResult = { ok: true; messageId: string } | { ok: false; error: string };

export type ListMessagesParams = {
  limit: number;
  before?: string;
};

export type MessageReactionSummary = {
  emoji: string;
  count: number;
  memberIds: string[];
};

export type MessageContentBlock = { type: string; [key: string]: string };

export type MessageRow = {
  id: string;
  senderId: string;
  content: MessageContentBlock[];
  inReplyToMessageId: string | null;
  updatedAt: number | null;
  clientUpdatedAt: number | null;
  deleted: boolean;
  deliveryFailed: boolean;
  reactions: MessageReactionSummary[];
};

export type ListMessagesResult = {
  messages: MessageRow[];
};

export type EditMessageParams = {
  messageId: string;
  senderId: string;
  content: Array<{ type: string; [key: string]: unknown }>;
  clientTimestamp: number;
};

export type EditMessageResult =
  | { ok: true; stale: false; messageId: string }
  | { ok: true; stale: true; messageId: string }
  | { ok: false; code: 'not_found' | 'forbidden'; error: string };

export type DeleteMessageParams = {
  messageId: string;
  senderId: string;
};

export type DeleteMessageResult =
  | { ok: true }
  | { ok: false; code: 'not_found' | 'forbidden'; error: string };

export type AddReactionParams = { messageId: string; memberId: string; emoji: string };
export type AddReactionResult =
  | { ok: true; added: boolean; id: string }
  | { ok: false; error: string };
export type RemoveReactionParams = { messageId: string; memberId: string; emoji: string };
export type RemoveReactionResult =
  | { ok: true; removed: true; removed_id: string }
  | { ok: true; removed: false }
  | { ok: false; error: string };

export class ConversationDO extends DurableObject<Env> {
  private db;
  private nextUlid = monotonicFactory();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });
    void ctx.blockConcurrencyWhile(() => migrate(this.db, migrations));
  }

  notifyDeliveryFailed(messageId: string, _senderId: string): void {
    this.db.update(messages).set({ delivery_failed: 1 }).where(eq(messages.id, messageId)).run();
  }

  initialize(params: InitializeParams): { ok: true } | { ok: false; error: string } {
    try {
      // Insert members before conversation — conversation.created_by has FK to members.id
      for (const member of params.members) {
        this.db
          .insert(members)
          .values({
            id: member.id,
            kind: member.kind,
            joined_at: params.createdAt,
          })
          .onConflictDoNothing()
          .run();
      }

      this.db
        .insert(conversation)
        .values({
          id: params.id,
          title: params.title,
          created_by: params.createdBy,
          created_at: params.createdAt,
        })
        .onConflictDoNothing()
        .run();

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
      members: memberRows.map(m => ({ id: m.id, kind: m.kind })),
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

  getBotMembersExcluding(senderId: string): Array<{ id: string; kind: string }> {
    return this.db
      .select()
      .from(members)
      .where(
        and(eq(members.kind, 'bot'), ne(members.id, senderId), sql`${members.left_at} IS NULL`)
      )
      .all()
      .map(m => ({ id: m.id, kind: m.kind }));
  }

  createMessage(params: CreateMessageParams): CreateMessageResult {
    if (!this.isMember(params.senderId)) {
      return { ok: false, error: `Sender ${params.senderId} is not a member of this conversation` };
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
        return { ok: false, error: err.message };
      }
      throw err;
    }

    return { ok: true, messageId };
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
        content: row.deleted === 1 ? [] : (JSON.parse(row.content) as MessageContentBlock[]),
        inReplyToMessageId: row.in_reply_to_message_id,
        updatedAt: row.updated_at,
        clientUpdatedAt: row.client_updated_at,
        deleted: row.deleted === 1,
        deliveryFailed: row.delivery_failed === 1,
        reactions: reactionsByMessage.get(row.id) ?? [],
      })),
    };
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

    return { ok: true, stale: false, messageId: params.messageId };
  }

  setTyping(memberId: string): { ok: true } | { ok: false; error: string } {
    if (!this.isMember(memberId)) {
      return { ok: false, error: 'Not a member' };
    }
    return { ok: true };
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

    // Already deleted — idempotent success
    if (row.deleted === 1) {
      return { ok: true };
    }

    if (params.senderId !== row.sender_id) {
      return {
        ok: false,
        code: 'forbidden',
        error: `Sender ${params.senderId} is not the owner of message ${params.messageId}`,
      };
    }

    this.db
      .update(messages)
      .set({ deleted: 1, updated_at: Date.now() })
      .where(eq(messages.id, params.messageId))
      .run();

    return { ok: true };
  }

  addReaction(params: AddReactionParams): AddReactionResult {
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
        return { ok: true, added: true, id };
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
      return { ok: true, added: true, id };
    } catch (err) {
      if (err instanceof Error && /constraint/i.test(err.message)) {
        return { ok: false, error: err.message };
      }
      throw err;
    }
  }

  removeReaction(params: RemoveReactionParams): RemoveReactionResult {
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
      return { ok: true, removed: true, removed_id: removedId };
    } catch (err) {
      if (err instanceof Error && /constraint/i.test(err.message)) {
        return { ok: false, error: err.message };
      }
      throw err;
    }
  }

  updateTitle(title: string): { ok: true } {
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
}
