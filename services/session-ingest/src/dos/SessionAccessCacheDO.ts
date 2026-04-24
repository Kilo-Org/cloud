import { DurableObject } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';

import { sessions } from '../db/sqlite-schema';
import type { Env } from '../env';
import migrations from '../../drizzle/migrations';

/**
 * Strongly-consistent per-user cache of session ids.
 *
 * Keyed by kiloUserId (one instance per user).
 */
export class SessionAccessCacheDO extends DurableObject<Env> {
  private db: DrizzleSqliteDODatabase;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.db = drizzle(state.storage, { logger: false });

    void state.blockConcurrencyWhile(async () => {
      migrate(this.db, migrations);
    });
  }

  async has(sessionId: string): Promise<boolean> {
    const row = this.db
      .select({ ok: sql<number>`1` })
      .from(sessions)
      .where(eq(sessions.session_id, sessionId))
      .get();
    return row !== undefined;
  }

  async add(sessionId: string): Promise<void> {
    this.db.insert(sessions).values({ session_id: sessionId }).onConflictDoNothing().run();
  }

  async remove(sessionId: string): Promise<void> {
    this.db.delete(sessions).where(eq(sessions.session_id, sessionId)).run();
  }
}

export function getSessionAccessCacheDO(env: Env, params: { kiloUserId: string }) {
  const id = env.SESSION_ACCESS_CACHE_DO.idFromName(params.kiloUserId);
  return env.SESSION_ACCESS_CACHE_DO.get(id);
}
