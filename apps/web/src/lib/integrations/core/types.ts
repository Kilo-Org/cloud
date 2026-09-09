// Core types for the integrations system
import type { PlatformRepository } from '@kilocode/db/schema-types';

export type { IntegrationPermissions, PlatformRepository } from '@kilocode/db/schema-types';

export function requireNumericPlatformRepositories(
  repositories: PlatformRepository<number | string>[] | null
): PlatformRepository[] | null {
  if (!repositories) return null;
  if (
    !repositories.every(
      (repository): repository is PlatformRepository => typeof repository.id === 'number'
    )
  ) {
    throw new Error('Expected numeric platform repository IDs');
  }
  return repositories;
}

/**
 * Finds a cached repository's numeric ID by its "owner/repo" full name.
 * Comparison is case-insensitive: GitHub repo full names are effectively
 * case-insensitive, and callers get `fullName` from sources (stored review
 * rows, LLM-echoed tool arguments) that aren't guaranteed to match the
 * cached casing exactly.
 */
export function findRepositoryIdByFullName(
  repositories: PlatformRepository[] | null,
  fullName: string
): number | null {
  const match = repositories?.find(
    repository => repository.full_name.toLowerCase() === fullName.toLowerCase()
  );
  return match?.id ?? null;
}

/**
 * Represents ownership of an integration
 * Can be either a user or an organization
 */
export type Owner = { type: 'user'; id: string } | { type: 'org'; id: string };

export type WebhookEvent = {
  platform: string;
  type: string;
  action: string;
  installationId?: string;
  owner?: string;
  repo?: string;
  prNumber?: number;
  sha?: string;
  ref?: string;
  payload: Record<string, unknown>;
  headers: Record<string, string>;
};

/**
 * GitHub requester information
 */
export type GitHubRequester = {
  id: string;
  login: string;
};

export type InstallationToken = {
  token: string;
  expires_at: string | null;
};
/**
 * GitHub installation data from webhook payload
 */
export type GitHubInstallationData = {
  installation_id: string;
  account_id: string;
  account_login: string;
  repository_selection: string;
  permissions: Record<string, unknown>;
  events: string[];
  created_at: string;
};

/**
 * Kilo User requester information
 */

export type KiloRequester = {
  kilo_user_id: string;
  kilo_user_email: string;
  kilo_user_name: string;
  requested_at: string;
};

/**
 * Pending approval metadata structure
 */
export type PendingApprovalMetadata = {
  status: string;
  requester?: KiloRequester;
  github_requester?: GitHubRequester;
  github_request_id?: string;
};
