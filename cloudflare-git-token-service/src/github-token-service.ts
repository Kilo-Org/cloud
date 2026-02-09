import { createAppAuth } from '@octokit/auth-app';
import * as z from 'zod';

type Token = z.infer<typeof Token>;
const Token = z.object({
  token: z.string(),
  expiresAt: z.number(),
});

type GitHubAppCredentials = {
  appId: string;
  privateKey: string;
};

/**
 * Type of GitHub App to use
 * - 'standard': Full-featured KiloConnect app with read/write permissions
 * - 'lite': Read-only KiloConnect-Lite app
 */
export type GitHubAppType = 'standard' | 'lite';

const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_KEY_PREFIX = 'gh-token:';
const MIN_TTL_SECONDS = 60;
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export class GitHubTokenService {
  constructor(private env: CloudflareEnv) {}

  isConfigured(appType: GitHubAppType = 'standard'): boolean {
    if (appType === 'lite') {
      return Boolean(this.env.GITHUB_LITE_APP_ID && this.env.GITHUB_LITE_APP_PRIVATE_KEY);
    }
    return Boolean(this.env.GITHUB_APP_ID && this.env.GITHUB_APP_PRIVATE_KEY);
  }

  /**
   * Get a token scoped to a specific repository.
   * @param installationId - GitHub App installation ID
   * @param repoName - Repository name (just the repo part, not owner/repo)
   * @param appType - 'standard' or 'lite'
   */
  async getTokenForRepo(
    installationId: string,
    repoName: string,
    appType: GitHubAppType = 'standard'
  ): Promise<string> {
    const numericId = this.validateInstallationId(installationId);

    // Include repo name in cache key to scope tokens per-repo
    const cacheKey = `${installationId}:${appType}:${repoName}`;
    const cached = await this.getCachedToken(cacheKey);
    if (cached) {
      return cached;
    }

    const credentials = this.getCredentials(appType);
    const { token, expiresAt } = await this.generateToken(numericId, credentials, [repoName]);
    await this.cacheToken(cacheKey, token, expiresAt);

    return token;
  }

  /**
   * Get a token for the entire installation (not scoped to a specific repo).
   * Use getTokenForRepo when you know the specific repository.
   */
  async getToken(installationId: string, appType: GitHubAppType = 'standard'): Promise<string> {
    const numericId = this.validateInstallationId(installationId);

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
        throw new Error('GitHub Lite App credentials not configured');
      }
      return {
        appId,
        privateKey: privateKeyRaw.replace(/\\n/g, '\n'),
      };
    }

    const appId = this.env.GITHUB_APP_ID;
    const privateKeyRaw = this.env.GITHUB_APP_PRIVATE_KEY;
    if (!appId || !privateKeyRaw) {
      throw new Error('GitHub App credentials not configured');
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
      throw new Error(`Invalid GitHub installation ID: ${installationId}`);
    }
    return numericId;
  }

  private async getCachedToken(cacheKey: string): Promise<string | null> {
    if (!this.env.TOKEN_CACHE) {
      return null;
    }

    const key = `${CACHE_KEY_PREFIX}${cacheKey}`;
    const cached = await this.env.TOKEN_CACHE.get(key, 'json');
    const parsed = Token.safeParse(cached);
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
    credentials: GitHubAppCredentials,
    repositoryNames?: string[]
  ): Promise<Token> {
    try {
      const auth = createAppAuth({
        appId: credentials.appId,
        privateKey: credentials.privateKey,
        installationId,
      });

      const result = await auth({
        type: 'installation',
        repositoryNames,
      });
      return {
        token: result.token,
        expiresAt: new Date(result.expiresAt).getTime(),
      };
    } catch (error) {
      console.error('Failed to generate GitHub token:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to generate GitHub installation token: ${message}`);
    }
  }

  private async cacheToken(cacheKey: string, token: string, expiresAt: number): Promise<void> {
    if (!this.env.TOKEN_CACHE) {
      return;
    }

    const remainingSeconds = Math.floor((expiresAt - Date.now()) / 1000);
    if (remainingSeconds < MIN_TTL_SECONDS) {
      return;
    }

    const entry = { token, expiresAt } satisfies Token;
    const maxTtlSeconds = Math.floor(CACHE_TTL_MS / 1000);
    const ttlSeconds = Math.min(maxTtlSeconds, remainingSeconds);
    const key = `${CACHE_KEY_PREFIX}${cacheKey}`;

    await this.env.TOKEN_CACHE.put(key, JSON.stringify(entry), {
      expirationTtl: ttlSeconds,
    });
  }
}
