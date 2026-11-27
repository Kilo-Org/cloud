import 'server-only';

import { kilocode_users, organization_memberships, organizations } from '@kilocode/db/schema';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import { buildBitbucketOrganizationCredentialLockKey } from '@kilocode/worker-utils/bitbucket-workspace-access-token';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';

export type BitbucketWorkspaceAccessTokenAuthorizedActor = {
  id: string;
  email: string | null;
  name: string | null;
};

/**
 * How the request boundary admitted the actor. `member` needs a locked owner or
 * billing membership. `staff` means the staff guard already admitted the actor
 * at the procedure boundary: the transaction re-reads the locked staff role so
 * a revoked role cannot finish the change, and claims no second proof.
 */
export type BitbucketOrganizationManagerAuthority = 'member' | 'staff';

export type BitbucketWorkspaceAccessTokenAuthorizationErrorCode =
  | 'unauthorized'
  | 'organization_not_found';

export class BitbucketWorkspaceAccessTokenOrganizationAuthorizationError extends Error {
  constructor(readonly code: BitbucketWorkspaceAccessTokenAuthorizationErrorCode) {
    super(
      code === 'organization_not_found'
        ? 'The organization was not found'
        : 'The current user cannot manage this organization integration'
    );
    this.name = 'BitbucketWorkspaceAccessTokenOrganizationAuthorizationError';
  }
}

export async function lockBitbucketWorkspaceAccessTokenOrganization(
  tx: DrizzleTransaction,
  organizationId: string
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${buildBitbucketOrganizationCredentialLockKey(organizationId)}, 0))`
  );
}

export async function requireBitbucketWorkspaceAccessTokenOrganizationManager(
  tx: DrizzleTransaction,
  organizationId: string,
  actorUserId: string,
  authority: BitbucketOrganizationManagerAuthority
): Promise<BitbucketWorkspaceAccessTokenAuthorizedActor> {
  const [organization] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for('update');
  if (!organization) {
    throw new BitbucketWorkspaceAccessTokenOrganizationAuthorizationError('organization_not_found');
  }

  const [actor] = await tx
    .select({
      id: kilocode_users.id,
      email: kilocode_users.google_user_email,
      name: kilocode_users.google_user_name,
      isAdmin: kilocode_users.is_admin,
    })
    .from(kilocode_users)
    .where(
      and(
        eq(kilocode_users.id, actorUserId),
        isNull(kilocode_users.blocked_at),
        isNull(kilocode_users.blocked_reason)
      )
    )
    .for('update');
  if (!actor) {
    throw new BitbucketWorkspaceAccessTokenOrganizationAuthorizationError('unauthorized');
  }

  if (authority === 'staff') {
    if (!actor.isAdmin) {
      throw new BitbucketWorkspaceAccessTokenOrganizationAuthorizationError('unauthorized');
    }
  } else {
    const [membership] = await tx
      .select({ id: organization_memberships.id })
      .from(organization_memberships)
      .where(
        and(
          eq(organization_memberships.organization_id, organizationId),
          eq(organization_memberships.kilo_user_id, actorUserId),
          inArray(organization_memberships.role, ORGANIZATION_BILLING_ROLES)
        )
      )
      .for('update');
    if (!membership) {
      throw new BitbucketWorkspaceAccessTokenOrganizationAuthorizationError('unauthorized');
    }
  }

  return { id: actor.id, email: actor.email, name: actor.name };
}
