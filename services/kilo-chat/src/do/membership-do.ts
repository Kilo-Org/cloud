import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { eq, desc, sql } from 'drizzle-orm';
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

export class MembershipDO extends DurableObject<Env> {
  private db;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });
    void ctx.blockConcurrencyWhile(() => migrate(this.db, migrations));
  }

  listConversations(
    sandboxId?: string,
    limit: number = 50,
    offset: number = 0
  ): { conversations: ConversationEntry[]; hasMore: boolean } {
    const where = sandboxId ? eq(conversations.sandbox_id, sandboxId) : undefined;

    const rows = this.db
      .select()
      .from(conversations)
      .where(where)
      .orderBy(desc(sql`coalesce(${conversations.last_activity_at}, ${conversations.joined_at})`))
      .limit(limit + 1)
      .offset(offset)
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

    return { conversations: rows, hasMore };
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
