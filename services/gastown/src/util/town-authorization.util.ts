import { getWorkerDb } from '@kilocode/db/client';
import { kilocode_users, organization_memberships, organizations } from '@kilocode/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

type PrivateTownIdentity = {
  ownerType: 'user' | 'org';
  ownerUserId: string;
  organizationId?: string;
  runtimeMode: 'legacy' | 'modern';
};

export type TownAuthorization =
  | { type: 'user' }
  | { type: 'org'; organizationId: string; role: string }
  | { type: 'admin' };

export class TownAuthorizationUnavailableError extends Error {}

export async function authorizeTown(
  env: Pick<Env, 'HYPERDRIVE'>,
  identity: PrivateTownIdentity,
  userId: string,
  apiTokenPepper: string | null
): Promise<TownAuthorization | null> {
  if (identity.runtimeMode !== 'modern') return null;
  if (!env.HYPERDRIVE) throw new TownAuthorizationUnavailableError();

  const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 5_000 });
  const [principal] = await db
    .select({
      pepper: kilocode_users.api_token_pepper,
      blockedAt: kilocode_users.blocked_at,
      blockedReason: kilocode_users.blocked_reason,
      isAdmin: kilocode_users.is_admin,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1);

  if (
    !principal ||
    principal.blockedAt !== null ||
    principal.blockedReason !== null ||
    !apiTokenPepper ||
    !principal.pepper ||
    principal.pepper !== apiTokenPepper
  ) {
    return null;
  }

  if (principal.isAdmin) return { type: 'admin' };
  if (identity.ownerType === 'user') {
    return identity.ownerUserId === userId ? { type: 'user' } : null;
  }
  if (!identity.organizationId) return null;

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

  if (!membership || membership.role === 'billing_manager') return null;
  return { type: 'org', organizationId: identity.organizationId, role: membership.role };
}
