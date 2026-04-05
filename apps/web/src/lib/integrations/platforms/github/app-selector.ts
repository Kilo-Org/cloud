import { getOrganizationById } from '@/lib/organizations/organizations';
import { getEnvVariable } from '@/lib/dotenvx';

/**
 * Type of GitHub App to use
 * - 'standard': Full-featured KiloConnect app with read/write permissions
 * - 'lite': Read-only KiloConnect-Lite app
 */
export type GitHubAppType = 'standard' | 'lite';

/**
 * Credentials for a GitHub App
 */
export type GitHubAppCredentials = {
  appId: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
  appName: string;
  webhookSecret: string;
};

/**
 * Determines which GitHub App to use based on organization settings.
 *
 * @param organizationId - The organization ID to check, or null for user-level integrations
 * @returns The app type to use ('standard' or 'lite')
 */
export async function getGitHubAppTypeForOrganization(
  organizationId: string | null
): Promise<GitHubAppType> {
  if (!organizationId) {
    return 'standard';
  }

  const organization = await getOrganizationById(organizationId);
  if (!organization) {
    return 'standard';
  }

  // Use the github_app_type from organization settings
  return organization.settings?.github_app_type ?? 'standard';
}

/**
 * Gets the credentials for the specified GitHub App type.
 *
 * @param appType - The type of app to get credentials for
 * @returns The credentials for the specified app type
 */
export function getGitHubAppCredentials(appType: GitHubAppType): GitHubAppCredentials {
  if (appType === 'lite') {
    return {
      appId: process.env.GITHUB_LITE_APP_ID || '',
      privateKey: getEnvVariable('GITHUB_LITE_APP_PRIVATE_KEY'),
      clientId: process.env.GITHUB_LITE_APP_CLIENT_ID || '',
      clientSecret: getEnvVariable('GITHUB_LITE_APP_CLIENT_SECRET'),
      appName: process.env.NEXT_PUBLIC_GITHUB_LITE_APP_NAME || 'KiloConnect-Lite',
      webhookSecret: getEnvVariable('GITHUB_LITE_APP_WEBHOOK_SECRET'),
    };
  }

  return {
    appId: process.env.GITHUB_APP_ID || '',
    privateKey: getEnvVariable('GITHUB_APP_PRIVATE_KEY'),
    clientId: process.env.GITHUB_APP_CLIENT_ID || '',
    clientSecret: getEnvVariable('GITHUB_APP_CLIENT_SECRET'),
    appName: process.env.NEXT_PUBLIC_GITHUB_APP_NAME || 'KiloConnect',
    webhookSecret: getEnvVariable('GITHUB_APP_WEBHOOK_SECRET'),
  };
}

/**
 * Gets the GitHub App name for the specified app type.
 * This is a lightweight function that only reads the app name without loading other credentials.
 *
 * @param appType - The type of app to get the name for
 * @returns The app name
 */
export function getGitHubAppName(appType: GitHubAppType): string {
  if (appType === 'lite') {
    return process.env.NEXT_PUBLIC_GITHUB_LITE_APP_NAME || 'KiloConnect-Lite';
  }
  return process.env.NEXT_PUBLIC_GITHUB_APP_NAME || 'KiloConnect';
}
