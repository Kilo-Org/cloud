import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { eq, lt, gt, desc, ne, and, asc, sql, inArray } from 'drizzle-orm';
import { conversation, members, messages, reactions } from '../db/conversation-schema';
import migrations from '../../drizzle/conversation/migrations';
import { monotonicFactory, decodeTime } from 'ulid';
import { SSE_PING, formatSseEvent } from '../lib/sse';

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

export type MessageReactionSummary = {
  emoji: string;
  count: number;
  memberIds: string[];
};

export type MessageRow = {
  id: string;
  senderId: string;
  content: string;
  inReplyToMessageId: string | null;
  version: number;
  updatedAt: number | null;
  deleted: boolean;
  reactions: MessageReactionSummary[];
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
  | { ok: true; conflict: false; messageId: string; version: number }
  | { ok: true; conflict: true; messageId: string; version: number }
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
  private sseClients = new Map<string, WritableStreamDefaultWriter>();
  private encoder = new TextEncoder();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });
    void ctx.blockConcurrencyWhile(() => migrate(this.db, migrations));
  }

  private broadcast(event: string, data: unknown, id?: string): void {
    const text = formatSseEvent(event, data, id);
    const bytes = this.encoder.encode(text);
    for (const [connId, writer] of this.sseClients) {
      writer.write(bytes).catch(() => {
        this.sseClients.delete(connId);
        writer.close().catch(() => {});
      });
    }
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

    this.broadcast(
      'message.created',
      {
        messageId,
        senderId: params.senderId,
        content: params.content,
        version: 1,
        inReplyToMessageId: params.inReplyToMessageId ?? null,
      },
      messageId
    );

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
        content: row.content,
        inReplyToMessageId: row.in_reply_to_message_id,
        version: row.version,
        updatedAt: row.updated_at,
        deleted: row.deleted === 1,
        reactions: reactionsByMessage.get(row.id) ?? [],
      })),
    };
  }

  editMessage(params: EditMessageParams): EditMessageResult {
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

    // Optimistic concurrency: client sends the version it believes is current.
    // If it doesn't match, the edit is stale (conflict).
    if (params.version !== row.version) {
      return { ok: true, conflict: true, messageId: params.messageId, version: row.version };
    }

    const newVersion = row.version + 1;
    this.db
      .update(messages)
      .set({
        content: JSON.stringify(params.content),
        version: newVersion,
        updated_at: Date.now(),
      })
      .where(eq(messages.id, params.messageId))
      .run();

    this.broadcast(
      'message.updated',
      { messageId: params.messageId, content: params.content, version: newVersion },
      params.messageId
    );

    return { ok: true, conflict: false, messageId: params.messageId, version: newVersion };
  }

  setTyping(memberId: string): { ok: true } | { ok: false; error: string } {
    if (!this.isMember(memberId)) {
      return { ok: false, error: 'Not a member' };
    }
    this.broadcast('typing', { memberId });
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

    this.broadcast('message.deleted', { messageId: params.messageId }, params.messageId);

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
        this.broadcast(
          'reaction.added',
          { messageId: params.messageId, memberId: params.memberId, emoji: params.emoji, at: now },
          id
        );
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
      this.broadcast(
        'reaction.added',
        { messageId: params.messageId, memberId: params.memberId, emoji: params.emoji, at: now },
        id
      );
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
      this.broadcast(
        'reaction.removed',
        { messageId: params.messageId, memberId: params.memberId, emoji: params.emoji },
        removedId
      );
      return { ok: true, removed: true, removed_id: removedId };
    } catch (err) {
      if (err instanceof Error && /constraint/i.test(err.message)) {
        return { ok: false, error: err.message };
      }
      throw err;
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/subscribe') {
      const memberId = url.searchParams.get('memberId');
      if (!memberId || !this.isMember(memberId)) {
        return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
      }

      const lastEventId = request.headers.get('last-event-id') ?? undefined;

      // Schedule keepalive alarm if not already set
      const alarm = await this.ctx.storage.getAlarm();
      if (!alarm) {
        await this.ctx.storage.setAlarm(Date.now() + 30_000);
      }

      const connId = crypto.randomUUID();

      // Build replay data before opening the stream so we can send it immediately
      let replayBytes: Uint8Array | null = null;
      if (lastEventId) {
        const missedMessages = this.db
          .select()
          .from(messages)
          .where(gt(messages.id, lastEventId))
          .orderBy(asc(messages.id))
          .all();

        // Messages that existed before the cursor but were edited or deleted
        // while the client was disconnected. The ULID encodes the cursor
        // timestamp — any updated_at after that point is a missed mutation.
        const cursorTs = decodeTime(lastEventId);
        const modifiedPreCursor = this.db
          .select()
          .from(messages)
          .where(
            and(
              sql`${messages.id} <= ${lastEventId}`,
              gt(messages.updated_at, cursorTs)
            )
          )
          .orderBy(asc(messages.id))
          .all();

        // UNION ALL forces each arm to hit its dedicated index (reactions_by_id /
        // reactions_by_removed_id). An OR-shape would be at the mercy of SQLite's
        // OR-to-UNION optimizer.
        const reactionEvents = this.db.all<{
          event_id: string;
          kind: 'added' | 'removed';
          message_id: string;
          member_id: string;
          emoji: string;
          at: number | null;
        }>(sql`
          SELECT id AS event_id, 'added' AS kind, message_id, member_id, emoji, added_at AS at
            FROM reactions WHERE id > ${lastEventId}
          UNION ALL
          SELECT removed_id AS event_id, 'removed' AS kind, message_id, member_id, emoji, NULL AS at
            FROM reactions WHERE removed_id IS NOT NULL AND removed_id > ${lastEventId}
        `);

        type ReplayItem = { id: string; text: string };
        const items: ReplayItem[] = [];

        for (const row of missedMessages) {
          if (row.deleted === 1) {
            items.push({
              id: row.id,
              text: formatSseEvent('message.deleted', { messageId: row.id }, row.id),
            });
          } else {
            items.push({
              id: row.id,
              text: formatSseEvent(
                'message.created',
                {
                  messageId: row.id,
                  senderId: row.sender_id,
                  content: JSON.parse(row.content) as Array<{
                    type: string;
                    [key: string]: unknown;
                  }>,
                  version: row.version,
                  inReplyToMessageId: row.in_reply_to_message_id,
                },
                row.id
              ),
            });
          }
        }

        // Emit update/delete events for pre-cursor messages that were
        // modified while the client was disconnected.
        for (const row of modifiedPreCursor) {
          if (row.deleted === 1) {
            items.push({
              id: row.id,
              text: formatSseEvent('message.deleted', { messageId: row.id }, row.id),
            });
          } else {
            items.push({
              id: row.id,
              text: formatSseEvent(
                'message.updated',
                {
                  messageId: row.id,
                  content: JSON.parse(row.content) as Array<{
                    type: string;
                    [key: string]: unknown;
                  }>,
                  version: row.version,
                },
                row.id
              ),
            });
          }
        }

        for (const r of reactionEvents) {
          if (r.kind === 'added') {
            items.push({
              id: r.event_id,
              text: formatSseEvent(
                'reaction.added',
                { messageId: r.message_id, memberId: r.member_id, emoji: r.emoji, at: r.at },
                r.event_id
              ),
            });
          } else {
            items.push({
              id: r.event_id,
              text: formatSseEvent(
                'reaction.removed',
                { messageId: r.message_id, memberId: r.member_id, emoji: r.emoji },
                r.event_id
              ),
            });
          }
        }

        items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

        if (items.length > 0) {
          replayBytes = this.encoder.encode(items.map(i => i.text).join(''));
        }
      }

      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      this.sseClients.set(connId, writer);

      // Send replay immediately
      if (replayBytes !== null) {
        writer.write(replayBytes).catch(() => {
          this.sseClients.delete(connId);
          writer.close().catch(() => {});
        });
      }

      // Wrap readable in a new ReadableStream with a cancel callback that cleans up
      // the writer when the HTTP client disconnects (cancels the response body).
      const reader = readable.getReader();
      const outputReadable = new ReadableStream<Uint8Array>({
        pull(controller) {
          return reader
            .read()
            .then(({ done, value }) => {
              if (done) {
                controller.close();
              } else if (value !== undefined) {
                controller.enqueue(value);
              }
            })
            .catch(() => {
              // Stream was cancelled by the client — nothing to do.
            });
        },
        cancel: () => {
          this.sseClients.delete(connId);
          reader.cancel().catch(() => {});
          writer.close().catch(() => {});
        },
      });

      return new Response(outputReadable, {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        },
      });
    }

    return new Response('Not Found', { status: 404 });
  }

  async alarm(): Promise<void> {
    if (this.sseClients.size === 0) return;
    const ping = this.encoder.encode(SSE_PING);
    for (const [connId, writer] of this.sseClients) {
      writer.write(ping).catch(() => {
        this.sseClients.delete(connId);
        writer.close().catch(() => {});
      });
    }
    if (this.sseClients.size > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
  }
}
