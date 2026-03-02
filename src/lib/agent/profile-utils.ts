import 'server-only';
import { db } from '@/lib/drizzle';
import { agent_environment_profiles } from '@kilocode/db/schema';
import { eq, and } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import type { ProfileOwner } from './types';

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
export async function verifyProfileOwnership(profileId: string, owner: ProfileOwner) {
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
