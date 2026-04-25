import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { and, eq, desc, sql } from 'drizzle-orm';
import { encodeConversationCursor, type ConversationCursor } from '@kilocode/kilo-chat';
import { conversations } from '../db/membership-schema';
import migrations from '../../drizzle/membership/migrations';

export type ConversationEntry = {
  conversationId: string;
  title: string | null;
  lastActivityAt: number | null;
  lastReadAt: number | null;
  joinedAt: number;
};

export type AddConversationParams = {
  conversationId: string;
  title: string | null;
  sandboxId: string;
  joinedAt: number;
};

export type ListConversationsParams = {
  sandboxId?: string;
  limit?: number;
  cursor?: ConversationCursor | null;
};

export type ListConversationsResult = {
  conversations: ConversationEntry[];
  hasMore: boolean;
  nextCursor: string | null;
};

export class MembershipDO extends DurableObject<Env> {
  private db;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });
    void ctx.blockConcurrencyWhile(() => migrate(this.db, migrations));
  }

  listConversations(params: ListConversationsParams = {}): ListConversationsResult {
    const { sandboxId, cursor } = params;
    const limit = params.limit ?? 50;

    // Sort key: coalesce(last_activity_at, joined_at) DESC, conversation_id DESC.
    // Tie-break on conversation_id so cursor comparisons are strictly monotonic.
    const sortKey = sql`coalesce(${conversations.last_activity_at}, ${conversations.joined_at})`;

    const sandboxFilter = sandboxId ? eq(conversations.sandbox_id, sandboxId) : undefined;
    const cursorFilter = cursor
      ? sql`(${sortKey} < ${cursor.t} OR (${sortKey} = ${cursor.t} AND ${conversations.conversation_id} < ${cursor.c}))`
      : undefined;

    const whereClauses = [sandboxFilter, cursorFilter].filter(
      (c): c is NonNullable<typeof c> => c !== undefined
    );
    const where =
      whereClauses.length === 0
        ? undefined
        : whereClauses.length === 1
          ? whereClauses[0]
          : and(...whereClauses);

    const rows = this.db
      .select()
      .from(conversations)
      .where(where)
      .orderBy(desc(sortKey), desc(conversations.conversation_id))
      .limit(limit + 1)
      .all()
      .map(row => ({
        conversationId: row.conversation_id,
        title: row.conversation_title,
        lastActivityAt: row.last_activity_at,
        lastReadAt: row.last_read_at,
        joinedAt: row.joined_at,
      }));

    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();

    const last = rows[rows.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeConversationCursor({
            t: last.lastActivityAt ?? last.joinedAt,
            c: last.conversationId,
          })
        : null;

    return { conversations: rows, hasMore, nextCursor };
  }

  addConversation(params: AddConversationParams): void {
    this.db
      .insert(conversations)
      .values({
        conversation_id: params.conversationId,
        conversation_title: params.title,
        sandbox_id: params.sandboxId,
        joined_at: params.joinedAt,
      })
      .onConflictDoNothing()
      .run();
  }

  updateLastActivity(conversationId: string, activityAt: number): void {
    this.db
      .update(conversations)
      .set({ last_activity_at: activityAt })
      .where(eq(conversations.conversation_id, conversationId))
      .run();
  }

  markRead(conversationId: string, readAt: number): void {
    this.db
      .update(conversations)
      .set({ last_read_at: readAt })
      .where(eq(conversations.conversation_id, conversationId))
      .run();
  }

  updateLastActivityAndMarkRead(conversationId: string, at: number): void {
    this.db
      .update(conversations)
      .set({ last_activity_at: at, last_read_at: at })
      .where(eq(conversations.conversation_id, conversationId))
      .run();
  }

  updateConversationTitle(conversationId: string, title: string | null): void {
    this.db
      .update(conversations)
      .set({ conversation_title: title })
      .where(eq(conversations.conversation_id, conversationId))
      .run();
  }

  /**
   * Combined post-commit update for a single message. Always updates
   * `last_activity_at`; optionally updates `conversation_title` and
   * `last_read_at` in the same statement so each member DO receives one
   * round-trip per message instead of three.
   *
   * Semantics:
   * - `title === undefined` → do not touch the title column.
   * - `title === null`      → clear the title (rare; auto-title always passes a string).
   * - `markRead === true`   → set `last_read_at = activityAt` (user had active WS).
   */
  applyPostCommit(params: {
    conversationId: string;
    title?: string | null;
    activityAt: number;
    markRead: boolean;
  }): void {
    const set: {
      last_activity_at: number;
      conversation_title?: string | null;
      last_read_at?: number;
    } = { last_activity_at: params.activityAt };
    if (params.title !== undefined) set.conversation_title = params.title;
    if (params.markRead) set.last_read_at = params.activityAt;

    this.db
      .update(conversations)
      .set(set)
      .where(eq(conversations.conversation_id, params.conversationId))
      .run();
  }

  removeConversation(conversationId: string): void {
    this.db.delete(conversations).where(eq(conversations.conversation_id, conversationId)).run();
  }

  removeConversationsBySandbox(sandboxId: string): void {
    this.db.delete(conversations).where(eq(conversations.sandbox_id, sandboxId)).run();
  }
}
