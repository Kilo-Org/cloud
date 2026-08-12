import {
  kilo_pass_org_agreements,
  kilo_pass_org_allocation_plan_rows,
  kilo_pass_org_allocation_plans,
  kilo_pass_org_issuance_snapshots,
  kilocode_users,
  modelsByProvider,
  organization_group_policy_settings,
  organization_groups,
  organization_invitations,
  organization_memberships,
  organization_user_limits,
  organizations,
} from '@kilocode/db/schema';
import { TRPCError } from '@trpc/server';
import { captureException } from '@sentry/nextjs';
import { ORGANIZATION_MANAGE_ROLES } from '@kilocode/app-shared/organizations';
import { and, asc, count, desc, eq, gt, inArray, isNull, ne, or, sql, sum } from 'drizzle-orm';
import * as z from 'zod';

import { processOrganizationExpirationsBatch } from '@/lib/creditExpiration';
import { db } from '@/lib/drizzle';
import { resolveEffectiveOrganizationSsoPolicies } from '@/lib/organizations/organization-sso-policy';
import {
  OrganizationPlanSchema,
  OrganizationRoleSchema,
} from '@/lib/organizations/organization-types';
import {
  SubOrganizationModelPolicyOutputSchema,
  summarizeSubOrganizationModelPolicies,
} from '@/lib/organizations/sub-organizations/model-policy';
import { toMicrodollars } from '@/lib/utils';
import { createTRPCRouter } from '@/lib/trpc/init';
import { organizationBillingProcedure } from '@/routers/organizations/utils';

const SeatCountSchema = z.object({
  used: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

const SubOrganizationManagingRoleSchema = z.enum(['owner', 'admin', 'billing_manager']);

const RoleBreakdownSchema = z.object({
  owner: z.number().int().nonnegative(),
  admin: z.number().int().nonnegative(),
  billing_manager: z.number().int().nonnegative(),
  member: z.number().int().nonnegative(),
});

const PersonSchema = z.object({
  kiloUserId: z.string(),
  name: z.string(),
  email: z.email(),
});

const SubOrganizationOverviewOutputSchema = z.object({
  canCreateSubOrganizations: z.boolean(),
  children: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      plan: OrganizationPlanSchema,
      requireSeats: z.boolean(),
      memberCount: z.number().int().nonnegative(),
      pendingInvitationCount: z.number().int().nonnegative(),
      seatCount: SeatCountSchema,
      balanceMicrodollars: z.number(),
    })
  ),
});

const SubOrganizationPeopleOutputSchema = z.object({
  children: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      memberCount: z.number().int().nonnegative(),
      pendingInvitationCount: z.number().int().nonnegative(),
      seatCount: SeatCountSchema,
      roleBreakdown: RoleBreakdownSchema,
      owners: z.array(PersonSchema),
    })
  ),
  people: z.array(
    z.object({
      identityKey: z.string(),
      kiloUserId: z.string().nullable(),
      name: z.string(),
      email: z.email(),
      parentMembership: z
        .object({
          role: OrganizationRoleSchema,
          status: z.literal('accepted'),
        })
        .nullable(),
      memberships: z.array(
        z.object({
          organizationId: z.uuid(),
          organizationName: z.string(),
          role: OrganizationRoleSchema,
          status: z.literal('accepted'),
        })
      ),
      invitations: z.array(
        z.object({
          organizationId: z.uuid(),
          organizationName: z.string(),
          isParent: z.boolean(),
          role: OrganizationRoleSchema,
          status: z.literal('pending'),
        })
      ),
      statuses: z.array(z.enum(['accepted', 'pending'])),
    })
  ),
  pageInfo: z.object({
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    pageCount: z.number().int().nonnegative(),
  }),
});

const SubOrganizationPeopleInputSchema = z.object({
  search: z.string().trim().max(200).default(''),
  subOrganizationId: z.uuid().optional(),
  role: OrganizationRoleSchema.optional(),
  status: z.enum(['accepted', 'pending']).optional(),
  assignment: z.enum(['assigned', 'unassigned']).optional(),
  sortBy: z.enum(['identity', 'parentRole', 'membershipCount']).default('identity'),
  sortDirection: z.enum(['asc', 'desc']).default('asc'),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().min(10).max(50).default(25),
});

const PeopleIdentityRowSchema = z.object({
  identity_key: z.string(),
  kilo_user_id: z.string().nullable(),
  name: z.string(),
  email: z.email(),
  parent_role: OrganizationRoleSchema.nullable(),
  child_membership_count: z.coerce.number().int().nonnegative(),
  has_accepted: z.boolean(),
  has_pending: z.boolean(),
});

const PeopleCountRowSchema = z.object({ total: z.coerce.number().int().nonnegative() });

