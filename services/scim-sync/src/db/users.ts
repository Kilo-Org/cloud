import { kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import type { WorkerDb } from './pg';

export type UserRow = typeof kilocode_users.$inferSelect;

/**
 * A user ID is an arbitrary string, not a UUID — OAuth IDs are shaped
 * `oauth/...`. Never validate, parse, or cast one as a UUID.
 */
export async function findUserById(db: WorkerDb, kiloUserId: string): Promise<UserRow | null> {
  const rows = await db
    .select()
    .from(kilocode_users)
    .where(eq(kilocode_users.id, kiloUserId))
    .limit(1);
  return rows.at(0) ?? null;
}

/**
 * Resolve a directory-provisioned user by their WorkOS identifier.
 *
 * Returns every match rather than one: `IDX_kilocode_users_external_id` is
 * non-unique, so the database does not prevent two users sharing an
 * `external_id`. A caller that needs exactly one must decide what a duplicate
 * means rather than silently taking the first row.
 *
 * `kilocode_users` has no `deleted_at`; a deleted user is anonymized in place
 * with `external_id` set to null, so anonymized rows never match here.
 */
export async function findUsersByExternalId(db: WorkerDb, externalId: string): Promise<UserRow[]> {
  return db.select().from(kilocode_users).where(eq(kilocode_users.external_id, externalId));
}

/**
 * `normalized_email` is nullable and is cleared when a user is anonymized, so
 * an anonymized row never matches a real address.
 */
export async function findUserByNormalizedEmail(
  db: WorkerDb,
  normalizedEmail: string
): Promise<UserRow | null> {
  const rows = await db
    .select()
    .from(kilocode_users)
    .where(eq(kilocode_users.normalized_email, normalizedEmail))
    .limit(1);
  return rows.at(0) ?? null;
}
