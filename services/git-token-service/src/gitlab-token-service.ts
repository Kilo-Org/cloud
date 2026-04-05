import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import { platform_integrations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import type { GitLabIntegrationMetadata } from './gitlab-lookup-service.js';

const GitLabOAuthTokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  token_type: z.string(),
  expires_in: z.number(),
  created_at: z.number(),
  scope: z.string(),
});

type GitLabOAuthTokenResponse = z.infer<typeof GitLabOAuthTokenResponseSchema>;

export type GitLabTokenSuccess = {
  success: true;
  token: string;
  instanceUrl: string;
};

export type GitLabTokenFailure = {
  success: false;
  reason: 'no_token' | 'token_refresh_failed' | 'token_expired_no_refresh';
};

export type GitLabTokenResult = GitLabTokenSuccess | GitLabTokenFailure;

function isTokenExpired(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) return true;
  const expiryTime = new Date(expiresAt).getTime();
  const bufferMs = 5 * 60 * 1000;
  return Date.now() >= expiryTime - bufferMs;
}

function calculateTokenExpiry(createdAt: number, expiresIn: number): string {
  const expiresAtMs = (createdAt + expiresIn) * 1000;
  return new Date(expiresAtMs).toISOString();
}

export class GitLabTokenService {
  private db: WorkerDb | null = null;

  constructor(private env: CloudflareEnv) {}

  async getToken(
    integrationId: string,
    metadata: GitLabIntegrationMetadata
  ): Promise<GitLabTokenResult> {
    const instanceUrl = metadata.gitlab_instance_url || 'https://gitlab.com';

    if (!metadata.access_token) {
      return { success: false, reason: 'no_token' };
    }

    if (metadata.auth_type === 'pat') {
      return { success: true, token: metadata.access_token, instanceUrl };
    }

    if (metadata.token_expires_at && isTokenExpired(metadata.token_expires_at)) {
      if (!metadata.refresh_token) {
        return { success: false, reason: 'token_expired_no_refresh' };
      }

      const clientId = metadata.client_id || this.env.GITLAB_CLIENT_ID;
      const clientSecret = metadata.client_secret || this.env.GITLAB_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        console.error('GitLab OAuth credentials not configured');
        return { success: false, reason: 'token_refresh_failed' };
      }

      const refreshResult = await this.refreshToken(
        metadata.refresh_token,
        instanceUrl,
        clientId,
        clientSecret
      );

      if (!refreshResult) {
        return { success: false, reason: 'token_refresh_failed' };
      }

      await this.updateIntegrationMetadata(integrationId, metadata, refreshResult);

      return { success: true, token: refreshResult.access_token, instanceUrl };
    }

    return { success: true, token: metadata.access_token, instanceUrl };
  }

  private async refreshToken(
    refreshToken: string,
    instanceUrl: string,
    clientId: string,
    clientSecret: string
  ): Promise<GitLabOAuthTokenResponse | null> {
    try {
      const response = await fetch(`${instanceUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('GitLab OAuth token refresh failed:', { status: response.status, error });
        return null;
      }

      const parsed = GitLabOAuthTokenResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        console.error('Unexpected GitLab token response shape:', parsed.error);
        return null;
      }
      return parsed.data;
    } catch (error) {
      console.error('GitLab OAuth token refresh error:', error);
      return null;
    }
  }

  private async updateIntegrationMetadata(
    integrationId: string,
    existingMetadata: GitLabIntegrationMetadata,
    tokens: GitLabOAuthTokenResponse
  ): Promise<void> {
    const db = this.getDb();
    const newExpiresAt = calculateTokenExpiry(tokens.created_at, tokens.expires_in);

    await db
      .update(platform_integrations)
      .set({
        metadata: {
          ...existingMetadata,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_expires_at: newExpiresAt,
        },
        updated_at: new Date().toISOString(),
      })
      .where(eq(platform_integrations.id, integrationId));
  }

  private getDb(): WorkerDb {
    if (!this.db) {
      if (!this.env.HYPERDRIVE) {
        throw new Error('Hyperdrive not configured');
      }
      this.db = getWorkerDb(this.env.HYPERDRIVE.connectionString, { statement_timeout: 10_000 });
    }
    return this.db;
  }
}
