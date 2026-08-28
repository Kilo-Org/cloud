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

// Compatibility: retain the old web import path until all Owner imports migrate.
// Database helpers and exports stay here; the shared Owner has no database dependency.
export type { Owner } from '@kilocode/app-shared/code-review/repository-identity';

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
