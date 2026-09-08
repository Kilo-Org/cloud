import { getWorkerDb } from '@kilocode/db/client';
import { kilocode_users, organization_memberships, organizations } from '@kilocode/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

type PrivateTownIdentity = {
  ownerType: 'user' | 'org';
  ownerUserId: string;
  organizationId?: string;
};

type LegacyTokenActor = {
  id: string;
  apiTokenPepper: string | null;
};

export type LegacyTokenOwner = {
  id: string;
  api_token_pepper: string;
};

export class LegacyTownTokenRenewalUnavailableError extends Error {}

function isCurrentAccount(
  user:
    | {
        pepper: string | null;
        blockedAt: Date | string | null;
        blockedReason: string | null;
      }
    | undefined,
  tokenPepper?: string | null
): user is { pepper: string; blockedAt: Date | string | null; blockedReason: string | null } {
  return (
    user !== undefined &&
    user.blockedAt === null &&
    user.blockedReason === null &&
    user.pepper !== null &&
    (tokenPepper === undefined || (tokenPepper !== null && user.pepper === tokenPepper))
  );
}

export async function resolveLegacyTownTokenOwner(
  env: Pick<Env, 'HYPERDRIVE'>,
  identity: PrivateTownIdentity,
  actor: LegacyTokenActor
): Promise<LegacyTokenOwner | null> {
  if (!env.HYPERDRIVE) throw new LegacyTownTokenRenewalUnavailableError();

  try {
    const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 5_000 });
    const [principal] = await db
      .select({
        pepper: kilocode_users.api_token_pepper,
        blockedAt: kilocode_users.blocked_at,
        blockedReason: kilocode_users.blocked_reason,
      })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, actor.id))
      .limit(1);

    if (!isCurrentAccount(principal, actor.apiTokenPepper)) return null;
    if (identity.ownerType === 'user' && identity.ownerUserId !== actor.id) return null;

    const isEligibleMember = async (userId: string): Promise<boolean> => {
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
    };

    if (identity.ownerType === 'org' && !(await isEligibleMember(actor.id))) return null;

    const owner =
      actor.id === identity.ownerUserId
        ? principal
        : (
            await db
              .select({
                pepper: kilocode_users.api_token_pepper,
                blockedAt: kilocode_users.blocked_at,
                blockedReason: kilocode_users.blocked_reason,
              })
              .from(kilocode_users)
              .where(eq(kilocode_users.id, identity.ownerUserId))
              .limit(1)
          )[0];

    if (!isCurrentAccount(owner)) return null;
    if (identity.ownerType === 'org' && actor.id !== identity.ownerUserId) {
      if (!(await isEligibleMember(identity.ownerUserId))) return null;
    }

    return { id: identity.ownerUserId, api_token_pepper: owner.pepper };
  } catch (error) {
    if (error instanceof LegacyTownTokenRenewalUnavailableError) throw error;
    throw new LegacyTownTokenRenewalUnavailableError();
  }
}

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
  if (identity.ownerUserId !== userId) return false;
  return (
    (await resolveLegacyTownTokenOwner(env, identity, {
      id: userId,
      apiTokenPepper: tokenPepper,
    })) !== null
  );
}
