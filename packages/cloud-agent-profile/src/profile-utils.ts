import { agent_environment_profiles } from '@kilocode/db/schema';
import { count, eq, and, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { MAX_OWNER_PROFILES } from './contracts/profiles';
import type { ProfileDatabase, ProfileOwner } from './types';

/**
 * Build ownership condition for profile queries.
 */
export function buildOwnershipCondition(owner: ProfileOwner) {
  return owner.type === 'user'
    ? eq(agent_environment_profiles.owned_by_user_id, owner.id)
    : eq(agent_environment_profiles.owned_by_organization_id, owner.id);
}

/**
 * Verify that a profile exists and is owned by the specified owner.
 * @throws TRPCError with NOT_FOUND if profile doesn't exist or isn't owned by the owner
 */
export async function verifyProfileOwnership(
  db: ProfileDatabase,
  profileId: string,
  owner: ProfileOwner
) {
  const [profile] = await db
    .select()
    .from(agent_environment_profiles)
    .where(and(eq(agent_environment_profiles.id, profileId), buildOwnershipCondition(owner)))
    .limit(1);

  if (!profile) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Profile not found',
    });
  }

  return profile;
}

/**
 * Serialize profile creation for one owner.
 *
 * A transaction-scoped advisory lock keyed on the owner, so the count and the
 * insert of every create for that owner are one ordered unit. The key names
 * the owner instead of locking its row: profile creation is the only writer
 * that needs the whole owner serialized, and a row lock on the user or
 * organization row would queue behind unrelated credit and membership writes.
 */
export async function lockProfileCreation(db: ProfileDatabase, owner: ProfileOwner): Promise<void> {
  const key = `agent-environment-profile-creation:${owner.type}:${owner.id}`;
  await db.execute(
    sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${key}, 0))`
  );
}

/**
 * Reject a create that would take an owner past {@link MAX_OWNER_PROFILES}.
 * Callers hold the owner's creation lock, so the count cannot move before the
 * insert it guards.
 */
export async function assertOwnerProfileLimit(
  db: ProfileDatabase,
  owner: ProfileOwner
): Promise<void> {
  const [row] = await db
    .select({ n: count() })
    .from(agent_environment_profiles)
    .where(buildOwnershipCondition(owner));

  if (Number(row.n) >= MAX_OWNER_PROFILES) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Profiles are limited to ${MAX_OWNER_PROFILES} per user or organization`,
    });
  }
}

/**
 * Like {@link verifyProfileOwnership} but takes a row lock so a concurrent
 * delete, bind, or settings write serializes on the profile row.
 */
export async function lockProfileOwnership(
  db: ProfileDatabase,
  profileId: string,
  owner: ProfileOwner
) {
  const [profile] = await db
    .select()
    .from(agent_environment_profiles)
    .where(and(eq(agent_environment_profiles.id, profileId), buildOwnershipCondition(owner)))
    .limit(1)
    .for('update');

  if (!profile) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Profile not found',
    });
  }

  return profile;
}
