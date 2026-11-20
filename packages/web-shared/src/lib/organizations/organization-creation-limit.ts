import { kilocode_users, organization_memberships, organizations } from '@kilocode/db/schema';
import type { User } from '@kilocode/db/schema';
import { ORGANIZATION_PARENT_ACCESS_ROLES } from '@kilocode/app-shared/organizations';
import type { DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { getLowerDomainFromEmail } from '@kilocode/web-shared/lib/email-address';
import { captureMessage } from '@sentry/nextjs';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';

export const MAX_ORGANIZATIONS_PER_USER = 25;

const INTERNAL_ACCOUNT_DOMAIN = 'kilocode.ai';

/**
 * Staff at `kilocode.ai` organize test and support work, so they are exempt
 * from the per-user creation cap and keep a trial on every organization they
 * create.
 */
export function isInternalAccountEmail(email: string | null | undefined): boolean {
  if (email == null) return false;
  return getLowerDomainFromEmail(email) === INTERNAL_ACCOUNT_DOMAIN;
}

/**
 * Whether an account created by this user receives a trial window: internal
 * accounts always do, and everyone else does until the offer is used.
 */
export function hasOrganizationTrialEligibility(account: {
  internalAccount: boolean;
  trialConsumed: boolean;
}): boolean {
  return account.internalAccount || !account.trialConsumed;
}

/** The same eligibility answer, read from the creator's user row. */
export function userHasOrganizationTrialEligibility(
  user: Pick<User, 'google_user_email' | 'organization_trial_consumed_at'>
): boolean {
  return hasOrganizationTrialEligibility({
    internalAccount: isInternalAccountEmail(user.google_user_email),
    trialConsumed: user.organization_trial_consumed_at != null,
  });
}

export type OrganizationCreationLimit = {
  /** Staff at an internal domain: exempt from the cap and keep a trial on every organization. */
  internalAccount: boolean;
  /** Whether this user already spent their one organization free trial. */
  trialConsumed: boolean;
};

export async function enforceOrganizationCreationLimit(
  tx: DrizzleTransaction,
  userId: User['id']
): Promise<OrganizationCreationLimit> {
  // Both creation paths must acquire this lock before counting organizations.
  // Reading the trial consumption in this same locked row lets the creation
  // transaction decide and stamp it under one lock.
  const [user] = await tx
    .select({
      email: kilocode_users.google_user_email,
      organizationTrialConsumedAt: kilocode_users.organization_trial_consumed_at,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .for('update');

  if (!user) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
  }
  const trialConsumed = user.organizationTrialConsumedAt != null;
  if (isInternalAccountEmail(user.email)) {
    return { internalAccount: true, trialConsumed };
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
        inArray(organization_memberships.role, ORGANIZATION_PARENT_ACCESS_ROLES)
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

  return { internalAccount: false, trialConsumed };
}
