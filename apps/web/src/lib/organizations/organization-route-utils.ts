export const ORGANIZATION_SLUG_MAX_LENGTH = 32;

export type OrganizationRouteIdentifierInput = {
  id: string;
  slug: string | null;
};

const UUID_ROUTE_IDENTIFIER_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG_ROUTE_IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function getOrganizationRouteIdentifier(
  organization: OrganizationRouteIdentifierInput
): string {
  return organization.slug ?? organization.id;
}

export function getOrganizationAppPath(
  organization: OrganizationRouteIdentifierInput,
  suffix = ''
): string {
  return getOrganizationAppPathForRouteIdentifier(
    getOrganizationRouteIdentifier(organization),
    suffix
  );
}

export function getOrganizationAppPathForRouteIdentifier(
  routeIdentifier: string,
  suffix = ''
): string {
  const normalizedSuffix = suffix ? (suffix.startsWith('/') ? suffix : `/${suffix}`) : '';
  return `/organizations/${encodeURIComponent(routeIdentifier)}${normalizedSuffix}`;
}

export function isUuidOrganizationRouteIdentifier(identifier: string): boolean {
  return UUID_ROUTE_IDENTIFIER_PATTERN.test(identifier);
}

export function isValidOrganizationRouteIdentifier(identifier: string): boolean {
  return (
    isUuidOrganizationRouteIdentifier(identifier) || SLUG_ROUTE_IDENTIFIER_PATTERN.test(identifier)
  );
}

export function isOrganizationRouteIdentifierMatch(
  organization: OrganizationRouteIdentifierInput,
  routeIdentifier: string
): boolean {
  return organization.id === routeIdentifier || organization.slug === routeIdentifier;
}

export function findOrganizationByRouteIdentifier<T extends OrganizationRouteIdentifierInput>(
  organizations: readonly T[],
  routeIdentifier: string | null | undefined
): T | null {
  if (!routeIdentifier) return null;
  return (
    organizations.find(org => isOrganizationRouteIdentifierMatch(org, routeIdentifier)) ?? null
  );
}