const KiloPassAllocationSchema = z
  .object({
    currentPassCount: z.number().int().nonnegative(),
    currentWindowStartsAt: z.iso.datetime().nullable(),
    currentWindowEndsAt: z.iso.datetime().nullable(),
    nextPassCount: z.number().int().nonnegative().nullable(),
    nextEffectiveAt: z.iso.datetime().nullable(),
    planVersion: z.number().int().positive().nullable(),
  })
  .nullable();

const SubOrganizationCreditsOutputSchema = z.object({
  kiloPassStatus: z.enum(['available', 'unavailable']),
  children: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      totalMicrodollarsAcquired: z.number(),
      microdollarsUsed: z.number(),
      balanceMicrodollars: z.number(),
      nextCreditExpirationAt: z.iso.datetime().nullable(),
      autoTopUpEnabled: z.boolean(),
      requireSeats: z.boolean(),
      seatCount: SeatCountSchema,
      minimumBalanceMicrodollars: z.number().nullable(),
      kiloPassAllocation: KiloPassAllocationSchema,
    })
  ),
});

const EffectiveSsoPolicySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_required'), organizationId: z.uuid() }),
  z.object({
    status: z.literal('required'),
    organizationId: z.uuid(),
    source: z.enum(['self', 'direct_parent']),
    sourceOrganizationId: z.uuid(),
    domain: z.string(),
  }),
  z.object({
    status: z.literal('misconfigured'),
    organizationId: z.uuid(),
    reason: z.enum([
      'organization_not_found',
      'deleted_parent',
      'conflicting_child_policy',
      'unsupported_nested_parent',
      'invalid_domain',
      'ambiguous_domain',
    ]),
  }),
]);

const SubOrganizationPermissionsOutputSchema = z.object({
  children: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      roleBreakdown: RoleBreakdownSchema,
      hasIndependentOwner: z.boolean(),
      ssoDomain: z.string().nullable(),
      companyDomain: z.string().nullable(),
      effectiveSsoPolicy: EffectiveSsoPolicySchema,
      featureSettings: z.object({
        enableUsageLimits: z.boolean().nullable(),
        codeIndexingEnabled: z.boolean().nullable(),
        projectsUiEnabled: z.boolean().nullable(),
        dataCollection: z.enum(['allow', 'deny']).nullable(),
      }),
      dailyUserLimits: z.array(
        PersonSchema.extend({
          role: OrganizationRoleSchema,
          limitMicrodollars: z.number().int().nonnegative(),
          enforcedForRole: z.boolean(),
          enforcedForSeatMode: z.boolean(),
        })
      ),
    })
  ),
  inheritedAccess: z.object({
    sourceOrganizationId: z.uuid(),
    appliesToOrganizationIds: z.array(z.uuid()),
    users: z.array(
      PersonSchema.extend({
        parentRole: SubOrganizationManagingRoleSchema,
        isBot: z.boolean(),
      })
    ),
  }),
});

type ChildSummaryRow = {
  id: string;
  name: string;
  requireSeats: boolean;
  seatTotal: number;
};

type RoleBreakdown = z.infer<typeof RoleBreakdownSchema>;

function emptyRoleBreakdown(): RoleBreakdown {
  return { owner: 0, admin: 0, billing_manager: 0, member: 0 };
}

async function getChildrenForSummary(organizationId: string): Promise<ChildSummaryRow[]> {
  return await db
    .select({
      id: organizations.id,
      name: organizations.name,
      requireSeats: organizations.require_seats,
      seatTotal: organizations.seat_count,
    })
    .from(organizations)
    .where(
      and(
        eq(organizations.parent_organization_id, organizationId),
        isNull(organizations.deleted_at)
      )
    )
    .orderBy(asc(organizations.name), asc(organizations.id));
}

const subOrganizationManagementProcedure = organizationBillingProcedure.use(
  async ({ input, next }) => {
    const [organization] = await db
      .select({
        parentOrganizationId: organizations.parent_organization_id,
        deletedAt: organizations.deleted_at,
      })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .limit(1);

    if (!organization || organization.deletedAt || organization.parentOrganizationId) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Parent organization not found' });
    }

    return next();
  }
);

async function getInvitationCounts(childIds: string[]) {
  if (childIds.length === 0) return [];
  return await db
    .select({
      organizationId: organization_invitations.organization_id,
      role: organization_invitations.role,
      count: count(),
    })
    .from(organization_invitations)
    .where(
      and(
        inArray(organization_invitations.organization_id, childIds),
        isNull(organization_invitations.accepted_at),
        gt(organization_invitations.expires_at, sql`NOW()`)
      )
    )
    .groupBy(organization_invitations.organization_id, organization_invitations.role);
}

function buildInvitationCountMaps(rows: Awaited<ReturnType<typeof getInvitationCounts>>) {
  const pending = new Map<string, number>();
  const seated = new Map<string, number>();
  for (const row of rows) {
    pending.set(row.organizationId, (pending.get(row.organizationId) ?? 0) + row.count);
    if (row.role !== 'billing_manager') {
      seated.set(row.organizationId, (seated.get(row.organizationId) ?? 0) + row.count);
    }
  }
  return { pending, seated };
}

