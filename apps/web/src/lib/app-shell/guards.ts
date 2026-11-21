import 'server-only';
import { TRPCError } from '@trpc/server';
import { and, eq, isNull } from 'drizzle-orm';
import * as z from 'zod';
import type { Organization, User } from '@kilocode/db/schema';
import { organizations } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import type { OrganizationRole } from '@kilocode/web-shared/lib/organizations/organization-types';
import { ensureMemberOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';

/** One query-string value, matching how the device-auth page reads params. */
export function readSearchParam(
  search: Record<string, string | string[] | undefined>,
  key: string
): string | undefined {
  const value = search[key];
  return Array.isArray(value) ? value[0] : value;
}

export type AppShellOrganization = {
  organization: Organization;
  role: OrganizationRole;
};

/**
 * The organization facts a shell page renders, or null when the page must not
 * render: a malformed id, a missing or deleted organization, or a caller who is
 * not a member. Membership only — every action behind the page applies its own
 * role gate, exactly as it does on the full web page.
 */
export async function loadAppShellOrganization(
  user: User,
  organizationId: string
): Promise<AppShellOrganization | null> {
  if (!z.uuid().safeParse(organizationId).success) return null;

  const organization = await db.query.organizations.findFirst({
    where: and(eq(organizations.id, organizationId), isNull(organizations.deleted_at)),
  });
  if (!organization) return null;

  try {
    const role = await ensureMemberOrganizationAccess(user, organizationId);
    return { organization, role };
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'UNAUTHORIZED') return null;
    throw error;
  }
}
