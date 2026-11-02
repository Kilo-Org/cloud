import type { WorkerDb } from '@kilocode/db/client';
import { kilocode_users } from '@kilocode/db/schema';
import { isOrganizationMember } from '@kilocode/worker-utils/account-access';
import { eq } from 'drizzle-orm';

// Account rules for a signed organization claim: the claim names an identity and an
// organization, and both must still hold before the claim authorizes a write.

type IdentityDb = Pick<WorkerDb, 'select'>;

export type AttributionIdentityRefusal =
  | 'identity_missing'
  | 'identity_blocked'
  | 'membership_missing';

export type AttributionIdentityClaims = {
  kiloUserId: string;
  organizationId: string;
};

/**
 * Resolves why the claimed identity may not act for the claimed organization, or `null`
 * when it may. An identity is refused when the account row is gone, when the account is
 * blocked (`blocked_at` or `blocked_reason`, the same rule as runtime authorizations), or
 * when it holds no membership row for a live organization.
 */
export async function findAttributionIdentityRefusal(
  db: IdentityDb,
  claims: AttributionIdentityClaims
): Promise<AttributionIdentityRefusal | null> {
  const [account] = await db
    .select({
      blockedAt: kilocode_users.blocked_at,
      blockedReason: kilocode_users.blocked_reason,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, claims.kiloUserId))
    .limit(1);

  if (!account) return 'identity_missing';
  if (account.blockedAt !== null || account.blockedReason !== null) return 'identity_blocked';

  return (await isOrganizationMember(db, claims.organizationId, claims.kiloUserId))
    ? null
    : 'membership_missing';
}
