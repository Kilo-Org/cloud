import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { eq, desc, sql } from 'drizzle-orm';
import { conversations } from '../db/membership-schema';
import migrations from '../../drizzle/membership/migrations';

export type ConversationEntry = {
  conversationId: string;
  conversationTitle: string | null;
  lastMessageId: string | null;
  lastReadMessageId: string | null;
  joinedAt: number;
};

export type AddConversationParams = {
  conversationId: string;
  conversationTitle: string | null;
  joinedAt: number;
};

export class MembershipDO extends DurableObject<Env> {
  private db;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });
    void ctx.blockConcurrencyWhile(() => migrate(this.db, migrations));
  }

  listConversations(): ConversationEntry[] {
    return this.db
      .select()
      .from(conversations)
      .orderBy(desc(sql`coalesce(${conversations.last_message_id}, '')`))
      .all()
      .map(row => ({
        conversationId: row.conversation_id,
        conversationTitle: row.conversation_title,
        lastMessageId: row.last_message_id,
        lastReadMessageId: row.last_read_message_id,
        joinedAt: row.joined_at,
      }));
  }

  addConversation(params: AddConversationParams): void {
    this.db
      .insert(conversations)
      .values({
        conversation_id: params.conversationId,
        conversation_title: params.conversationTitle,
        joined_at: params.joinedAt,
      })
      .onConflictDoNothing()
      .run();
  }

  updateLastMessageId(conversationId: string, messageId: string): void {
    this.db
      .update(conversations)
      .set({ last_message_id: messageId })
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