async function getKiloPassCreditsState(parentOrganizationId: string, childIds: string[]) {
  try {
    const [agreement] = await db
      .select({ id: kilo_pass_org_agreements.id })
      .from(kilo_pass_org_agreements)
      .where(
        and(
          eq(kilo_pass_org_agreements.parent_organization_id, parentOrganizationId),
          ne(kilo_pass_org_agreements.state, 'ended')
        )
      )
      .limit(1);
    if (!agreement) {
      return { status: 'available' as const, currentRows: [], nextPlan: undefined, nextRows: [] };
    }

    const [currentRows, planRows] = await Promise.all([
      db
        .select({
          organizationId: kilo_pass_org_issuance_snapshots.allocation_container_organization_id,
          currentPassCount: sum(kilo_pass_org_issuance_snapshots.allocated_pass_capacity).mapWith(
            Number
          ),
          windowStartsAt: kilo_pass_org_issuance_snapshots.window_start,
          windowEndsAt: kilo_pass_org_issuance_snapshots.window_end,
        })
        .from(kilo_pass_org_issuance_snapshots)
        .where(
          and(
            eq(kilo_pass_org_issuance_snapshots.agreement_id, agreement.id),
            eq(
              kilo_pass_org_issuance_snapshots.window_start,
              db
                .select({
                  value: sql<string>`max(${kilo_pass_org_issuance_snapshots.window_start})`,
                })
                .from(kilo_pass_org_issuance_snapshots)
                .where(eq(kilo_pass_org_issuance_snapshots.agreement_id, agreement.id))
            )
          )
        )
        .groupBy(
          kilo_pass_org_issuance_snapshots.allocation_container_organization_id,
          kilo_pass_org_issuance_snapshots.window_start,
          kilo_pass_org_issuance_snapshots.window_end
        ),
      db
        .select({
          id: kilo_pass_org_allocation_plans.id,
          effectiveAt: kilo_pass_org_allocation_plans.effective_window_start,
          version: kilo_pass_org_allocation_plans.version,
        })
        .from(kilo_pass_org_allocation_plans)
        .where(eq(kilo_pass_org_allocation_plans.agreement_id, agreement.id))
        .orderBy(
          asc(kilo_pass_org_allocation_plans.effective_window_start),
          asc(kilo_pass_org_allocation_plans.version)
        ),
    ]);
    const currentWindowStartsAt = currentRows[0]?.windowStartsAt;
    const nextPlan = currentWindowStartsAt
      ? planRows.find(plan => new Date(plan.effectiveAt) > new Date(currentWindowStartsAt))
      : planRows[0];
    const nextRows = nextPlan
      ? await db
          .select({
            organizationId: kilo_pass_org_allocation_plan_rows.allocation_container_organization_id,
            passCount: kilo_pass_org_allocation_plan_rows.pass_capacity,
          })
          .from(kilo_pass_org_allocation_plan_rows)
          .where(
            and(
              eq(kilo_pass_org_allocation_plan_rows.allocation_plan_id, nextPlan.id),
              inArray(
                kilo_pass_org_allocation_plan_rows.allocation_container_organization_id,
                childIds
              )
            )
          )
      : [];

    return { status: 'available' as const, currentRows, nextPlan, nextRows };
  } catch (error) {
    captureException(error, {
      tags: { area: 'sub-organization-credits', dimension: 'kilo-pass' },
      extra: { parentOrganizationId },
    });
    return { status: 'unavailable' as const, currentRows: [], nextPlan: undefined, nextRows: [] };
  }
}

