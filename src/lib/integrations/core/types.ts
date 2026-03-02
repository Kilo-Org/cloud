// Core types for the integrations system
export type { IntegrationPermissions, PlatformRepository } from '@kilocode/db/schema-types';

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
};
