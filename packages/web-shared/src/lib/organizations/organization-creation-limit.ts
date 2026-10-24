import { kilocode_users, organization_memberships, organizations } from '@kilocode/db/schema';
import type { User } from '@kilocode/db/schema';
import type { DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { getLowerDomainFromEmail } from '@kilocode/web-shared/lib/email-address';
import { captureMessage } from '@sentry/nextjs';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';

const MAX_ORGANIZATIONS_PER_USER = 5;

export async function enforceOrganizationCreationLimit(
  tx: DrizzleTransaction,
  userId: User['id']
): Promise<void> {
  // Both creation paths must acquire this lock before counting organizations.
  const [user] = await tx
    .select({ email: kilocode_users.google_user_email })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .for('update');

  if (!user) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
  }
  if (getLowerDomainFromEmail(user.email) === 'kilocode.ai') {
    return;
  }

  const directOrganizations = tx
    .select({ id: organization_memberships.organization_id })
    .from(organization_memberships)
    .where(eq(organization_memberships.kilo_user_id, userId));
  const managedParents = tx
    .select({ id: organization_memberships.organization_id })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.kilo_user_id, userId),
        inArray(organization_memberships.role, ['owner', 'admin', 'billing_manager'])
      )
    );
  const existingOrganizations = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        isNull(organizations.deleted_at),
        or(
          eq(organizations.created_by_kilo_user_id, userId),
          inArray(organizations.id, directOrganizations),
          inArray(organizations.parent_organization_id, managedParents)
        )
      )
    )
    .limit(MAX_ORGANIZATIONS_PER_USER);

  if (existingOrganizations.length >= MAX_ORGANIZATIONS_PER_USER) {
    captureMessage('User hit max organizations', {
      level: 'warning',
      extra: { userId, max: MAX_ORGANIZATIONS_PER_USER },
    });
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: `You have reached the maximum number of organizations (${MAX_ORGANIZATIONS_PER_USER}) allowed. Please contact support if you need more.`,
    });
  }
}
