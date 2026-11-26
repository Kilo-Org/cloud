import type { Organization } from '@kilocode/db/schema';
import { organization_memberships, organizations } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import type { OrganizationRole } from '@kilocode/web-shared/lib/organizations/organization-types';
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import type { AnyPgColumn, SelectedFields } from 'drizzle-orm/pg-core';
import {
  activeOrganizationJoinCondition,
  inheritedParentMembershipJoinCondition,
  parentOrganizationJoinCondition,
  parentOrganizationsTable,
} from '@kilocode/worker-utils/organization-membership';

/** Matches the caller's organizations by id, used by {@link selectCallerRoleRows}. */
type OrganizationIdFilter = (column: AnyPgColumn) => SQL;

export const callerRoleFields = {
  role: organization_memberships.role,
  organizationId: organizations.id,
} as const;

const callerRoleWithOrganizationFields = {
  ...callerRoleFields,
  organization: organizations,
} as const;

export type CallerRoleRow = {
  role: OrganizationRole;
  organizationId: Organization['id'];
};

type CallerRoleRowWithOrganization = CallerRoleRow & { organization: Organization };

/**
 * The caller's membership roles in the organizations matched by
 * `organizationFilter`: a direct membership in a live organization, and the
 * roles inherited from a live parent organization. The inherited-access SQL
 * comes from one shared definition in
 * `@kilocode/worker-utils/organization-membership`, so the role check and the
 * organization fetch apply the same rule.
 *
 * {@link loadEffectiveMembershipRows} and
 * {@link loadEffectiveMembershipRowsWithOrganization} both read through this
 * selection; they differ only in the projection. The organization guards and
 * the admin audit's bypass check read memberships through them, so both see
 * the same roles.
 *
 * The selection is a compile-time argument: Drizzle cannot build its query
 * types from a generic selection, so the overloads declare the projection and
 * the implementation takes the selection loosely. The organization overload
 * comes first because a wider object is assignable to the narrower one.
 */
export async function selectCallerRoleRows(
  kiloUserId: string,
  organizationFilter: OrganizationIdFilter,
  fields: typeof callerRoleWithOrganizationFields,
  fromDb?: typeof db
): Promise<CallerRoleRowWithOrganization[]>;
export async function selectCallerRoleRows(
  kiloUserId: string,
  organizationFilter: OrganizationIdFilter,
  fields: typeof callerRoleFields,
  fromDb?: typeof db
): Promise<CallerRoleRow[]>;
export async function selectCallerRoleRows(
  kiloUserId: string,
  organizationFilter: OrganizationIdFilter,
  fields: SelectedFields,
  fromDb: typeof db = db
): Promise<unknown[]> {
  const [directRows, inheritedRows] = await Promise.all([
    fromDb
      .select(fields)
      .from(organization_memberships)
      .innerJoin(
        organizations,
        activeOrganizationJoinCondition(organization_memberships.organization_id)
      )
      .where(
        and(
          eq(organization_memberships.kilo_user_id, kiloUserId),
          organizationFilter(organization_memberships.organization_id)
        )
      ),
    fromDb
      .select(fields)
      .from(organizations)
      .innerJoin(parentOrganizationsTable, parentOrganizationJoinCondition())
      .innerJoin(
        organization_memberships,
        inheritedParentMembershipJoinCondition(organization_memberships, organizations, kiloUserId)
      )
      .where(and(organizationFilter(organizations.id), isNull(organizations.deleted_at))),
  ]);

  return [...directRows, ...inheritedRows];
}

export async function loadEffectiveMembershipRows(
  userId: string,
  organizationId: Organization['id'],
  fromDb: typeof db = db
): Promise<CallerRoleRow[]> {
  return selectCallerRoleRows(
    userId,
    column => eq(column, organizationId),
    callerRoleFields,
    fromDb
  );
}

export async function loadEffectiveMembershipRowsWithOrganization(
  userId: string,
  organizationId: Organization['id']
): Promise<CallerRoleRowWithOrganization[]> {
  return selectCallerRoleRows(
    userId,
    column => eq(column, organizationId),
    callerRoleWithOrganizationFields
  );
}
