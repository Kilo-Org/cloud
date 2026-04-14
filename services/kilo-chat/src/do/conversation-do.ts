import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { eq, lt, desc, ne, and } from 'drizzle-orm';
import { conversation, members, messages } from '../db/conversation-schema';
import migrations from '../../drizzle/conversation/migrations';
import { ulid } from '../lib/ulid';

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

export type CreateMessageResult =
  | { ok: true; messageId: string; version: number }
  | { ok: false; error: string };

export type ListMessagesParams = {
  limit: number;
  before?: string;
};

export type MessageRow = {
  id: string;
  senderId: string;
  content: string;
  inReplyToMessageId: string | null;
  version: number;
  updatedAt: number | null;
  deleted: boolean;
};

export type ListMessagesResult = {
  messages: MessageRow[];
};

export type EditMessageParams = {
  messageId: string;
  senderId: string;
  content: Array<{ type: string; [key: string]: unknown }>;
  version: number;
};

export type EditMessageResult =
  | { ok: true; messageId: string; version: number; conflict?: boolean }
  | { ok: false; error: string };

export type DeleteMessageParams = {
  messageId: string;
  senderId: string;
};

export type DeleteMessageResult = { ok: true } | { ok: false; error: string };

export class ConversationDO extends DurableObject<Env> {
  private db;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });
    void ctx.blockConcurrencyWhile(() => migrate(this.db, migrations));
  }

  initialize(params: InitializeParams): void {
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
  }

  getInfo(): ConversationInfo | null {
    const convRow = this.db.select().from(conversation).get();
    if (!convRow) return null;

    const memberRows = this.db.select().from(members).all();

    return {
      id: convRow.id,
      title: convRow.title,
      createdBy: convRow.created_by,
      createdAt: convRow.created_at,
      members: memberRows.map(m => ({ id: m.id, kind: m.kind })),
    };
  }

  isMember(memberId: string): boolean {
    const row = this.db.select().from(members).where(eq(members.id, memberId)).get();
    return row !== undefined;
  }

  getBotMembersExcluding(senderId: string): Array<{ id: string; kind: string }> {
    return this.db
      .select()
      .from(members)
      .where(and(eq(members.kind, 'bot'), ne(members.id, senderId)))
      .all()
      .map(m => ({ id: m.id, kind: m.kind }));
  }

  createMessage(params: CreateMessageParams): CreateMessageResult {
    if (!this.isMember(params.senderId)) {
      return { ok: false, error: `Sender ${params.senderId} is not a member of this conversation` };
    }

    const messageId = ulid();

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

    return { ok: true, messageId, version: 1 };
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

    return {
      messages: rows.map(row => ({
        id: row.id,
        senderId: row.sender_id,
        content: row.content,
        inReplyToMessageId: row.in_reply_to_message_id,
        version: row.version,
        updatedAt: row.updated_at,
        deleted: row.deleted === 1,
      })),
    };
  }

  editMessage(params: EditMessageParams): EditMessageResult {
    const row = this.db.select().from(messages).where(eq(messages.id, params.messageId)).get();
    if (!row) {
      return { ok: false, error: `Message ${params.messageId} not found` };
    }

    if (params.senderId !== row.sender_id) {
      return {
        ok: false,
        error: `Sender ${params.senderId} is not the owner of message ${params.messageId}`,
      };
    }

    if (params.version <= row.version) {
      return { ok: true, conflict: true, messageId: params.messageId, version: row.version };
    }

    this.db
      .update(messages)
      .set({
        content: JSON.stringify(params.content),
        version: params.version,
        updated_at: Date.now(),
      })
      .where(eq(messages.id, params.messageId))
      .run();

    return { ok: true, messageId: params.messageId, version: params.version };
  }

  deleteMessage(params: DeleteMessageParams): DeleteMessageResult {
    const row = this.db.select().from(messages).where(eq(messages.id, params.messageId)).get();
    if (!row) {
      return { ok: false, error: `Message ${params.messageId} not found` };
    }

    if (params.senderId !== row.sender_id) {
      return {
        ok: false,
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
}
