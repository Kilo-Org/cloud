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
 * Whether a provider repository read must go back to the provider instead of
 * answering from the integration's cached snapshot.
 *
 * A snapshot is the answer for a non-force read even when it is empty: a
 * connected provider that reports no repositories is the connected-empty
 * state, and re-fetching on every read turns a provider hiccup into a load
 * error instead of that state. An integration that has never synced (no
 * repositories and no `repositories_synced_at`) still syncs here, as does an
 * explicit `forceRefresh` from the section's refresh affordance.
 *
 * When this returns `false`, `cachedRepositories` is a list (never `null`).
 */
export function shouldSyncProviderRepositories({
  forceRefresh,
  cachedRepositories,
  repositoriesSyncedAt,
}: {
  forceRefresh: boolean;
  cachedRepositories: PlatformRepository[] | null;
  repositoriesSyncedAt: string | null;
}): boolean {
  if (forceRefresh) return true;
  if (cachedRepositories === null) return true;
  return cachedRepositories.length === 0 && repositoriesSyncedAt === null;
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
