import { createAppAuth } from '@octokit/auth-app';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';

type TokenCacheEntry = {
  token: string;
  expiresAt: number;
};

type GitHubAppCredentials = {
  appId: string;
  privateKey: string;
};

type GeneratedToken = {
  token: string;
  expiresAt: number;
};

/**
 * Type of GitHub App to use
 * - 'standard': Full-featured KiloConnect app with read/write permissions
 * - 'lite': Read-only KiloConnect-Lite app
 */
export type GitHubAppType = 'standard' | 'lite';

type GitHubTokenServiceEnv = {
  GITHUB_TOKEN_CACHE?: KVNamespace;
  // Standard app credentials
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  // Lite app credentials
  GITHUB_LITE_APP_ID?: string;
  GITHUB_LITE_APP_PRIVATE_KEY?: string;
};

const TokenCacheEntrySchema = z.object({
  token: z.string(),
  expiresAt: z.number(),
});

const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_KEY_PREFIX = 'gh-token:';
const MIN_TTL_SECONDS = 60;
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export class GitHubTokenService {
  constructor(private env: GitHubTokenServiceEnv) {}

  isConfigured(appType: GitHubAppType = 'standard'): boolean {
    if (appType === 'lite') {
      return Boolean(this.env.GITHUB_LITE_APP_ID && this.env.GITHUB_LITE_APP_PRIVATE_KEY);
    }
    return Boolean(this.env.GITHUB_APP_ID && this.env.GITHUB_APP_PRIVATE_KEY);
  }

  async getToken(installationId: string, appType: GitHubAppType = 'standard'): Promise<string> {
    const numericId = this.validateInstallationId(installationId);

    // Include app type in cache key to prevent mixing tokens from different apps
    const cacheKey = `${installationId}:${appType}`;
    const cached = await this.getCachedToken(cacheKey);
    if (cached) {
      return cached;
    }

    const credentials = this.getCredentials(appType);
    const { token, expiresAt } = await this.generateToken(numericId, credentials);
    await this.cacheToken(cacheKey, token, expiresAt);

    return token;
  }

  private getCredentials(appType: GitHubAppType): GitHubAppCredentials {
    if (appType === 'lite') {
      const appId = this.env.GITHUB_LITE_APP_ID;
      const privateKeyRaw = this.env.GITHUB_LITE_APP_PRIVATE_KEY;
      if (!appId || !privateKeyRaw) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'GitHub Lite App credentials not configured',
        });
      }
      return {
        appId,
        privateKey: privateKeyRaw.replace(/\\n/g, '\n'),
      };
    }

    const appId = this.env.GITHUB_APP_ID;
    const privateKeyRaw = this.env.GITHUB_APP_PRIVATE_KEY;
    if (!appId || !privateKeyRaw) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'GitHub App credentials not configured',
      });
    }

    return {
      appId,
      privateKey: privateKeyRaw.replace(/\\n/g, '\n'),
    };
  }

  private validateInstallationId(installationId: string): number {
    const numericId = Number(installationId);
    const isValid = Number.isInteger(numericId) && numericId > 0;
    if (!isValid) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Invalid GitHub installation ID: ${installationId}`,
      });
    }
    return numericId;
  }

  private async getCachedToken(cacheKey: string): Promise<string | null> {
    if (!this.env.GITHUB_TOKEN_CACHE) {
      return null;
    }

    const key = `${CACHE_KEY_PREFIX}${cacheKey}`;
    const cached = await this.env.GITHUB_TOKEN_CACHE.get(key, 'json');
    const parsed = TokenCacheEntrySchema.safeParse(cached);
    if (!parsed.success) {
      return null;
    }

    const entry = parsed.data;
    if (entry.expiresAt - Date.now() < EXPIRY_BUFFER_MS) {
      return null;
    }

    return entry.token;
  }

  private async generateToken(
    installationId: number,
    credentials: GitHubAppCredentials
  ): Promise<GeneratedToken> {
    try {
      const auth = createAppAuth({
        appId: credentials.appId,
        privateKey: credentials.privateKey,
        installationId,
      });

      const result = await auth({ type: 'installation' });
      return {
        token: result.token,
        expiresAt: new Date(result.expiresAt).getTime(),
      };
    } catch (error) {
      console.error('Failed to generate GitHub token:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new TRPCError({
        code: 'BAD_GATEWAY',
        message: `Failed to generate GitHub installation token: ${message}`,
        cause: error,
      });
    }
  }

  private async cacheToken(cacheKey: string, token: string, expiresAt: number): Promise<void> {
    if (!this.env.GITHUB_TOKEN_CACHE) {
      return;
    }

    const remainingSeconds = Math.floor((expiresAt - Date.now()) / 1000);
    if (remainingSeconds < MIN_TTL_SECONDS) {
      return;
    }

    const entry = { token, expiresAt } satisfies TokenCacheEntry;
    const maxTtlSeconds = Math.floor(CACHE_TTL_MS / 1000);
    const ttlSeconds = Math.min(maxTtlSeconds, remainingSeconds);
    const key = `${CACHE_KEY_PREFIX}${cacheKey}`;

    await this.env.GITHUB_TOKEN_CACHE.put(key, JSON.stringify(entry), {
      expirationTtl: ttlSeconds,
    });
  }
}
