import type { KiloOrganizationOption } from './kilo-api-client';

const hasOrganization = (
  organizations: KiloOrganizationOption[],
  organizationId: string
): boolean => organizations.some(organization => organization.id === organizationId);

export const getSelectableOrganizationId = ({
  organizations,
  selectedOrganizationId,
  storedOrganizationId,
}: {
  organizations: KiloOrganizationOption[];
  selectedOrganizationId: string;
  storedOrganizationId: string | null;
}): string => {
  if (selectedOrganizationId !== '' && hasOrganization(organizations, selectedOrganizationId)) {
    return selectedOrganizationId;
  }

  if (selectedOrganizationId !== '') {
    return '';
  }

  if (storedOrganizationId !== null && hasOrganization(organizations, storedOrganizationId)) {
    return storedOrganizationId;
  }

  return '';
};
