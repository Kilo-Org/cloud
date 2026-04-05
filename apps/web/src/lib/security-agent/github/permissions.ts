/**
 * Security Reviews - GitHub Permissions
 *
 * Check if a GitHub App installation has the required permissions
 * for security reviews (vulnerability_alerts).
 */

import type { PlatformIntegration } from '@kilocode/db/schema';

// Use the same env var as GitHubIntegrationDetails.tsx for consistency
const GITHUB_APP_NAME = process.env.NEXT_PUBLIC_GITHUB_APP_NAME || 'KiloConnect';

/**
 * Required permission for security reviews
 */
export const REQUIRED_PERMISSION = 'vulnerability_alerts';

/**
 * Check if an integration has the required permissions for security reviews
 */
export function hasSecurityReviewPermissions(integration: PlatformIntegration): boolean {
  const permissions = integration.permissions;

  if (!permissions) {
    return false;
  }

  return (
    permissions.vulnerability_alerts === 'read' || permissions.vulnerability_alerts === 'write'
  );
}

/**
 * Get the URL to re-authorize the GitHub App with additional permissions
 */
export function getReauthorizeUrl(platformInstallationId: string): string {
  return `https://github.com/apps/${GITHUB_APP_NAME}/installations/${platformInstallationId}`;
}

/**
 * Result type for permission check
 */
export type PermissionCheckResult =
  | { hasPermission: true }
  | {
      hasPermission: false;
      error: 'missing_permissions';
      message: string;
      requiredPermissions: string[];
      reauthorizeUrl: string;
    };

/**
 * Check permissions and return a structured result
 */
export function checkSecurityReviewPermissions(
  integration: PlatformIntegration
): PermissionCheckResult {
  if (hasSecurityReviewPermissions(integration)) {
    return { hasPermission: true };
  }

  const installationId = integration.platform_installation_id;
  if (!installationId) {
    return {
      hasPermission: false,
      error: 'missing_permissions',
      message: 'Security Reviews requires a valid GitHub App installation.',
      requiredPermissions: [REQUIRED_PERMISSION],
      reauthorizeUrl: `https://github.com/apps/${GITHUB_APP_NAME}`,
    };
  }

  return {
    hasPermission: false,
    error: 'missing_permissions',
    message: 'Security Reviews requires additional GitHub permissions.',
    requiredPermissions: [REQUIRED_PERMISSION],
    reauthorizeUrl: getReauthorizeUrl(installationId),
  };
}
