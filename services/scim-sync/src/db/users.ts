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
 * `external_id` is the *only* directory identifier on `kilocode_users`. There
 * is no `directory_id` or `directory_user_id` column: the `directory_*` columns
 * live on `organizations` alone (`packages/db/src/schema.ts:3370-3372`), where
 * they bind an organization to a WorkOS directory and group. A user's tie to
 * the directory is this single WorkOS id.
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
 * Resolve a user by normalized email.
 *
 * Returns every match, like `findUsersByExternalId`:
 * `IDX_kilocode_users_normalized_email` is a plain non-unique index
 * (`packages/db/src/schema.ts:595`), so taking the first of several rows would
 * pick a non-deterministic one. The app-side resolver reads two candidates
 * specifically to detect ambiguity rather than choose
 * (`apps/web/src/lib/user/index.ts:2143-2152`), and linking a directory user to
 * the wrong Kilo account is the failure this prevents.
 *
 * `normalized_email` is nullable and is cleared when a user is anonymized, so
 * an anonymized row never matches a real address.
 */
export async function findUsersByNormalizedEmail(
  db: WorkerDb,
  normalizedEmail: string
): Promise<UserRow[]> {
  return db
    .select()
    .from(kilocode_users)
    .where(eq(kilocode_users.normalized_email, normalizedEmail));
}
