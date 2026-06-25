export const ORGANIZATION_SLUG_MAX_LENGTH = 32;

export type OrganizationRouteIdentifierInput = {
  id: string;
  slug: string | null;
};

export function getOrganizationRouteIdentifier(
  organization: OrganizationRouteIdentifierInput
): string {
  return organization.slug ?? organization.id;
}
