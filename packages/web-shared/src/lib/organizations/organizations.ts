import type {
  User,
  Organization,
  OrganizationInvitation,
  OrganizationSeatsPurchase,
} from '@kilocode/db/schema';
import {
  type OrganizationRole,
  type UserOrganizationWithSeats,
  type OrganizationMember,
  type AcceptInviteResult,
  type OrganizationSettings,
  OrganizationSettingsSchema,
} from '@kilocode/web-shared/lib/organizations/organization-types';
import {
  agent_briefing_context_preferences,
  cloud_agent_environments,
  cli_sessions_v2,
  kilocode_users,
  organization_invitations,
  organization_membership_removals,
  organization_memberships,
  organization_seats_purchases,
  organization_user_limits,
  organization_user_usage,
  organizations,
  provider_oauth_attempts,
  external_side_effect_outbox,
} from '@kilocode/db/schema';
import type { DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { auto_deleted_at, db, sql } from '@kilocode/web-shared/lib/drizzle';
import { and, asc, desc, eq, inArray, isNull, gt, or } from 'drizzle-orm';
import { TRIAL_DURATION_DAYS } from '@kilocode/web-shared/lib/constants';
import { randomUUID } from 'crypto';
import {
  getDeliveredEmailAddress,
  getLowerDomainFromEmail,
  normalizeEmail,
} from '@kilocode/web-shared/lib/email-address';
import { fromMicrodollars } from '@kilocode/app-shared/utils';
import { resolveEffectiveOrganizationSsoPolicy } from './organization-sso-policy';
import { classifyOrganizationEntitlement } from './trial-utils';
import { logExceptInTest, warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { createAuditLog } from '@kilocode/web-shared/lib/organizations/organization-audit-logs';
import { captureOrganizationMemberJoined } from '@kilocode/web-shared/lib/organizations/organization-member-analytics';
import { failureResult, successResult } from '@kilocode/web-shared/lib/maybe-result';
import {
  bumpOrganizationGroupPolicyRevision,
  lockOrganizationGroupPolicy,
} from '@kilocode/web-shared/lib/organizations/organization-groups';
import { enforceOrganizationCreationLimit } from '@kilocode/web-shared/lib/organizations/organization-creation-limit';

export async function getOrganizationById(
  id: Organization['id'],
  txn?: DrizzleTransaction
): Promise<Organization | null> {
  return (
    (await (txn || db).query.organizations.findFirst({
      where: and(eq(organizations.id, id), isNull(organizations.deleted_at)),
    })) || null
  );
}

export async function findOrganizationByStripeCustomerId(
  stripeCustomerId: string,
  txn?: DrizzleTransaction
): Promise<Organization | null> {
  return (
    (await (txn || db).query.organizations.findFirst({
      where: and(
        eq(organizations.stripe_customer_id, stripeCustomerId),
        isNull(organizations.deleted_at)
      ),
    })) || null
  );
}

export async function getUserOrganizationsWithSeats(
  userId: User['id']
): Promise<UserOrganizationWithSeats[]> {
  // `organization_seats_purchases` is append-only, so the most recently created
  // row is the organization's current subscription state — the same input the
  // subscription gate classifies with.
  const latestSeatPurchaseStatus = sql<OrganizationSeatsPurchase['subscription_status'] | null>`(
    SELECT ${organization_seats_purchases.subscription_status}
    FROM ${organization_seats_purchases}
    WHERE ${organization_seats_purchases.organization_id} = ${organizations.id}
    ORDER BY ${organization_seats_purchases.created_at} DESC
    LIMIT 1
  )`;
  const results = await db
    .select({
      organizationId: organizations.id,
      organizationName: organizations.name,
      parentOrganizationId: organizations.parent_organization_id,
      role: organization_memberships.role,
      totalMicrodollarsAcquired: organizations.total_microdollars_acquired,
      microdollarsUsed: organizations.microdollars_used,
      requireSeats: organizations.require_seats,
      plan: organizations.plan,
      createdAt: organizations.created_at,
      freeTrialEndAt: organizations.free_trial_end_at,
      settings: organizations.settings,
      latestSeatPurchaseStatus,
      seatCountTotal: organizations.seat_count,
      total_member_count: sql<number>`(
        SELECT COUNT(*)::int FROM (
          SELECT 1 FROM ${organization_memberships} om
          INNER JOIN ${kilocode_users} ku ON ku.id = om.kilo_user_id
          WHERE om.organization_id = ${organizations.id}
            AND om.role != 'billing_manager'
            AND ku.is_bot = false
          UNION ALL
          SELECT 1 FROM ${organization_invitations} oi
          WHERE oi.organization_id = ${organizations.id}
            AND oi.accepted_at IS NULL
            AND oi.expires_at > NOW()
            AND oi.role != 'billing_manager'
        ) combined_count
      )`,
      isSalesDemo: sql<boolean>`COALESCE((${organizations.settings}->>'is_sales_demo')::boolean, false)`,
    })
    .from(organizations)
    .innerJoin(
      organization_memberships,
      eq(organization_memberships.organization_id, organizations.id)
    )
    .where(
      and(eq(organization_memberships.kilo_user_id, userId), isNull(organizations.deleted_at))
    );

  const now = new Date();
  return results.map(result => ({
    organizationName: result.organizationName,
    organizationId: result.organizationId,
    parentOrganizationId: result.parentOrganizationId,
    role: result.role,
    memberCount: result.total_member_count,
    balance: result.totalMicrodollarsAcquired - result.microdollarsUsed,
    requireSeats: result.requireSeats,
    plan: result.plan,
    created_at: result.createdAt,
    isSalesDemo: result.isSalesDemo,
    isTrialExpiredForEnforcement: classifyOrganizationEntitlement({
      organization: {
        created_at: result.createdAt,
        free_trial_end_at: result.freeTrialEndAt,
        require_seats: result.requireSeats,
        settings: result.settings,
      },
      latestSeatPurchaseStatus: result.latestSeatPurchaseStatus,
      now,
    }).isTrialExpiredForEnforcement,
    seatCount: {
      used: result.total_member_count,
      total: result.seatCountTotal,
    },
  }));
}

/**
 * Lightweight query returning just `{orgId, role}` for each org the user
 * belongs to (excluding soft-deleted orgs). Used to bake org memberships
 * into short-lived JWTs so downstream workers can check membership without
 * a DB round-trip.
 */
export async function getUserOrgMemberships(
  userId: User['id']
): Promise<Array<{ orgId: string; role: OrganizationRole }>> {
  const rows = await db
    .select({
      orgId: organization_memberships.organization_id,
      role: organization_memberships.role,
    })
    .from(organization_memberships)
    .innerJoin(organizations, eq(organizations.id, organization_memberships.organization_id))
    .where(
      and(eq(organization_memberships.kilo_user_id, userId), isNull(organizations.deleted_at))
    );
  return rows;
}

export async function userHasOrganizations(userId: User['id']): Promise<boolean> {
  const result = await db
    .select({ id: organization_memberships.id })
    .from(organization_memberships)
    .innerJoin(organizations, eq(organizations.id, organization_memberships.organization_id))
    .where(and(eq(organization_memberships.kilo_user_id, userId), isNull(organizations.deleted_at)))
    .limit(1);
  return result.length > 0;
}

export async function getSingleUserOrganization(userId: User['id']): Promise<Organization | null> {
  const result = await db
    .select({ organization: organizations })
    .from(organization_memberships)
    .innerJoin(organizations, eq(organizations.id, organization_memberships.organization_id))
    .where(and(eq(organization_memberships.kilo_user_id, userId), isNull(organizations.deleted_at)))
    .limit(2);
  return result.length === 1 ? result[0].organization : null;
}

export type ProfileOrganization = {
  id: string;
  name: string;
  role: OrganizationRole;
};

/** One row of the profile query: the org, the caller's membership, and its current seat status. */
type ProfileOrganizationRow = {
  organization: Organization;
  membership: typeof organization_memberships.$inferSelect;
  latestSeatPurchaseStatus: OrganizationSeatsPurchase['subscription_status'] | null;
};

export type GetProfileOrganizationsOptions = {
  // When true, omit organizations whose free trial has hard-expired without an
  // active entitlement (the "Access Blocked" state). These orgs are locked to
  // read-only, so they should not be offered as selectable profile orgs.
  excludeAccessBlocked?: boolean;
};

export async function getProfileOrganizations(
  userId: User['id'],
  options: GetProfileOrganizationsOptions = {}
): Promise<ProfileOrganization[]> {
  const { excludeAccessBlocked = false } = options;

  // Only pull in each org's current subscription status when the caller needs
  // to hide "Access Blocked" orgs. organization_seats_purchases is append-only,
  // so the most recently created row reflects the current state. This keeps
  // getProfileOrganizations a single query and adds no seat-purchase lookup for
  // callers that don't opt in.
  const latestSeatPurchaseStatus = excludeAccessBlocked
    ? sql<OrganizationSeatsPurchase['subscription_status'] | null>`(
        SELECT ${organization_seats_purchases.subscription_status}
        FROM ${organization_seats_purchases}
        WHERE ${organization_seats_purchases.organization_id} = ${organizations.id}
        ORDER BY ${organization_seats_purchases.created_at} DESC
        LIMIT 1
      )`
    : sql<OrganizationSeatsPurchase['subscription_status'] | null>`NULL`;

  const results: ProfileOrganizationRow[] = await db
    .select({
      organization: organizations,
      membership: organization_memberships,
      latestSeatPurchaseStatus,
    })
    .from(organizations)
    .innerJoin(
      organization_memberships,
      eq(organization_memberships.organization_id, organizations.id)
    )
    .where(and(eq(organization_memberships.kilo_user_id, userId), isNull(organizations.deleted_at)))
    // Deterministic order so callers can treat the first element as a stable
    // default selection (e.g. profile `selectedOrganizationId`). Old form was
    // created_at, id; sales-demo orgs win so profile selectedOrganizationId is
    // the demo org.
    .orderBy(
      desc(sql`COALESCE((${organizations.settings}->>'is_sales_demo')::boolean, false)`),
      asc(organizations.created_at),
      asc(organizations.id)
    );

  const parentOrganizationIdsWithMembershipInAChild = new Set(
    results.flatMap(result =>
      result.organization.parent_organization_id ? [result.organization.parent_organization_id] : []
    )
  );

  const now = new Date();
  return results
    .filter(result => !parentOrganizationIdsWithMembershipInAChild.has(result.organization.id))
    .filter(result => {
      if (!excludeAccessBlocked) return true;
      const classification = classifyOrganizationEntitlement({
        organization: result.organization,
        latestSeatPurchaseStatus: result.latestSeatPurchaseStatus,
        now,
      });
      return !classification.isTrialExpiredForEnforcement;
    })
    .map(result => ({
      id: result.organization.id,
      name: result.organization.name,
      role: result.membership.role,
    }));
}

export async function createOrganization(
  name: string,
  userId?: User['id'] | null,
  addUserAsOwner: boolean = true,
  company_domain?: string,
  plan?: 'teams' | 'enterprise'
): Promise<Organization> {
  const organization = await db.transaction(async tx => {
    if (userId) {
      await enforceOrganizationCreationLimit(tx, userId);
    }
    const now = new Date();
    const trialEndDate = new Date(now.getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000);

    const [org] = await tx
      .insert(organizations)
      .values({
        name,
        require_seats: true,
        created_by_kilo_user_id: userId,
        free_trial_end_at: trialEndDate.toISOString(),
        settings: {
          enable_usage_limits: false,
          code_indexing_enabled: true,
          ...(plan === 'enterprise' ? { recommendations_digest_enabled: true } : {}),
        },
        ...(company_domain ? { company_domain } : {}),
        ...(plan ? { plan } : {}),
      })
      .returning();

    if (!userId || !addUserAsOwner) {
      return org;
    }
    await tx.insert(organization_memberships).values({
      organization_id: org.id,
      kilo_user_id: userId,
      role: 'owner',
    });
    return org;
  });

  return organization;
}

/**
 * When a user joins an organization through SSO or an invitation we should not
 * ask them how they heard about Kilo. Mark the customer-source survey as
 * dismissed by setting `customer_source` to an empty string, but only when they
 * have not already answered or dismissed it (`customer_source IS NULL`) so an
 * existing answer is never overwritten.
 */
export async function skipCustomerSourceSurveyForOrgJoin(
  userId: User['id'],
  txn?: DrizzleTransaction
): Promise<void> {
  await (txn || db)
    .update(kilocode_users)
    .set({ customer_source: '' })
    .where(and(eq(kilocode_users.id, userId), isNull(kilocode_users.customer_source)));
}

export async function addUserToOrganization(
  organizationId: Organization['id'],
  userId: User['id'],
  role: OrganizationRole,
  txn?: DrizzleTransaction
): Promise<boolean> {
  if (!txn) {
    return await db.transaction(async tx =>
      addUserToOrganization(organizationId, userId, role, tx)
    );
  }
  const result = await txn
    .insert(organization_memberships)
    .values({
      organization_id: organizationId,
      kilo_user_id: userId,
      role,
    })
    .onConflictDoNothing();

  const added = (result.rowCount ?? 0) > 0;
  // Only a real membership change affects group-policy evaluation. Bumping the
  // revision (and taking the org-wide policy advisory lock) on a no-op insert
  // would serialize every SSO re-login on one row. Skip both when nothing was
  // inserted.
  if (added) {
    await bumpOrganizationGroupPolicyRevision(txn, organizationId, userId);
  }
  return added;
}

export async function lockOrganizationMembershipMutation(
  tx: DrizzleTransaction,
  organizationId: Organization['id'],
  userId: User['id']
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId} || ':' || ${userId}, 0))`
  );
}

export async function addSsoUserToOrganization(
  organizationId: Organization['id'],
  userId: User['id'],
  options?: { isNewUser?: boolean; invitationToken?: string }
): Promise<boolean> {
  return db.transaction(async tx => {
    await lockOrganizationMembershipMutation(tx, organizationId, userId);
    const [removal] = await tx
      .select({ id: organization_membership_removals.id })
      .from(organization_membership_removals)
      .where(
        and(
          eq(organization_membership_removals.organization_id, organizationId),
          eq(organization_membership_removals.kilo_user_id, userId)
        )
      )
      .limit(1);

    if (removal) return false;

    if (options?.invitationToken) {
      const [invitation] = await tx
        .select({
          email: organization_invitations.email,
          userEmail: kilocode_users.google_user_email,
          normalizedUserEmail: kilocode_users.normalized_email,
        })
        .from(organization_invitations)
        .innerJoin(kilocode_users, eq(kilocode_users.id, userId))
        .where(
          and(
            eq(organization_invitations.organization_id, organizationId),
            eq(organization_invitations.token, options.invitationToken),
            eq(organization_invitations.authentication_requirement, 'workos'),
            eq(organization_invitations.sso_source_organization_id, organizationId),
            isNull(organization_invitations.accepted_at),
            gt(organization_invitations.expires_at, sql`NOW()`)
          )
        )
        .limit(1);
      if (
        invitation &&
        normalizeEmail(invitation.email) ===
          (invitation.normalizedUserEmail ?? normalizeEmail(invitation.userEmail))
      ) {
        return false;
      }
    }

    const membershipRule = await decideChildOrganizationMembership(tx, organizationId, { userId });
    if (membershipRule !== 'permitted') {
      warnExceptInTest(
        `SSO join refused by the child-organization membership rule (${membershipRule})`,
        { organizationId, userId }
      );
      return false;
    }

    const added = await addUserToOrganization(organizationId, userId, 'member', tx);

    // A brand-new account provisioned through SSO exists only because of the
    // organization, so it has no standalone personal account. Mirror the
    // invite-driven signup behavior (acceptOrganizationInvite) and disable it.
    // Existing users who authenticate through SSO keep their current value.
    if (added && options?.isNewUser) {
      await tx
        .update(kilocode_users)
        .set({ personal_account_disabled: true })
        .where(eq(kilocode_users.id, userId));
    }

    return added;
  });
}

export async function updateUserRoleInOrganization(
  organizationId: Organization['id'],
  userId: User['id'],
  role: OrganizationRole,
  txn?: DrizzleTransaction
): Promise<{ success: boolean; updated: 'membership' | 'invitation' | 'none' }> {
  const run = async (
    tx: DrizzleTransaction
  ): Promise<{ success: boolean; updated: 'membership' | 'invitation' | 'none' }> => {
    const membershipUpdateResult = await tx
      .update(organization_memberships)
      .set({ role })
      .where(
        and(
          eq(organization_memberships.organization_id, organizationId),
          eq(organization_memberships.kilo_user_id, userId)
        )
      );

    if (membershipUpdateResult.rowCount && membershipUpdateResult.rowCount > 0) {
      return successResult({ updated: 'membership' as const });
    }

    // If no membership was updated, check for pending invitations
    const [user] = await tx
      .select({
        email: kilocode_users.google_user_email,
        normalizedEmail: kilocode_users.normalized_email,
      })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, userId));

    if (!user) {
      return { success: false, updated: 'none' };
    }

    const pendingInvitations = await tx
      .select({ id: organization_invitations.id, email: organization_invitations.email })
      .from(organization_invitations)
      .where(
        and(
          eq(organization_invitations.organization_id, organizationId),
          isNull(organization_invitations.accepted_at),
          gt(organization_invitations.expires_at, sql`NOW()`)
        )
      );

    const invitationIds = pendingInvitations
      .filter(invitation => invitationAddressesAccount(invitation.email, user))
      .map(invitation => invitation.id);

    if (invitationIds.length === 0) {
      return { success: false, updated: 'none' };
    }

    const invitationUpdateResult = await tx
      .update(organization_invitations)
      .set({ role })
      .where(
        and(
          inArray(organization_invitations.id, invitationIds),
          isNull(organization_invitations.accepted_at),
          gt(organization_invitations.expires_at, sql`NOW()`)
        )
      );

    if (invitationUpdateResult.rowCount && invitationUpdateResult.rowCount > 0) {
      return successResult({ updated: 'invitation' as const });
    }

    return { success: false, updated: 'none' };
  };

  return txn ? run(txn) : db.transaction(run);
}

export const CHILD_ORGANIZATION_INVITE_REQUIRES_PARENT_MEMBER =
  'Child organizations can only invite people who are already members of the parent organization.';

export const CHILD_ORGANIZATION_ACCEPT_REQUIRES_PARENT_MEMBER =
  'Only parent organization members can join a child organization.';

/**
 * The one relation that decides which account an invitation address belongs to:
 * both addresses must have the same `normalizeEmail` form, so the dedupe,
 * existing-member check, role change and acceptance treat a `+` alias, Gmail
 * dots and casing as one person. The stored address itself keeps the spelling
 * the inviter typed.
 */
function isSameInvitationAddress(invitationEmail: string, address: string): boolean {
  return normalizeEmail(invitationEmail) === normalizeEmail(address);
}

/**
 * `isSameInvitationAddress` for a stored account row. A row's stored normalized
 * form is one more spelling of the same account, so an address change after
 * signup does not make an invitation unclaimable.
 */
function invitationAddressesAccount(
  invitationEmail: string,
  account: { email: string; normalizedEmail: string | null }
): boolean {
  return (
    isSameInvitationAddress(invitationEmail, account.email) ||
    account.normalizedEmail === normalizeEmail(invitationEmail)
  );
}

/**
 * The account-matching relation for member rows. The query returns the rows that
 * can match: the stored normalized form, a case variant of the address, and the
 * rows that carry no stored normalized form. The relation itself decides. Rows
 * without a stored normalized form are the only ones the database cannot narrow,
 * and they are the legacy ones.
 */
async function organizationMembersMatchingEmail(
  tx: DrizzleTransaction,
  organizationId: Organization['id'],
  email: string
) {
  const candidates = await tx
    .select({
      membershipId: organization_memberships.id,
      userId: kilocode_users.id,
      isBot: kilocode_users.is_bot,
      email: kilocode_users.google_user_email,
      normalizedEmail: kilocode_users.normalized_email,
    })
    .from(organization_memberships)
    .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        or(
          eq(kilocode_users.normalized_email, normalizeEmail(email)),
          isNull(kilocode_users.normalized_email),
          sql`lower(${kilocode_users.google_user_email}) = ${getDeliveredEmailAddress(email)}`
        )
      )
    );

  return candidates.filter(candidate => invitationAddressesAccount(email, candidate));
}

/**
 * The account that holds a live membership in the given parent organization and
 * belongs to the given address, or `null` when the parent organization is gone or
 * nobody there owns the address.
 */
async function parentOrganizationMemberIdForEmail(
  tx: DrizzleTransaction,
  parentOrganizationId: Organization['id'],
  email: string
): Promise<User['id'] | null> {
  const [parentOrganization] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.id, parentOrganizationId), isNull(organizations.deleted_at)))
    .limit(1);
  if (!parentOrganization) return null;

  const members = await organizationMembersMatchingEmail(tx, parentOrganization.id, email);
  const member = members.find(candidate => !candidate.isBot);
  if (!member) return null;

  // Re-read the row under a share lock: a membership removed between the read
  // above and this statement no longer counts as a parent member.
  const [lockedMembership] = await tx
    .select({ id: organization_memberships.id })
    .from(organization_memberships)
    .where(eq(organization_memberships.id, member.membershipId))
    .for('share');

  return lockedMembership ? member.userId : null;
}

/**
 * The identity a membership path can name: the account, or the address an
 * invitation names before that account exists.
 */
type MembershipSubject = { userId: User['id'] } | { email: string };

type ChildOrganizationMembershipDecision = 'permitted' | 'refused' | 'organization_missing';

/**
 * The module's child-organization membership rule, in one place: a child
 * organization admits only live, non-bot members of its live parent. Invite,
 * accept, and SSO provisioning all ask this before a membership row is created,
 * so the three paths cannot disagree about who may become a member.
 *
 * An account subject is asked under the membership lock the other membership
 * mutations take, so a removal that committed first leaves no member to find;
 * an address subject keeps the invitation path's organization row lock and its
 * share-lock read. None of the paths take a row lock on the parent relation, so
 * a membership follows the hierarchy in place when the path's transaction
 * started. A top-level target organization has no such requirement.
 */
async function decideChildOrganizationMembership(
  tx: DrizzleTransaction,
  organizationId: Organization['id'],
  subject: MembershipSubject
): Promise<ChildOrganizationMembershipDecision> {
  // The invitation path takes the target organization row lock. The account
  // paths deliberately take none: taking the row lock here would order this
  // read against neighbors that wait for the organization group-policy lock
  // first, and the membership lock below settles the account outcome against
  // removals.
  const parentRelation = tx
    .select({ parentOrganizationId: organizations.parent_organization_id })
    .from(organizations)
    .where(and(eq(organizations.id, organizationId), isNull(organizations.deleted_at)));
  const [organization] =
    'email' in subject ? await parentRelation.for('update') : await parentRelation;
  if (!organization) {
    return 'organization_missing';
  }
  const parentOrganizationId = organization.parentOrganizationId;
  if (!parentOrganizationId) {
    return 'permitted';
  }

  if ('email' in subject) {
    const parentMemberId = await parentOrganizationMemberIdForEmail(
      tx,
      parentOrganizationId,
      subject.email
    );
    return parentMemberId ? 'permitted' : 'refused';
  }

  await lockOrganizationMembershipMutation(tx, parentOrganizationId, subject.userId);
  const [parentMembership] = await tx
    .select({ id: organization_memberships.id })
    .from(organization_memberships)
    .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
    .innerJoin(
      organizations,
      and(
        eq(organizations.id, organization_memberships.organization_id),
        isNull(organizations.deleted_at)
      )
    )
    .where(
      and(
        eq(organization_memberships.organization_id, parentOrganizationId),
        eq(organization_memberships.kilo_user_id, subject.userId),
        eq(kilocode_users.is_bot, false)
      )
    )
    .limit(1);

  return parentMembership ? 'permitted' : 'refused';
}

export async function inviteUserToOrganization(
  organizationId: Organization['id'],
  invitingUserId: User['id'],
  email: string,
  role: OrganizationRole,
  txn?: DrizzleTransaction
): Promise<OrganizationInvitation> {
  const run = async (tx: DrizzleTransaction): Promise<OrganizationInvitation> => {
    const membershipRule = await decideChildOrganizationMembership(tx, organizationId, { email });
    if (membershipRule === 'organization_missing') {
      throw new Error('Organization SSO policy is misconfigured');
    }
    // A child org can invite only people who already belong to its live parent.
    if (membershipRule === 'refused') {
      throw new Error(CHILD_ORGANIZATION_INVITE_REQUIRES_PARENT_MEMBER);
    }

    const policy = await resolveEffectiveOrganizationSsoPolicy(organizationId, tx);
    if (policy.status === 'misconfigured') {
      throw new Error('Organization SSO policy is misconfigured');
    }

    let authenticationRequirement: 'default' | 'workos' = 'default';
    let ssoSourceOrganizationId: string | null = null;
    const emailDomain = getLowerDomainFromEmail(email);
    if (policy.status === 'required' && emailDomain === policy.domain) {
      authenticationRequirement = 'workos';
      ssoSourceOrganizationId = policy.sourceOrganizationId;
    }

    const pendingInvitations = await tx
      .select({ email: organization_invitations.email })
      .from(organization_invitations)
      .where(
        and(
          eq(organization_invitations.organization_id, organizationId),
          isNull(organization_invitations.accepted_at),
          gt(organization_invitations.expires_at, sql`NOW()`)
        )
      );

    if (pendingInvitations.some(invitation => isSameInvitationAddress(invitation.email, email))) {
      throw new Error('User already has a pending invitation');
    }

    const existingMembers = await organizationMembersMatchingEmail(tx, organizationId, email);

    if (existingMembers.length > 0) {
      throw new Error('User is already a member of this organization');
    }

    const [invitation] = await tx
      .insert(organization_invitations)
      .values({
        organization_id: organizationId,
        email,
        role,
        invited_by: invitingUserId,
        token: randomUUID(),
        expires_at: sql`NOW() + INTERVAL '7 days'`,
        authentication_requirement: authenticationRequirement,
        sso_source_organization_id: ssoSourceOrganizationId,
      })
      .returning();

    return invitation;
  };

  return txn ? run(txn) : db.transaction(run);
}

export async function getOrganizationMembers(
  organizationId: Organization['id']
): Promise<OrganizationMember[]> {
  const [activeMembers, pendingInvitations] = await Promise.all([
    db
      .select({
        id: organization_memberships.kilo_user_id,
        name: kilocode_users.google_user_name,
        email: kilocode_users.google_user_email,
        imageUrl: kilocode_users.google_user_image_url,
        role: organization_memberships.role,
        inviteDate: organization_memberships.created_at,
        dailyUsageLimitUsdMicrodollars: organization_user_limits.microdollar_limit,
        currentDailyUsageUsdMicrodollars: organization_user_usage.microdollar_usage,
      })
      .from(organization_memberships)
      .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
      .leftJoin(
        organization_user_limits,
        and(
          eq(organization_user_limits.organization_id, organizationId),
          eq(organization_user_limits.kilo_user_id, organization_memberships.kilo_user_id),
          eq(organization_user_limits.limit_type, 'daily')
        )
      )
      .leftJoin(
        organization_user_usage,
        and(
          eq(organization_user_usage.organization_id, organizationId),
          eq(organization_user_usage.kilo_user_id, organization_memberships.kilo_user_id),
          eq(organization_user_usage.limit_type, 'daily'),
          eq(organization_user_usage.usage_date, sql`CURRENT_DATE`)
        )
      )
      .where(
        and(
          eq(organization_memberships.organization_id, organizationId),
          eq(kilocode_users.is_bot, false)
        )
      ),
    db
      .select({
        id: organization_invitations.id,
        email: organization_invitations.email,
        role: organization_invitations.role,
        inviteDate: organization_invitations.created_at,
        token: organization_invitations.token,
        emailStatus: external_side_effect_outbox.status,
      })
      .from(organization_invitations)
      .leftJoin(
        external_side_effect_outbox,
        eq(external_side_effect_outbox.invitation_id, organization_invitations.id)
      )
      .where(
        and(
          eq(organization_invitations.organization_id, organizationId),
          isNull(organization_invitations.accepted_at),
          gt(organization_invitations.expires_at, sql`NOW()`)
        )
      ),
  ]);

  const members: OrganizationMember[] = [
    ...activeMembers.map(member => ({
      id: member.id,
      name: member.name,
      email: member.email,
      imageUrl: member.imageUrl,
      role: member.role,
      status: 'active' as const,
      inviteDate: member.inviteDate,
      dailyUsageLimitUsd:
        member.dailyUsageLimitUsdMicrodollars != null
          ? fromMicrodollars(member.dailyUsageLimitUsdMicrodollars)
          : null,
      currentDailyUsageUsd:
        member.currentDailyUsageUsdMicrodollars != null
          ? fromMicrodollars(member.currentDailyUsageUsdMicrodollars)
          : null,
    })),
    ...pendingInvitations.map(invitation => ({
      email: invitation.email,
      role: invitation.role,
      status: 'invited' as const,
      inviteDate: invitation.inviteDate,
      inviteToken: invitation.token,
      inviteId: invitation.id,
      inviteUrl: getAcceptInviteUrl(invitation.token),
      emailStatus: invitation.emailStatus,
      dailyUsageLimitUsd: null, // Invited members don't have limits yet
      currentDailyUsageUsd: null, // Invited members don't have usage yet
    })),
  ];

  return members;
}

export const ORGANIZATION_INVITATION_SSO_AUTHENTICATION_REQUIRED =
  'Invitation requires a current organization SSO session';

export type InvitationAuthenticationContext = {
  provider?: string;
  ssoSourceOrganizationId?: string;
};

async function revokeStaleOrganizationInvitation(
  tx: DrizzleTransaction,
  invitation: OrganizationInvitation,
  userId: User['id']
): Promise<boolean> {
  const [removal] = await tx
    .select({ removedAt: organization_membership_removals.removed_at })
    .from(organization_membership_removals)
    .where(
      and(
        eq(organization_membership_removals.organization_id, invitation.organization_id),
        eq(organization_membership_removals.kilo_user_id, userId)
      )
    )
    .limit(1);

  if (removal && new Date(invitation.created_at) <= new Date(removal.removedAt)) {
    await tx
      .update(organization_invitations)
      .set({ expires_at: sql`NOW()` })
      .where(eq(organization_invitations.id, invitation.id));
    await tx
      .update(external_side_effect_outbox)
      .set({
        status: 'failed',
        claimed_at: null,
        next_attempt_at: null,
        last_error: 'revoked',
      })
      .where(eq(external_side_effect_outbox.invitation_id, invitation.id));
    return true;
  }

  return false;
}

export async function acceptOrganizationInvite(
  userId: User['id'],
  inviteToken: string,
  authentication: InvitationAuthenticationContext = {}
): Promise<AcceptInviteResult> {
  try {
    let joinedDistinctId: string | null = null;
    const result = await db.transaction(async tx => {
      const [candidate] = await tx
        .select({ organizationId: organization_invitations.organization_id })
        .from(organization_invitations)
        .where(eq(organization_invitations.token, inviteToken))
        .limit(1);

      if (!candidate) {
        return failureResult('Invitation not found');
      }

      // Take the membership-mutation advisory lock, then the policy lock, before
      // the invitation and organization row locks. Member removal holds the
      // membership lock while deleting pending invitations, and SSO joins and
      // settings writes take the same advisory locks before row locks.
      await lockOrganizationMembershipMutation(tx, candidate.organizationId, userId);
      await lockOrganizationGroupPolicy(tx, candidate.organizationId);

      const [invitation] = await tx
        .select()
        .from(organization_invitations)
        .where(
          and(
            eq(organization_invitations.token, inviteToken),
            eq(organization_invitations.organization_id, candidate.organizationId)
          )
        )
        .for('update');

      if (!invitation) {
        return failureResult('Invitation not found');
      }

      const now = new Date();
      const expiresAt = new Date(invitation.expires_at);
      if (now > expiresAt) {
        return failureResult('Invitation has expired');
      }

      if (invitation.accepted_at) {
        return failureResult('Invitation has already been accepted');
      }

      const [acceptingUser] = await tx
        .select({
          email: kilocode_users.google_user_email,
          normalizedEmail: kilocode_users.normalized_email,
          createdAt: kilocode_users.created_at,
        })
        .from(kilocode_users)
        .where(eq(kilocode_users.id, userId))
        .limit(1);

      if (!acceptingUser) {
        return failureResult('User not found');
      }

      joinedDistinctId = acceptingUser.email;

      if (!invitationAddressesAccount(invitation.email, acceptingUser)) {
        return failureResult('Invitation is for a different email address');
      }

      const [organization] = await tx
        .select()
        .from(organizations)
        .where(
          and(eq(organizations.id, invitation.organization_id), isNull(organizations.deleted_at))
        )
        .for('update');
      if (!organization) {
        return failureResult('Organization not found');
      }
      // Joining a child org still requires a live parent membership, including
      // invitations created before the invitee left the parent.
      const membershipRule = await decideChildOrganizationMembership(tx, organization.id, {
        userId,
      });
      if (membershipRule !== 'permitted') {
        return failureResult(CHILD_ORGANIZATION_ACCEPT_REQUIRES_PARENT_MEMBER);
      }

      const ssoPolicy = await resolveEffectiveOrganizationSsoPolicy(organization.id, tx);
      if (ssoPolicy.status === 'misconfigured') {
        return failureResult('Organization SSO policy is misconfigured');
      }

      const acceptingUserDomain = getLowerDomainFromEmail(acceptingUser.email);
      if (invitation.authentication_requirement === 'workos') {
        if (
          ssoPolicy.status !== 'required' ||
          acceptingUserDomain !== ssoPolicy.domain ||
          invitation.sso_source_organization_id !== ssoPolicy.sourceOrganizationId
        ) {
          return failureResult('Invitation requires authentication through organization SSO');
        }
        if (
          authentication.provider !== 'workos' ||
          authentication.ssoSourceOrganizationId !== ssoPolicy.sourceOrganizationId
        ) {
          if (await revokeStaleOrganizationInvitation(tx, invitation, userId)) {
            return failureResult('Invitation is no longer valid');
          }
          return failureResult(ORGANIZATION_INVITATION_SSO_AUTHENTICATION_REQUIRED);
        }
      } else if (ssoPolicy.status === 'required' && acceptingUserDomain === ssoPolicy.domain) {
        return failureResult('Invitation requires authentication through organization SSO');
      }

      const existingMembership = await tx
        .select()
        .from(organization_memberships)
        .where(
          and(
            eq(organization_memberships.organization_id, invitation.organization_id),
            eq(organization_memberships.kilo_user_id, userId)
          )
        )
        .limit(1);

      if (existingMembership.length > 0) {
        // User is already a member, but we still mark the invitation as accepted
        // and return success to handle the duplicate membership gracefully
        const [updatedInvitation] = await tx
          .update(organization_invitations)
          .set({ accepted_at: sql`NOW()` })
          .where(eq(organization_invitations.token, inviteToken))
          .returning();

        return successResult({
          invitation: updatedInvitation,
          organizationId: invitation.organization_id,
          role: invitation.role,
          membershipInserted: false,
        });
      }

      // The invitation must be newer than the removal record to be accepted.
      if (await revokeStaleOrganizationInvitation(tx, invitation, userId)) {
        return failureResult('Invitation is no longer valid');
      }

      await tx.insert(organization_memberships).values({
        organization_id: invitation.organization_id,
        kilo_user_id: userId,
        role: invitation.role,
        invited_by: invitation.invited_by,
      });

      // A real membership insert changes group-policy evaluation, so advance the
      // same revision signal addUserToOrganization uses for the SSO path.
      await bumpOrganizationGroupPolicyRevision(tx, invitation.organization_id, userId);

      await skipCustomerSourceSurveyForOrgJoin(userId, tx);

      // If the invitation predates the account, the account was created after
      // (i.e. because of) a pending invite: this is a brand-new user joining an
      // organization via invite, so disable their personal account. Existing
      // users — whose account predates the invitation — keep their value.
      const accountCreatedForInvite =
        new Date(invitation.created_at).getTime() < new Date(acceptingUser.createdAt).getTime();
      if (accountCreatedForInvite) {
        await tx
          .update(kilocode_users)
          .set({ personal_account_disabled: true })
          .where(eq(kilocode_users.id, userId));
      }

      // Clear any previous removal record so the user isn't treated as "removed"
      // by subsequent webhook events (Subscription Lifecycle 2)
      await tx
        .delete(organization_membership_removals)
        .where(
          and(
            eq(organization_membership_removals.organization_id, invitation.organization_id),
            eq(organization_membership_removals.kilo_user_id, userId)
          )
        );

      const [updatedInvitation] = await tx
        .update(organization_invitations)
        .set({ accepted_at: sql`NOW()` })
        .where(eq(organization_invitations.token, inviteToken))
        .returning();

      await createAuditLog({
        action: 'organization.user.accept_invite',
        actor_email: invitation.email,
        actor_id: userId,
        actor_name: null,
        message: `${invitation.email} accepted an invitation`,
        organization_id: organization.id,
        tx,
      });

      logExceptInTest(`Invitation ${invitation.id} accepted by ${userId}`);
      return successResult({
        invitation: updatedInvitation,
        organizationId: invitation.organization_id,
        role: invitation.role,
        membershipInserted: true,
      });
    });

    if (result.success && result.membershipInserted) {
      if (joinedDistinctId) {
        captureOrganizationMemberJoined(joinedDistinctId, result.role);
      }
    }

    return result;
  } catch (error) {
    console.error('Error accepting organization invite:', error);
    return failureResult('An unexpected error occurred');
  }
}

export function getAcceptInviteUrl(inviteToken: OrganizationInvitation['token']): string {
  const acceptInviteUrl = `${APP_URL}/users/accept-invite/${inviteToken}`;
  return acceptInviteUrl;
}

export async function mutateOrganizationSettings(
  organizationId: Organization['id'],
  mutate: (organization: Organization) => Promise<OrganizationSettings> | OrganizationSettings,
  txn?: DrizzleTransaction
): Promise<OrganizationSettings> {
  const run = async (tx: DrizzleTransaction): Promise<OrganizationSettings> => {
    const [organization] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .for('update');
    if (!organization) {
      throw new Error(`Organization ${organizationId} not found`);
    }
    const nextSettings = await mutate(organization);
    // Returning the locked settings object is the explicit no-op signal.
    if (nextSettings === organization.settings) {
      return organization.settings;
    }
    const settings = OrganizationSettingsSchema.parse(nextSettings);
    await tx.update(organizations).set({ settings }).where(eq(organizations.id, organizationId));
    return settings;
  };

  return txn ? run(txn) : db.transaction(run);
}

export async function updateOrganizationSettings(
  organizationId: Organization['id'],
  settings: OrganizationSettings,
  txn?: DrizzleTransaction
): Promise<OrganizationSettings> {
  const validated = OrganizationSettingsSchema.parse(settings);
  await (txn || db)
    .update(organizations)
    .set({
      settings: validated,
    })
    .where(eq(organizations.id, organizationId));

  return validated;
}

// Atomically update the recommendations-digest flag inside the settings JSONB
// without a read-modify-write of the whole object, so a concurrent settings
// mutation can't clobber other fields. Persist false to distinguish an explicit
// opt-out from an organization that has never initialized this preference.
export async function setOrganizationRecommendationsDigestEnabled(
  organizationId: Organization['id'],
  enabled: boolean
): Promise<OrganizationSettings> {
  const [row] = await db
    .update(organizations)
    .set({
      settings: sql`jsonb_set(
        COALESCE(${organizations.settings}, '{}'::jsonb),
        '{recommendations_digest_enabled}',
        ${JSON.stringify(enabled)}::jsonb
      )`,
    })
    .where(eq(organizations.id, organizationId))
    .returning({ settings: organizations.settings });

  return row?.settings ?? {};
}

export async function markOrganizationAsDeleted(
  organizationId: Organization['id'],
  txn?: DrizzleTransaction
): Promise<Organization['id'][]> {
  const execute = async (tx: DrizzleTransaction): Promise<Organization['id'][]> => {
    const [organization] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .for('update');
    if (!organization) return [];

    const members = await tx
      .select({ id: organization_memberships.kilo_user_id })
      .from(organization_memberships)
      .where(eq(organization_memberships.organization_id, organizationId));

    await tx
      .update(cli_sessions_v2)
      .set({
        public_id: null,
        briefing_excerpt: null,
        briefing_excerpt_scope_changed_at: sql`now()`,
      })
      .where(eq(cli_sessions_v2.organization_id, organizationId));
    await tx
      .update(agent_briefing_context_preferences)
      .set({ enabled: false })
      .where(eq(agent_briefing_context_preferences.organization_id, organizationId));
    await tx
      .delete(provider_oauth_attempts)
      .where(eq(provider_oauth_attempts.owned_by_organization_id, organizationId));
    await tx
      .delete(cloud_agent_environments)
      .where(eq(cloud_agent_environments.owned_by_organization_id, organizationId));
    await tx
      .update(organizations)
      .set({ ...auto_deleted_at })
      .where(eq(organizations.id, organizationId));

    return members.map(member => member.id);
  };
  if (txn) return execute(txn);
  return db.transaction(execute);
}

export async function getOrganizationMemberByEmail(
  organizationId: Organization['id'],
  email: string
) {
  const result = await db
    .select()
    .from(organization_memberships)
    .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(kilocode_users.google_user_email, email)
      )
    )
    .limit(1);
  return result.length > 0 ? result[0] : null;
}
