import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
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

export type GitHubRepositoryInstallationResult =
  | { status: 'installed'; installationId: string }
  | { status: 'not_installed' }
  | { status: 'temporarily_unavailable' };

const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_KEY_PREFIX = 'gh-token:';
const MIN_TTL_SECONDS = 60;
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const INSTALLATION_LOGIN_REFRESH_CACHE_KEY_PREFIX = 'gh-installation-login-refresh:v1:';
const INSTALLATION_LOGIN_REFRESH_TTL_SECONDS = 15 * 60;
const REPOSITORY_INSTALLATION_LOOKUP_TIMEOUT_MS = 10_000;
const REPOSITORY_INSTALLATION_MAX_RESPONSE_BYTES = 64_000;

const GitHubRepositoryInstallationSchema = z.object({
  id: z.number().int().positive().safe(),
});

const GitHubInstallationAccountSchema = z.object({
  account: z.object({
    login: z.string().min(1),
  }),
});

class GitHubTokenGenerationError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message);
    this.name = 'GitHubTokenGenerationError';
  }
}

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

  async findRepositoryInstallation(
    githubRepo: string,
    appType: GitHubAppType = 'standard'
  ): Promise<GitHubRepositoryInstallationResult> {
    const [owner, repoName] = githubRepo.split('/');
    if (!owner || !repoName) return { status: 'temporarily_unavailable' };

    const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/installation`;
    const signal = AbortSignal.timeout(REPOSITORY_INSTALLATION_LOOKUP_TIMEOUT_MS);
    try {
      const credentials = this.getCredentials(appType);
      const auth = createAppAuth({
        appId: credentials.appId,
        privateKey: credentials.privateKey,
      });
      const { token } = await auth({ type: 'app' });
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'Kilo-Git-Token-Service',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        redirect: 'manual',
        signal,
      });
      if (
        (response.status >= 300 && response.status < 400) ||
        response.redirected ||
        (response.url !== '' && response.url !== endpoint)
      ) {
        await this.cancelResponse(response);
        return { status: 'temporarily_unavailable' };
      }
      if (response.status === 404) {
        await this.cancelResponse(response);
        return { status: 'not_installed' };
      }
      if (response.status !== 200 || !this.isBoundedJsonResponse(response)) {
        await this.cancelResponse(response);
        return { status: 'temporarily_unavailable' };
      }

      const payload = await this.readBoundedJson(response, signal);
      const installation = GitHubRepositoryInstallationSchema.safeParse(payload);
      if (!installation.success) return { status: 'temporarily_unavailable' };
      return {
        status: 'installed',
        installationId: String(installation.data.id),
      };
    } catch {
      return { status: 'temporarily_unavailable' };
    }
  }

  async refreshInstallationAccountLoginIfDue(
    installationId: string,
    appType: GitHubAppType = 'standard'
  ): Promise<string | null> {
    const cooldownKey = `${INSTALLATION_LOGIN_REFRESH_CACHE_KEY_PREFIX}${appType}:${installationId}`;
    if (this.env.TOKEN_CACHE) {
      const cooldownMarker = await this.env.TOKEN_CACHE.get(cooldownKey);
      if (cooldownMarker !== null) {
        return null;
      }
      // Cool down failed attempts too, so repeated lookup misses cannot hammer GitHub.
      await this.env.TOKEN_CACHE.put(cooldownKey, new Date().toISOString(), {
        expirationTtl: INSTALLATION_LOGIN_REFRESH_TTL_SECONDS,
      });
    }

    try {
      const numericId = this.validateInstallationId(installationId);
      const credentials = this.getCredentials(appType);
      const auth = createAppAuth({
        appId: credentials.appId,
        privateKey: credentials.privateKey,
      });
      const { token } = await auth({ type: 'app' });
      const octokit = new Octokit({ auth: token });
      const { data } = await octokit.apps.getInstallation({ installation_id: numericId });
      const parsed = GitHubInstallationAccountSchema.safeParse(data);
      if (!parsed.success) {
        console.warn(
          JSON.stringify({
            message: 'Invalid GitHub installation account metadata response',
            appType,
          })
        );
        return null;
      }

      return parsed.data.account.login;
    } catch (error) {
      console.warn(
        JSON.stringify({
          message: 'Failed to refresh GitHub installation account login',
          errorType: error instanceof Error ? error.name : 'UnknownError',
          appType,
        })
      );
      return null;
    }
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

  private getProviderStatus(error: unknown): number | null {
    if (typeof error !== 'object' || error === null || !('status' in error)) return null;
    return typeof error.status === 'number' ? error.status : null;
  }

  private isBoundedJsonResponse(response: Response): boolean {
    const contentType = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') return false;

    const contentLength = response.headers.get('Content-Length');
    return (
      contentLength === null ||
      (/^[0-9]+$/.test(contentLength) &&
        Number(contentLength) <= REPOSITORY_INSTALLATION_MAX_RESPONSE_BYTES)
    );
  }

  private async readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
    if (!response.body) throw new Error('Invalid GitHub response');

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const value: unknown = chunk.value;
        if (!(value instanceof Uint8Array)) throw new Error('Invalid GitHub response');
        totalBytes += value.byteLength;
        if (totalBytes > REPOSITORY_INSTALLATION_MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new Error('GitHub response too large');
        }
        chunks.push(value);
      }
    } catch {
      throw new Error(signal.aborted ? 'GitHub request timed out' : 'Invalid GitHub response');
    } finally {
      reader.releaseLock();
    }

    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body));
  }

  private async cancelResponse(response: Response): Promise<void> {
    await response.body?.cancel().catch(() => undefined);
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
      console.error(
        JSON.stringify({
          message: 'Failed to generate GitHub installation token',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        })
      );
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new GitHubTokenGenerationError(
        `Failed to generate GitHub installation token: ${message}`,
        this.getProviderStatus(error)
      );
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
