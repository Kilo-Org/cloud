import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { eq, desc, sql } from 'drizzle-orm';
import { conversations } from '../db/membership-schema';
import migrations from '../../drizzle/membership/migrations';

export type ConversationEntry = {
  conversationId: string;
  conversationTitle: string | null;
  lastActivityAt: number | null;
  lastReadAt: number | null;
  joinedAt: number;
};

export type AddConversationParams = {
  conversationId: string;
  conversationTitle: string | null;
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
  ): { conversations: ConversationEntry[]; total: number } {
    const where = sandboxId ? eq(conversations.sandbox_id, sandboxId) : undefined;

    const total =
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(conversations)
        .where(where)
        .get()?.count ?? 0;

    const rows = this.db
      .select()
      .from(conversations)
      .where(where)
      .orderBy(desc(sql`coalesce(${conversations.last_activity_at}, ${conversations.joined_at})`))
      .limit(limit)
      .offset(offset)
      .all()
      .map(row => ({
        conversationId: row.conversation_id,
        conversationTitle: row.conversation_title,
        lastActivityAt: row.last_activity_at,
        lastReadAt: row.last_read_at,
        joinedAt: row.joined_at,
      }));

    return { conversations: rows, total };
  }

  addConversation(params: AddConversationParams): void {
    this.db
      .insert(conversations)
      .values({
        conversation_id: params.conversationId,
        conversation_title: params.conversationTitle,
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

  updateConversationTitle(conversationId: string, title: string | null): void {
    this.db
      .update(conversations)
      .set({ conversation_title: title })
      .where(eq(conversations.conversation_id, conversationId))
      .run();
  }

  removeConversation(conversationId: string): void {
    this.db.delete(conversations).where(eq(conversations.conversation_id, conversationId)).run();
  }
}
