import { PERSONAL_SECURITY_SCOPE } from '@kilocode/app-shared/security-agent';
import { type Href } from 'expo-router';

type ProfileOrganization = { organizationId: string };

export function getProfileAgentScope(
  selectedOrganizationId: string | null,
  organizations: readonly ProfileOrganization[] | undefined,
  organizationsRefreshing = false
): string | undefined {
  if (!selectedOrganizationId) {
    return PERSONAL_SECURITY_SCOPE;
  }
  if (!organizations || organizationsRefreshing) {
    return undefined;
  }
  return organizations.some(org => org.organizationId === selectedOrganizationId)
    ? selectedOrganizationId
    : PERSONAL_SECURITY_SCOPE;
}

export function getCodeReviewerProfilePath(scope: string): Href {
  return `/(app)/(tabs)/(3_profile)/code-reviewer/${scope}` as Href;
}