export const organizationSubOrganizationsRouter = createTRPCRouter({
  overview: subOrganizationManagementProcedure
    .output(SubOrganizationOverviewOutputSchema)
    .query(async ({ input, ctx }) => {
      const canCreateSubOrganizations =
        ctx.user.is_admin ||
        Boolean(
          (
            await db
              .select({ id: organization_memberships.id })
              .from(organization_memberships)
              .where(
                and(
                  eq(organization_memberships.organization_id, input.organizationId),
                  eq(organization_memberships.kilo_user_id, ctx.user.id),
                  inArray(organization_memberships.role, ORGANIZATION_MANAGE_ROLES)
                )
              )
              .limit(1)
          )[0]
        );
      const children = await db
        .select({
          id: organizations.id,
          name: organizations.name,
          plan: organizations.plan,
          requireSeats: organizations.require_seats,
          seatTotal: organizations.seat_count,
          totalMicrodollarsAcquired: organizations.total_microdollars_acquired,
          microdollarsUsed: organizations.microdollars_used,
          nextCreditExpirationAt: organizations.next_credit_expiration_at,
        })
        .from(organizations)
        .where(
          and(
            eq(organizations.parent_organization_id, input.organizationId),
            isNull(organizations.deleted_at)
          )
        )
        .orderBy(asc(organizations.name), asc(organizations.id));
      if (children.length === 0) return { canCreateSubOrganizations, children: [] };

      const childIds = children.map(child => child.id);
      const now = new Date();
      const dueChildren = children.filter(
        child => child.nextCreditExpirationAt && new Date(child.nextCreditExpirationAt) <= now
      );
      const [membershipCounts, invitationRows, expirationStates] = await Promise.all([
        db
          .select({
            organizationId: organization_memberships.organization_id,
            role: organization_memberships.role,
            count: count(),
          })
          .from(organization_memberships)
          .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
          .where(
            and(
              inArray(organization_memberships.organization_id, childIds),
              eq(kilocode_users.is_bot, false)
            )
          )
          .groupBy(organization_memberships.organization_id, organization_memberships.role),
        getInvitationCounts(childIds),
        processOrganizationExpirationsBatch(
          dueChildren.map(child => ({
            id: child.id,
            microdollars_used: child.microdollarsUsed,
            next_credit_expiration_at: child.nextCreditExpirationAt,
            total_microdollars_acquired: child.totalMicrodollarsAcquired,
          })),
          now
        ),
      ]);
      const memberCounts = new Map<string, number>();
      const seatedMemberCounts = new Map<string, number>();
      for (const row of membershipCounts) {
        memberCounts.set(
          row.organizationId,
          (memberCounts.get(row.organizationId) ?? 0) + row.count
        );
        if (row.role !== 'billing_manager') {
          seatedMemberCounts.set(
            row.organizationId,
            (seatedMemberCounts.get(row.organizationId) ?? 0) + row.count
          );
        }
      }
      const invitationCounts = buildInvitationCountMaps(invitationRows);

      return {
        canCreateSubOrganizations,
        children: children.map(child => {
          const acquired =
            expirationStates.get(child.id)?.total_microdollars_acquired ??
            child.totalMicrodollarsAcquired;
          const microdollarsUsed =
            expirationStates.get(child.id)?.microdollars_used ?? child.microdollarsUsed;
          return {
            id: child.id,
            name: child.name,
            plan: child.plan,
            requireSeats: child.requireSeats,
            memberCount: memberCounts.get(child.id) ?? 0,
            pendingInvitationCount: invitationCounts.pending.get(child.id) ?? 0,
            seatCount: {
              used:
                (seatedMemberCounts.get(child.id) ?? 0) +
                (invitationCounts.seated.get(child.id) ?? 0),
              total: child.seatTotal,
            },
            balanceMicrodollars: acquired - microdollarsUsed,
          };
        }),
      };
    }),

  people: subOrganizationManagementProcedure
    .input(SubOrganizationPeopleInputSchema)
    .output(SubOrganizationPeopleOutputSchema)
    .query(async ({ input }) => {
      const children = await getChildrenForSummary(input.organizationId);
      const childIds = children.map(child => child.id);
      const membershipOrganizationIds = [input.organizationId, ...childIds];
      const [membershipCounts, ownerRows, invitationRows] = await Promise.all([
        db
          .select({
            organizationId: organization_memberships.organization_id,
            role: organization_memberships.role,
            count: count(),
          })
          .from(organization_memberships)
          .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
          .where(
            and(
              inArray(organization_memberships.organization_id, childIds),
              eq(kilocode_users.is_bot, false)
            )
          )
          .groupBy(organization_memberships.organization_id, organization_memberships.role),
        childIds.length === 0
          ? Promise.resolve([])
          : db
              .select({
                organizationId: organization_memberships.organization_id,
                kiloUserId: kilocode_users.id,
                name: kilocode_users.google_user_name,
                email: kilocode_users.google_user_email,
              })
              .from(organization_memberships)
              .innerJoin(
                kilocode_users,
                eq(kilocode_users.id, organization_memberships.kilo_user_id)
              )
              .where(
                and(
                  inArray(organization_memberships.organization_id, childIds),
                  eq(organization_memberships.role, 'owner'),
                  eq(kilocode_users.is_bot, false)
                )
              ),
        getInvitationCounts(childIds),
      ]);
      const invitationCounts = buildInvitationCountMaps(invitationRows);
      const roleCountsByChild = new Map<string, RoleBreakdown>();
      for (const row of membershipCounts) {
        const breakdown = roleCountsByChild.get(row.organizationId) ?? emptyRoleBreakdown();
        breakdown[row.role] = row.count;
        roleCountsByChild.set(row.organizationId, breakdown);
      }
      const ownersByChild = Map.groupBy(ownerRows, owner => owner.organizationId);

      const eventFilters = [sql`TRUE`];
      const membershipEventFilters = [sql`TRUE`];
      if (input.search) {
        const search = `%${input.search}%`;
        eventFilters.push(sql`bool_or(name ILIKE ${search} OR email ILIKE ${search})`);
      }
      if (input.subOrganizationId) {
        if (!childIds.includes(input.subOrganizationId)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Selected organization must be a current sub-organization',
          });
        }
        membershipEventFilters.push(sql`organization_id = ${input.subOrganizationId}`);
      }
      if (input.role) membershipEventFilters.push(sql`role = ${input.role}`);
      if (input.status) membershipEventFilters.push(sql`status = ${input.status}`);
      if (membershipEventFilters.length > 1) {
        eventFilters.push(sql`bool_or(${sql.join(membershipEventFilters, sql` AND `)})`);
      }
      if (input.assignment === 'assigned') {
        eventFilters.push(
          sql`count(DISTINCT organization_id) FILTER (WHERE status = 'accepted' AND NOT is_parent) > 0`
        );
      } else if (input.assignment === 'unassigned') {
        eventFilters.push(
          sql`count(DISTINCT organization_id) FILTER (WHERE status = 'accepted' AND NOT is_parent) = 0`
        );
      }

      const peopleCte = sql`
        WITH scoped_organizations AS (
          SELECT id, name, id = ${input.organizationId} AS is_parent
          FROM organizations
          WHERE id = ${input.organizationId}
             OR (parent_organization_id = ${input.organizationId} AND deleted_at IS NULL)
        ), person_events AS (
          SELECT
            lower(users.google_user_email) AS identity_key,
            users.id AS kilo_user_id,
            users.google_user_name AS name,
            users.google_user_email AS email,
            memberships.organization_id,
            scoped.name AS organization_name,
            memberships.role,
            'accepted'::text AS status,
            scoped.is_parent
          FROM organization_memberships memberships
          INNER JOIN scoped_organizations scoped ON scoped.id = memberships.organization_id
          INNER JOIN kilocode_users users ON users.id = memberships.kilo_user_id
          WHERE users.is_bot = false

          UNION ALL

          SELECT
            lower(invitations.email) AS identity_key,
            NULL::text AS kilo_user_id,
            invitations.email AS name,
            invitations.email,
            invitations.organization_id,
            scoped.name AS organization_name,
            invitations.role,
            'pending'::text AS status,
            scoped.is_parent
          FROM organization_invitations invitations
          INNER JOIN scoped_organizations scoped ON scoped.id = invitations.organization_id
          WHERE invitations.accepted_at IS NULL AND invitations.expires_at > NOW()
        ), identities AS (
          SELECT
            identity_key,
            max(kilo_user_id) FILTER (WHERE kilo_user_id IS NOT NULL) AS kilo_user_id,
            coalesce(max(name) FILTER (WHERE status = 'accepted'), max(name)) AS name,
            coalesce(max(email) FILTER (WHERE status = 'accepted'), max(email)) AS email,
            max(role) FILTER (WHERE status = 'accepted' AND is_parent) AS parent_role,
            count(DISTINCT organization_id) FILTER (
              WHERE status = 'accepted' AND NOT is_parent
            )::int AS child_membership_count,
            bool_or(status = 'accepted') AS has_accepted,
            bool_or(status = 'pending') AS has_pending
          FROM person_events
          GROUP BY identity_key
          HAVING ${sql.join(eventFilters, sql` AND `)}
        )
      `;
      const sortExpression =
        input.sortBy === 'parentRole'
          ? sql`parent_role`
          : input.sortBy === 'membershipCount'
            ? sql`child_membership_count`
            : sql`lower(name)`;
      const sortDirection = input.sortDirection === 'desc' ? sql`DESC` : sql`ASC`;
      const offset = (input.page - 1) * input.pageSize;
      const [{ rows: countRows }, { rows: identityRows }] = await Promise.all([
        db.execute(sql`${peopleCte} SELECT count(*)::int AS total FROM identities`),
        db.execute(sql`${peopleCte}
          SELECT * FROM identities
          ORDER BY ${sortExpression} ${sortDirection} NULLS LAST, identity_key ASC
          LIMIT ${input.pageSize} OFFSET ${offset}
        `),
      ]);
      const total = PeopleCountRowSchema.parse(countRows[0] ?? { total: 0 }).total;
      const identities = z.array(PeopleIdentityRowSchema).parse(identityRows);
      const identityKeys = identities.map(identity => identity.identity_key);
      const [pageMemberships, pageInvitations] =
        identityKeys.length === 0
          ? [[], []]
          : await Promise.all([
              db
                .selectDistinct({
                  identityKey: sql<string>`lower(${kilocode_users.google_user_email})`,
                  organizationId: organization_memberships.organization_id,
                  role: organization_memberships.role,
                })
                .from(organization_memberships)
                .innerJoin(
                  kilocode_users,
                  eq(kilocode_users.id, organization_memberships.kilo_user_id)
                )
                .where(
                  and(
                    inArray(organization_memberships.organization_id, membershipOrganizationIds),
                    inArray(sql`lower(${kilocode_users.google_user_email})`, identityKeys),
                    eq(kilocode_users.is_bot, false)
                  )
                ),
              db
                .selectDistinct({
                  identityKey: sql<string>`lower(${organization_invitations.email})`,
                  organizationId: organization_invitations.organization_id,
                  role: organization_invitations.role,
                })
                .from(organization_invitations)
                .where(
                  and(
                    inArray(organization_invitations.organization_id, membershipOrganizationIds),
                    inArray(sql`lower(${organization_invitations.email})`, identityKeys),
                    isNull(organization_invitations.accepted_at),
                    gt(organization_invitations.expires_at, sql`NOW()`)
                  )
                ),
            ]);
      const organizationById = new Map([
        [input.organizationId, { name: 'Parent organization', isParent: true }],
        ...children.map(child => [child.id, { name: child.name, isParent: false }] as const),
      ]);
      const membershipsByIdentity = Map.groupBy(pageMemberships, row => row.identityKey);
      const invitationsByIdentity = Map.groupBy(pageInvitations, row => row.identityKey);

      return {
        children: children.map(child => {
          const roleBreakdown = roleCountsByChild.get(child.id) ?? emptyRoleBreakdown();
          const memberCount =
            roleBreakdown.owner +
            roleBreakdown.admin +
            roleBreakdown.billing_manager +
            roleBreakdown.member;
          return {
            id: child.id,
            name: child.name,
            memberCount,
            pendingInvitationCount: invitationCounts.pending.get(child.id) ?? 0,
            seatCount: {
              used:
                roleBreakdown.owner +
                roleBreakdown.admin +
                roleBreakdown.member +
                (invitationCounts.seated.get(child.id) ?? 0),
              total: child.seatTotal,
            },
            roleBreakdown,
            owners: (ownersByChild.get(child.id) ?? [])
              .map(({ kiloUserId, name, email }) => ({ kiloUserId, name, email }))
              .sort((left, right) => left.name.localeCompare(right.name)),
          };
        }),
        people: identities.map(identity => {
          const memberships = membershipsByIdentity.get(identity.identity_key) ?? [];
          const parentMembership = memberships.find(
            membership => membership.organizationId === input.organizationId
          );
          return {
            identityKey: identity.identity_key,
            kiloUserId: identity.kilo_user_id,
            name: identity.name,
            email: identity.email,
            parentMembership: parentMembership
              ? { role: parentMembership.role, status: 'accepted' as const }
              : null,
            memberships: memberships
              .filter(membership => membership.organizationId !== input.organizationId)
              .flatMap(membership => {
                const organization = organizationById.get(membership.organizationId);
                return organization
                  ? [
                      {
                        organizationId: membership.organizationId,
                        organizationName: organization.name,
                        role: membership.role,
                        status: 'accepted' as const,
                      },
                    ]
                  : [];
              })
              .sort((left, right) => left.organizationName.localeCompare(right.organizationName)),
            invitations: (invitationsByIdentity.get(identity.identity_key) ?? [])
              .flatMap(invitation => {
                const organization = organizationById.get(invitation.organizationId);
                return organization
                  ? [
                      {
                        organizationId: invitation.organizationId,
                        organizationName: organization.name,
                        isParent: organization.isParent,
                        role: invitation.role,
                        status: 'pending' as const,
                      },
                    ]
                  : [];
              })
              .sort((left, right) => left.organizationName.localeCompare(right.organizationName)),
            statuses: [
              ...(identity.has_accepted ? (['accepted'] as const) : []),
              ...(identity.has_pending ? (['pending'] as const) : []),
            ],
          };
        }),
        pageInfo: {
          page: input.page,
          pageSize: input.pageSize,
          total,
          pageCount: total === 0 ? 0 : Math.ceil(total / input.pageSize),
        },
      };
    }),

  credits: subOrganizationManagementProcedure
    .output(SubOrganizationCreditsOutputSchema)
    .query(async ({ input }) => {
      const children = await db
        .select({
          id: organizations.id,
          name: organizations.name,
          settings: organizations.settings,
          requireSeats: organizations.require_seats,
          seatTotal: organizations.seat_count,
          totalMicrodollarsAcquired: organizations.total_microdollars_acquired,
          microdollarsUsed: organizations.microdollars_used,
          nextCreditExpirationAt: organizations.next_credit_expiration_at,
          autoTopUpEnabled: organizations.auto_top_up_enabled,
        })
        .from(organizations)
        .where(
          and(
            eq(organizations.parent_organization_id, input.organizationId),
            isNull(organizations.deleted_at)
          )
        )
        .orderBy(asc(organizations.name), asc(organizations.id));
      if (children.length === 0) return { kiloPassStatus: 'available', children: [] };
      const childIds = children.map(child => child.id);
      const now = new Date();
      const dueChildren = children.filter(
        child => child.nextCreditExpirationAt && new Date(child.nextCreditExpirationAt) <= now
      );
      const [membershipCounts, invitationRows, expirationStates, kiloPassState] = await Promise.all(
        [
          db
            .select({ organizationId: organization_memberships.organization_id, count: count() })
            .from(organization_memberships)
            .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
            .where(
              and(
                inArray(organization_memberships.organization_id, childIds),
                ne(organization_memberships.role, 'billing_manager'),
                eq(kilocode_users.is_bot, false)
              )
            )
            .groupBy(organization_memberships.organization_id),
          getInvitationCounts(childIds),
          processOrganizationExpirationsBatch(
            dueChildren.map(child => ({
              id: child.id,
              microdollars_used: child.microdollarsUsed,
              next_credit_expiration_at: child.nextCreditExpirationAt,
              total_microdollars_acquired: child.totalMicrodollarsAcquired,
            })),
            now
          ),
          getKiloPassCreditsState(input.organizationId, childIds),
        ]
      );
      const memberCountByChild = new Map(
        membershipCounts.map(row => [row.organizationId, row.count])
      );
      const invitationCounts = buildInvitationCountMaps(invitationRows);
      const currentByChild = new Map(
        kiloPassState.currentRows.map(row => [row.organizationId, row])
      );
      const nextByChild = new Map(
        kiloPassState.nextRows.map(row => [row.organizationId, row.passCount])
      );

      return {
        kiloPassStatus: kiloPassState.status,
        children: children.map(child => {
          const expirationState = expirationStates.get(child.id);
          const acquired =
            expirationState?.total_microdollars_acquired ?? child.totalMicrodollarsAcquired;
          const microdollarsUsed = expirationState?.microdollars_used ?? child.microdollarsUsed;
          const nextCreditExpirationAt =
            expirationState !== undefined
              ? expirationState.next_credit_expiration_at
              : child.nextCreditExpirationAt;
          const current = currentByChild.get(child.id);
          const nextPassCount = nextByChild.get(child.id);
          return {
            id: child.id,
            name: child.name,
            totalMicrodollarsAcquired: acquired,
            microdollarsUsed,
            balanceMicrodollars: acquired - microdollarsUsed,
            nextCreditExpirationAt: nextCreditExpirationAt
              ? new Date(nextCreditExpirationAt).toISOString()
              : null,
            autoTopUpEnabled: child.autoTopUpEnabled,
            requireSeats: child.requireSeats,
            seatCount: {
              used:
                (memberCountByChild.get(child.id) ?? 0) +
                (invitationCounts.seated.get(child.id) ?? 0),
              total: child.seatTotal,
            },
            minimumBalanceMicrodollars:
              child.settings.minimum_balance == null
                ? null
                : toMicrodollars(child.settings.minimum_balance),
            kiloPassAllocation:
              current || nextPassCount !== undefined
                ? {
                    currentPassCount: current?.currentPassCount ?? 0,
                    currentWindowStartsAt: current
                      ? new Date(current.windowStartsAt).toISOString()
                      : null,
                    currentWindowEndsAt: current
                      ? new Date(current.windowEndsAt).toISOString()
                      : null,
                    nextPassCount: nextPassCount ?? null,
                    nextEffectiveAt: kiloPassState.nextPlan
                      ? new Date(kiloPassState.nextPlan.effectiveAt).toISOString()
                      : null,
                    planVersion: kiloPassState.nextPlan?.version ?? null,
                  }
                : null,
          };
        }),
      };
    }),

  modelPolicy: subOrganizationManagementProcedure
    .output(SubOrganizationModelPolicyOutputSchema)
    .query(async ({ input }) => {
      const organizationRows = await db
        .select()
        .from(organizations)
        .where(
          and(
            or(
              eq(organizations.id, input.organizationId),
              eq(organizations.parent_organization_id, input.organizationId)
            ),
            isNull(organizations.deleted_at)
          )
        );
      const parent = organizationRows.find(row => row.id === input.organizationId);
      if (!parent) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Parent organization not found' });
      }
      const children = organizationRows
        .filter(row => row.parent_organization_id === input.organizationId)
        .sort(
          (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
        );
      const organizationIds = [parent.id, ...children.map(child => child.id)];
      const [defaultPolicyRows, groupRows, catalogRows] = await Promise.all([
        db
          .select({
            organizationId: organization_group_policy_settings.organization_id,
            defaultPolicies: organization_group_policy_settings.default_policies,
            policyRevision: organization_group_policy_settings.policy_revision,
          })
          .from(organization_group_policy_settings)
          .where(inArray(organization_group_policy_settings.organization_id, organizationIds)),
        db
          .select({
            organizationId: organization_groups.organization_id,
            groupId: organization_groups.id,
            groupName: organization_groups.name,
            policies: organization_groups.policies,
          })
          .from(organization_groups)
          .where(inArray(organization_groups.organization_id, organizationIds)),
        db
          .select({ id: modelsByProvider.id, data: modelsByProvider.data })
          .from(modelsByProvider)
          .orderBy(desc(modelsByProvider.id))
          .limit(1),
      ]);
      return await summarizeSubOrganizationModelPolicies({
        parent,
        children,
        defaultPolicyRows,
        groupRows,
        catalogSnapshot: catalogRows[0] ?? null,
      });
    }),

  permissions: subOrganizationManagementProcedure
    .output(SubOrganizationPermissionsOutputSchema)
    .query(async ({ input }) => {
      const children = await db
        .select({
          id: organizations.id,
          name: organizations.name,
          requireSeats: organizations.require_seats,
          settings: organizations.settings,
          ssoDomain: organizations.sso_domain,
          companyDomain: organizations.company_domain,
        })
        .from(organizations)
        .where(
          and(
            eq(organizations.parent_organization_id, input.organizationId),
            isNull(organizations.deleted_at)
          )
        )
        .orderBy(asc(organizations.name), asc(organizations.id));
      const childIds = children.map(child => child.id);
      const membershipOrganizationIds = [input.organizationId, ...childIds];
      const [membershipRows, ssoPolicies] = await Promise.all([
        db
          .select({
            organizationId: organization_memberships.organization_id,
            kiloUserId: kilocode_users.id,
            name: kilocode_users.google_user_name,
            email: kilocode_users.google_user_email,
            isBot: kilocode_users.is_bot,
            role: organization_memberships.role,
            limitMicrodollars: organization_user_limits.microdollar_limit,
          })
          .from(organization_memberships)
          .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
          .leftJoin(
            organization_user_limits,
            and(
              eq(
                organization_user_limits.organization_id,
                organization_memberships.organization_id
              ),
              eq(organization_user_limits.kilo_user_id, organization_memberships.kilo_user_id),
              eq(organization_user_limits.limit_type, 'daily')
            )
          )
          .where(inArray(organization_memberships.organization_id, membershipOrganizationIds)),
        resolveEffectiveOrganizationSsoPolicies(childIds),
      ]);
      const rowsByOrganization = Map.groupBy(membershipRows, row => row.organizationId);
      const inheritedUsers = (rowsByOrganization.get(input.organizationId) ?? [])
        .flatMap(row => {
          const parentRole = SubOrganizationManagingRoleSchema.safeParse(row.role);
          return parentRole.success
            ? [
                {
                  kiloUserId: row.kiloUserId,
                  name: row.name,
                  email: row.email,
                  parentRole: parentRole.data,
                  isBot: row.isBot,
                },
              ]
            : [];
        })
        .sort(
          (left, right) =>
            left.name.localeCompare(right.name) || left.kiloUserId.localeCompare(right.kiloUserId)
        );

      return {
        children: children.map(child => {
          const rows = (rowsByOrganization.get(child.id) ?? []).filter(row => !row.isBot);
          const roleBreakdown = emptyRoleBreakdown();
          for (const row of rows) roleBreakdown[row.role]++;
          const effectiveSsoPolicy = ssoPolicies.get(child.id);
          if (!effectiveSsoPolicy) throw new Error(`SSO policy missing for ${child.id}`);
          return {
            id: child.id,
            name: child.name,
            roleBreakdown,
            hasIndependentOwner: roleBreakdown.owner > 0,
            ssoDomain: child.ssoDomain,
            companyDomain: child.companyDomain,
            effectiveSsoPolicy,
            featureSettings: {
              enableUsageLimits: child.settings.enable_usage_limits ?? null,
              codeIndexingEnabled: child.settings.code_indexing_enabled ?? null,
              projectsUiEnabled: child.settings.projects_ui_enabled ?? null,
              dataCollection: child.settings.data_collection ?? null,
            },
            dailyUserLimits: rows
              .filter(
                (row): row is typeof row & { limitMicrodollars: number } =>
                  row.limitMicrodollars !== null
              )
              .map(row => ({
                kiloUserId: row.kiloUserId,
                name: row.name,
                email: row.email,
                role: row.role,
                limitMicrodollars: row.limitMicrodollars,
                enforcedForRole: row.role !== 'billing_manager',
                enforcedForSeatMode: !child.requireSeats,
              }))
              .sort(
                (left, right) =>
                  left.name.localeCompare(right.name) ||
                  left.kiloUserId.localeCompare(right.kiloUserId)
              ),
          };
        }),
        inheritedAccess: {
          sourceOrganizationId: input.organizationId,
          appliesToOrganizationIds: childIds,
          users: inheritedUsers,
        },
      };
    }),
});
