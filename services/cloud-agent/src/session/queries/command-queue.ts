import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { eq, lt, asc, and, count } from 'drizzle-orm';
import { commandQueue } from '../../db/sqlite-schema.js';

type SqlStorage = DurableObjectState['storage']['sql'];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QueuedCommand = typeof commandQueue.$inferSelect;

// ---------------------------------------------------------------------------
// Factory Function
// ---------------------------------------------------------------------------

export function createCommandQueueQueries(db: DrizzleSqliteDODatabase, rawSql: SqlStorage) {
  return {
    enqueue(sessionId: string, executionId: string, messageJson: string): number {
      const now = Date.now();
      const result = db
        .insert(commandQueue)
        .values({
          session_id: sessionId,
          execution_id: executionId,
          message_json: messageJson,
          created_at: now,
        })
        .returning({ id: commandQueue.id })
        .get();
      return result.id;
    },

    peekOldest(sessionId: string): QueuedCommand | null {
      const row = db
        .select()
        .from(commandQueue)
        .where(eq(commandQueue.session_id, sessionId))
        .orderBy(asc(commandQueue.id))
        .limit(1)
        .get();
      return row ?? null;
    },

    dequeueById(id: number): void {
      db.delete(commandQueue).where(eq(commandQueue.id, id)).run();
    },

    count(sessionId: string): number {
      const result = db
        .select({ count: count() })
        .from(commandQueue)
        .where(eq(commandQueue.session_id, sessionId))
        .get();
      return result?.count ?? 0;
    },

    deleteOlderThan(timestamp: number): number {
      const { sql: query, params } = db
        .delete(commandQueue)
        .where(lt(commandQueue.created_at, timestamp))
        .toSQL();
      return rawSql.exec(query, ...params).rowsWritten;
    },

    deleteExpired(sessionId: string, expiryMs: number = 60 * 60 * 1000): number {
      const cutoff = Date.now() - expiryMs;
      const { sql: query, params } = db
        .delete(commandQueue)
        .where(and(eq(commandQueue.session_id, sessionId), lt(commandQueue.created_at, cutoff)))
        .toSQL();
      return rawSql.exec(query, ...params).rowsWritten;
    },
  };
}

// ---------------------------------------------------------------------------
// Type Export
// ---------------------------------------------------------------------------

export type CommandQueueQueries = ReturnType<typeof createCommandQueueQueries>;
