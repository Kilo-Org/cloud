import 'server-only';

import { cache } from 'react';
import { organizations } from '@kilocode/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import {
  getOrganizationRouteIdentifier,
  isUuidOrganizationRouteIdentifier,
  type OrganizationRouteIdentifierInput,
} from '@/lib/organizations/organization-route-utils';

export type ResolvedOrganizationRouteIdentifier = OrganizationRouteIdentifierInput & {
  routeIdentifier: string;
};

async function resolveOrganizationRouteIdentifierDetailsUncached(
  identifier: string
): Promise<ResolvedOrganizationRouteIdentifier | null> {
  const [organization] = await db
    .select({ id: organizations.id, slug: organizations.slug })
    .from(organizations)
    .where(
      and(
        isUuidOrganizationRouteIdentifier(identifier)
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

export const resolveOrganizationRouteIdentifierDetails = cache(
  resolveOrganizationRouteIdentifierDetailsUncached
);

export async function resolveOrganizationRouteIdentifier(
  identifier: string
): Promise<string | null> {
  const organization = await resolveOrganizationRouteIdentifierDetails(identifier);
  return organization?.id ?? null;
}

export async function resolveOrganizationRouteParams(
  params: Promise<{ id: string }>
): Promise<string | null> {
  const { id } = await params;
  return resolveOrganizationRouteIdentifier(decodeURIComponent(id));
}
