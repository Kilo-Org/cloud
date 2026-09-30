import type { PlatformIntegration } from '@kilocode/db/schema';
import type {
  GitHubInstallationData,
  PendingApprovalMetadata,
} from '@/lib/integrations/core/types';

/**
 * Helper functions for GitHub webhook processing
 */

/**
 * Extract pending approval metadata from a platform integration record
 */
export function extractPendingApprovalMetadata(
  integration: PlatformIntegration
): PendingApprovalMetadata | null {
  const metadata = integration.metadata as Record<string, unknown> | null;
  const pendingApproval = metadata?.pending_approval as PendingApprovalMetadata | undefined;
  return pendingApproval || null;
}

/**
 * Build installation data object from GitHub webhook payload
 */
export function buildInstallationData(installation: {
  id: number;
  account: {
    id: number;
    login: string;
  };
  repository_selection: string;
  permissions: Record<string, unknown>;
  events?: string[];
  created_at: string;
}): GitHubInstallationData {
  return {
    installation_id: installation.id.toString(),
    account_id: installation.account.id.toString(),
    account_login: installation.account.login,
    repository_selection: installation.repository_selection,
    permissions: installation.permissions,
    events: installation.events || [],
    created_at: installation.created_at,
  };
}
