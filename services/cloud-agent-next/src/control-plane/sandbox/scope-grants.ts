import { eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/durable-sqlite';
import {
  persistedSessionCredentialGrantSchema,
  removeSessionCredentialMembership,
  type SessionCredentialGrant,
} from '../../sandbox-control/session-credentials.js';
import { retireAcceptedHandlesSync, type SyncAcceptedHandleStorage } from './accepted-handles.js';
import { scopeGrants } from './sqlite-schema.js';

type GrantDatabase = Pick<ReturnType<typeof drizzle>, 'select' | 'insert' | 'delete'>;

/** A readable persisted grant, or null for a row this version cannot interpret. */
function parsePersistedGrant(raw: string): SessionCredentialGrant | null {
  try {
    const parsed = persistedSessionCredentialGrantSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function scopeGrantId(grant: SessionCredentialGrant): string {
  return `${grant.scopeId}:${grant.kilo.runtimeProxy === undefined ? 'legacy' : 'runtime'}`;
}

export function readScopeGrant(db: GrantDatabase, id: string): SessionCredentialGrant | null {
  const row = db.select().from(scopeGrants).where(eq(scopeGrants.id, id)).get();
  return row === undefined ? null : parsePersistedGrant(row.grant);
}

export function listScopeGrants(db: GrantDatabase): SessionCredentialGrant[] {
  return db
    .select()
    .from(scopeGrants)
    .all()
    .flatMap(row => {
      const grant = parsePersistedGrant(row.grant);
      return grant === null ? [] : [grant];
    });
}

export function writeScopeGrant(db: GrantDatabase, grant: SessionCredentialGrant): void {
  const row = { id: scopeGrantId(grant), grant: JSON.stringify(grant) };
  db.insert(scopeGrants).values(row).onConflictDoUpdate({ target: scopeGrants.id, set: row }).run();
}

/**
 * Removes a session from every scope grant and retires the accepted-handle set
 * of any grant that lost its last member. Both writes run in the caller's
 * `transactionSync`, so the SQL delete and the KV retirement commit together.
 */
export function removeScopeMember(
  db: GrantDatabase,
  store: SyncAcceptedHandleStorage,
  sessionId: string
): void {
  for (const grant of listScopeGrants(db)) {
    const remaining = removeSessionCredentialMembership([grant], sessionId)[0];
    if (remaining === undefined) {
      const id = scopeGrantId(grant);
      db.delete(scopeGrants).where(eq(scopeGrants.id, id)).run();
      retireAcceptedHandlesSync(store, id);
    } else if (remaining !== grant) writeScopeGrant(db, remaining);
  }
}

/** Deletes every scope grant and the whole accepted-handle side store together. */
export function retireScopeGrants(db: GrantDatabase, store: SyncAcceptedHandleStorage): void {
  for (const { id } of db.select({ id: scopeGrants.id }).from(scopeGrants).all()) {
    db.delete(scopeGrants).where(eq(scopeGrants.id, id)).run();
  }
  retireAcceptedHandlesSync(store);
}
