/**
 * App Builder DB Proxy Client
 *
 * Communicates with the App Builder DB Proxy API (Cloudflare worker) for managing
 * database credentials for user app databases.
 */

import { APP_BUILDER_DB_PROXY_URL, APP_BUILDER_DB_PROXY_AUTH_TOKEN } from '@/lib/config.server';

// Import shared schemas from cloudflare-db-proxy
import {
  CredentialsResponseSchema,
  type CredentialsResponse,
} from '../../../cloudflare-db-proxy/src/api-schemas';

// Re-export types for consumers
export type { CredentialsResponse };

// Error type for API errors
class AppBuilderDbProxyError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public endpoint?: string
  ) {
    super(message);
    this.name = 'AppBuilderDbProxyError';
  }
}

export { AppBuilderDbProxyError };

function getBaseUrl(): string {
  const url = APP_BUILDER_DB_PROXY_URL;
  if (!url) {
    throw new AppBuilderDbProxyError(
      'APP_BUILDER_DB_PROXY_URL environment variable is not configured'
    );
  }
  return url.replace(/\/$/, ''); // Remove trailing slash if present
}

/**
 * Get database credentials for an app.
 *
 * @param appId - The unique identifier for the app
 * @returns Object containing appId, dbUrl, dbToken, and provisioned status
 * @throws AppBuilderDbProxyError if the request fails
 */
export async function getCredentials(appId: string): Promise<CredentialsResponse> {
  const baseUrl = getBaseUrl();
  const endpoint = `${baseUrl}/admin/apps/${encodeURIComponent(appId)}/credentials`;

  const response = await fetch(endpoint, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(APP_BUILDER_DB_PROXY_AUTH_TOKEN && {
        Authorization: `Bearer ${APP_BUILDER_DB_PROXY_AUTH_TOKEN}`,
      }),
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new AppBuilderDbProxyError(
      `Failed to get credentials for app ${appId}: ${response.status} ${response.statusText} - ${errorText}`,
      response.status,
      endpoint
    );
  }

  const data = await response.json();
  const parsed = CredentialsResponseSchema.parse(data);

  return parsed;
}
