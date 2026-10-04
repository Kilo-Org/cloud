import { eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/durable-sqlite';
import {
  removeSessionCredentialMembership,
  sessionCredentialGrantSchema,
  type SessionCredentialGrant,
} from '../../sandbox-control/session-credentials.js';
import { scopeGrants } from './sqlite-schema.js';

type GrantDatabase = Pick<ReturnType<typeof drizzle>, 'select' | 'insert' | 'delete'>;

export function scopeGrantId(grant: SessionCredentialGrant): string {
  return `${grant.scopeId}:${grant.kilo.runtimeProxy === undefined ? 'legacy' : 'runtime'}`;
}

export function readScopeGrant(db: GrantDatabase, id: string): SessionCredentialGrant | null {
  const row = db.select().from(scopeGrants).where(eq(scopeGrants.id, id)).get();
  return row === undefined ? null : sessionCredentialGrantSchema.parse(JSON.parse(row.grant));
}

export function listScopeGrants(db: GrantDatabase): SessionCredentialGrant[] {
  return db
    .select()
    .from(scopeGrants)
    .all()
    .map(row => sessionCredentialGrantSchema.parse(JSON.parse(row.grant)));
}

export function writeScopeGrant(db: GrantDatabase, grant: SessionCredentialGrant): void {
  const row = { id: scopeGrantId(grant), grant: JSON.stringify(grant) };
  db.insert(scopeGrants).values(row).onConflictDoUpdate({ target: scopeGrants.id, set: row }).run();
}

export function removeScopeMember(db: GrantDatabase, sessionId: string): void {
  for (const grant of listScopeGrants(db)) {
    const remaining = removeSessionCredentialMembership([grant], sessionId)[0];
    if (remaining === undefined)
      db.delete(scopeGrants)
        .where(eq(scopeGrants.id, scopeGrantId(grant)))
        .run();
    else if (remaining !== grant) writeScopeGrant(db, remaining);
  }
}

export function retireScopeGrants(db: GrantDatabase): void {
  for (const { id } of db.select({ id: scopeGrants.id }).from(scopeGrants).all()) {
    db.delete(scopeGrants).where(eq(scopeGrants.id, id)).run();
  }
}
