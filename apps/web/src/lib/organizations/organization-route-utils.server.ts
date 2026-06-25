import 'server-only';

import { organizations } from '@kilocode/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import {
  getOrganizationRouteIdentifier,
  type OrganizationRouteIdentifierInput,
} from '@/lib/organizations/organization-route-utils';

export type ResolvedOrganizationRouteIdentifier = OrganizationRouteIdentifierInput & {
  routeIdentifier: string;
};

const UUID_ROUTE_IDENTIFIER_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function resolveOrganizationRouteIdentifierDetails(
  identifier: string
): Promise<ResolvedOrganizationRouteIdentifier | null> {
  const [organization] = await db
    .select({ id: organizations.id, slug: organizations.slug })
    .from(organizations)
    .where(
      and(
        UUID_ROUTE_IDENTIFIER_PATTERN.test(identifier)
          ? eq(organizations.id, identifier)
          : eq(organizations.slug, identifier),
        isNull(organizations.deleted_at)
      )
    )
    .limit(1);

  if (!organization) {
    return null;
  }

  return {
    ...organization,
    routeIdentifier: getOrganizationRouteIdentifier(organization),
  };
}

export async function resolveOrganizationRouteIdentifier(
  identifier: string
): Promise<string | null> {
  const organization = await resolveOrganizationRouteIdentifierDetails(identifier);
  return organization?.id ?? null;
}
