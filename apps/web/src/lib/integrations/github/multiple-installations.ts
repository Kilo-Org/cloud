import 'server-only';

import { z } from 'zod';
import { getEnvVariable } from '@/lib/dotenvx';

export function parseMultipleGitHubInstallationOrganizationIds(value: string): Set<string> {
  return parseGitHubOrganizationIds(value, 'GITHUB_MULTIPLE_INSTALLATION_ORGANIZATION_IDS');
}

export function canOrganizationUseMultipleGitHubInstallations(organizationId: string): boolean {
  return parseMultipleGitHubInstallationOrganizationIds(
    getEnvVariable('GITHUB_MULTIPLE_INSTALLATION_ORGANIZATION_IDS')
  ).has(organizationId);
}

export function canOrganizationCreateSharedGitHubConnection(organizationId: string): boolean {
  return parseSharedGitHubInstallationOrganizationIds(
    getEnvVariable('GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS')
  ).has(organizationId);
}

export function isGitHubSharedInstallationAdmissionEnabled(): boolean {
  return (
    parseSharedGitHubInstallationOrganizationIds(
      getEnvVariable('GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS')
    ).size > 0
  );
}

export function parseSharedGitHubInstallationOrganizationIds(value: string): Set<string> {
  return parseGitHubOrganizationIds(value, 'GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS');
}

function parseGitHubOrganizationIds(value: string, variableName: string): Set<string> {
  const organizationIds = value
    .split(',')
    .map(organizationId => organizationId.trim())
    .filter(Boolean);

  const result = z.array(z.uuid()).safeParse(organizationIds);
  if (!result.success) {
    throw new Error(`${variableName} must be a comma-separated list of UUIDs`);
  }

  return new Set(result.data);
}

export function isGitHubConnectionManagementEnabled(): boolean {
  return getEnvVariable('GITHUB_CONNECTION_MANAGEMENT_ENABLED') === 'true';
}
