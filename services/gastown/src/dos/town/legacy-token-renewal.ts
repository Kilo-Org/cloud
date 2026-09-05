import { getWorkerDb } from '@kilocode/db/client';
import { kilocode_users, organization_memberships, organizations } from '@kilocode/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

type PrivateTownIdentity = {
  ownerType: 'user' | 'org';
  ownerUserId: string;
  organizationId?: string;
};

/**
 * Checks the current database state before renewing a legacy town token.
 * Legacy JWT claims and mutable town configuration are not authorization
 * sources: the stored private identity and current PostgreSQL records are.
 */
export async function isLegacyTownTokenRenewalAuthorized(
  env: Pick<Env, 'HYPERDRIVE'>,
  identity: PrivateTownIdentity,
  userId: string,
  tokenPepper: string | null
): Promise<boolean> {
  if (!env.HYPERDRIVE || identity.ownerUserId !== userId) return false;

  const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 5_000 });
  const [user] = await db
    .select({
      pepper: kilocode_users.api_token_pepper,
      blockedAt: kilocode_users.blocked_at,
      blockedReason: kilocode_users.blocked_reason,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1);

  if (
    !user ||
    user.blockedAt !== null ||
    user.blockedReason !== null ||
    user.pepper === null ||
    tokenPepper === null ||
    user.pepper !== tokenPepper
  ) {
    return false;
  }

  if (identity.ownerType === 'user') return true;
  if (!identity.organizationId) return false;

  const [membership] = await db
    .select({ role: organization_memberships.role })
    .from(organization_memberships)
    .innerJoin(organizations, eq(organizations.id, organization_memberships.organization_id))
    .where(
      and(
        eq(organization_memberships.kilo_user_id, userId),
        eq(organization_memberships.organization_id, identity.organizationId),
        isNull(organizations.deleted_at)
      )
    )
    .limit(1);

  return membership !== undefined && membership.role !== 'billing_manager';
}
