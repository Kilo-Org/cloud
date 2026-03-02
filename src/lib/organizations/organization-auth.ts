import 'server-only';
import { getUserFromAuth } from '@/lib/user.server';
import type { Organization, User } from '@kilocode/db/schema';
import { organization_memberships, organizations } from '@kilocode/db/schema';
import { NextResponse } from 'next/server';
import type { OrganizationRole } from '@/lib/organizations/organization-types';
import { db } from '@/lib/drizzle';
import { eq, inArray, and, isNull } from 'drizzle-orm';
import { sentryLogger } from '@/lib/utils.server';
import type { CustomResult } from '@/lib/maybe-result';
import { successResult } from '@/lib/maybe-result';
import { getOrganizationById } from '@/lib/organizations/organizations';
import z from 'zod';

const warnInSentry = sentryLogger('org_auth', 'warning');

type UserWithRole = User & {
  readonly role: OrganizationRole;
};
const UUIDSchema = z.uuid();
type DataOrNextError<T> = CustomResult<
  { data: T; nextResponse?: never },
  { data?: never; nextResponse: NextResponse<{ error: string }> }
>;

export async function getAuthorizedOrgContext(
  id: Organization['id'],
  roles?: OrganizationRole[],
  // this is used only in testing because mocking getUserFromAuth doesn't work with jest
  // due to the way next module loading works
  getUserFromAuthOverride?: typeof getUserFromAuth
): Promise<DataOrNextError<{ user: UserWithRole; organization: Organization }>> {
  // Only use the override function in test environment
  const getUserFromAuthFn =
    process.env.NODE_ENV === 'test' && getUserFromAuthOverride
      ? getUserFromAuthOverride
      : getUserFromAuth;

  const { authFailedResponse, user } = await getUserFromAuthFn({ adminOnly: false });
  if (authFailedResponse) {
    return { success: false, nextResponse: authFailedResponse };
  }
  const { success, data, error } = UUIDSchema.safeParse(id);
  if (!success) {
    return {
      success: false,
      nextResponse: NextResponse.json({ error: error?.message || 'Invalid data' }, { status: 400 }),
    };
  }
  const organizationId = data;

  // admin user allowed to edit everything
  if (user.is_admin) {
    const organization = await getOrganizationById(organizationId);
    if (!organization) {
      const res = NextResponse.json({ error: 'Organization not found' }, { status: 404 });
      return { success: false, nextResponse: res };
    }
    return successResult({
      data: {
        user: { ...user, role: 'owner' },
        organization,
      },
    });
  }
  // if roles are provided, check if the user has one of those roles
  const rows = await db
    .select({
      role: organization_memberships.role,
      organization: organizations,
    })
    .from(organization_memberships)
    .innerJoin(organizations, eq(organizations.id, organization_memberships.organization_id))
    .where(
      and(
        eq(organization_memberships.kilo_user_id, user.id),
        eq(organization_memberships.organization_id, organizationId),
        isNull(organizations.deleted_at),
        roles && roles.length > 0 ? inArray(organization_memberships.role, roles) : undefined
      )
    );

  if (!rows.length) {
    warnInSentry(
      `User ${user.id} attempted to access organization ${organizationId} without sufficient permissions`
    );
    const res = NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    return { success: false, nextResponse: res };
  }
  const role = rows[0].role;
  const organization = rows[0].organization;
  return successResult({
    data: {
      user: { ...user, role },
      organization,
    },
  });
}
