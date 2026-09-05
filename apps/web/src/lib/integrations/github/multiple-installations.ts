import 'server-only';

import { z } from 'zod';
import { getEnvVariable } from '@/lib/dotenvx';

export function parseMultipleGitHubInstallationOrganizationIds(value: string): Set<string> {
  const organizationIds = value
    .split(',')
    .map(organizationId => organizationId.trim())
    .filter(Boolean);

  const result = z.array(z.uuid()).safeParse(organizationIds);
  if (!result.success) {
    throw new Error(
      'GITHUB_MULTIPLE_INSTALLATION_ORGANIZATION_IDS must be a comma-separated list of UUIDs'
    );
  }

  return new Set(result.data);
}

export function canOrganizationUseMultipleGitHubInstallations(organizationId: string): boolean {
  return parseMultipleGitHubInstallationOrganizationIds(
    getEnvVariable('GITHUB_MULTIPLE_INSTALLATION_ORGANIZATION_IDS')
  ).has(organizationId);
}

export function isGitHubConnectionManagementEnabled(): boolean {
  return getEnvVariable('GITHUB_CONNECTION_MANAGEMENT_ENABLED') === 'true';
}
