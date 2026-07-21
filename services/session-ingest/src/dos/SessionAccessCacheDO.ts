import { DurableObject } from 'cloudflare:workers';
import { and, eq, gt, lte } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';

import { sessions } from '../db/sqlite-schema';
import type { Env } from '../env';
import migrations from '../../drizzle/migrations';

export const SESSION_ACCESS_CACHE_TTL_MS = 60_000;

export type CachedSessionAccess = {
  sessionId: string;
  organizationId: string | null;
};

/**
 * Strongly-consistent per-user cache of recently validated session access.
 *
 * Keyed by kiloUserId (one instance per user).
 */
export class SessionAccessCacheDO extends DurableObject<Env> {
  private db: DrizzleSqliteDODatabase;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.db = drizzle(state.storage, { logger: false });

    void state.blockConcurrencyWhile(() => {
      return migrate(this.db, migrations);
    });
  }

  async getAccess(sessionId: string): Promise<CachedSessionAccess | null> {
    const row = this.db
      .select({
        sessionId: sessions.session_id,
        organizationId: sessions.organization_id,
      })
      .from(sessions)
      .where(
        and(eq(sessions.session_id, sessionId), gt(sessions.authorization_expires_at, Date.now()))
      )
      .get();
    return row ?? null;
  }

  // TODO(session-access-rollout): Remove legacy RPCs after all pre-TTL Workers are retired.
  /** @deprecated Mixed-version deployment compatibility only. */
  async has(sessionId: string): Promise<boolean> {
    return (await this.getAccess(sessionId)) !== null;
  }

  /** @deprecated The legacy signature cannot safely cache organization-scoped access. */
  async add(_sessionId: string): Promise<void> {
    return;
  }

  async putValidated(access: CachedSessionAccess): Promise<void> {
    const now = Date.now();
    const authorizationExpiresAt = now + SESSION_ACCESS_CACHE_TTL_MS;
    // Expired rows are unreadable but would otherwise accumulate forever;
    // purging on write keeps per-user storage bounded without a schedule.
    this.db.delete(sessions).where(lte(sessions.authorization_expires_at, now)).run();
    this.db
      .insert(sessions)
      .values({
        session_id: access.sessionId,
        organization_id: access.organizationId,
        authorization_expires_at: authorizationExpiresAt,
      })
      .onConflictDoUpdate({
        target: sessions.session_id,
        set: {
          organization_id: access.organizationId,
          authorization_expires_at: authorizationExpiresAt,
        },
      })
      .run();
  }

  async remove(sessionId: string): Promise<void> {
    this.db.delete(sessions).where(eq(sessions.session_id, sessionId)).run();
  }

  async invalidateOrganization(organizationId: string): Promise<void> {
    this.db.delete(sessions).where(eq(sessions.organization_id, organizationId)).run();
  }
}

export function getSessionAccessCacheDO(env: Env, params: { kiloUserId: string }) {
  const id = env.SESSION_ACCESS_CACHE_DO.idFromName(params.kiloUserId);
  return env.SESSION_ACCESS_CACHE_DO.get(id);
}
