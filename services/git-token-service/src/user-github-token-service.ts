import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import { user_github_app_tokens } from '@kilocode/db/schema';
import { eq, and } from 'drizzle-orm';
import { Octokit } from '@octokit/rest';
import type { GitHubAppType } from './github-token-service';

function getOctokitStatus(e: unknown): number | undefined {
  if (e != null && typeof e === 'object' && 'status' in e) {
    const { status } = e as { status: unknown };
    if (typeof status === 'number') return status;
  }
  return undefined;
}

export type GetUserTokenInput = {
  kiloUserId: string;
  githubRepo: string;
  appType?: GitHubAppType;
};

export type GetUserTokenResult =
  | {
      ok: true;
      token: string;
      expiresAt: number;
      githubLogin: string;
      githubUserId: string;
      githubEmail: string | null;
    }
  | { ok: false; reason: 'not_connected' | 'expired' | 'revoked' | 'no_repo_access' };

const REPO_CACHE_TTL_SECONDS = 5 * 60;
const REPO_CACHE_KEY_PREFIX = 'gh-user-repo-access:';

export class UserGitHubTokenService {
  private db: WorkerDb | null = null;

  constructor(private env: CloudflareEnv) {}

  isConfigured(): boolean {
    return Boolean(this.env.HYPERDRIVE && this.env.USER_GH_APP_TOKEN_ENCRYPTION_KEY);
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

  async getUserTokenForRepo(input: GetUserTokenInput): Promise<GetUserTokenResult> {
    if (!this.isConfigured()) {
      return { ok: false, reason: 'not_connected' };
    }

    const appType = input.appType ?? 'standard';
    const db = this.getDb();

    // 1. Look up the user's token row
    const rows = await db
      .select()
      .from(user_github_app_tokens)
      .where(
        and(
          eq(user_github_app_tokens.kilo_user_id, input.kiloUserId),
          eq(user_github_app_tokens.github_app_type, appType)
        )
      )
      .limit(1);

    const row = rows[0];
    if (!row) {
      return { ok: false, reason: 'not_connected' };
    }

    if (row.revoked_at !== null) {
      return { ok: false, reason: 'revoked' };
    }

    if (
      row.access_token_expires_at !== null &&
      new Date(row.access_token_expires_at) <= new Date()
    ) {
      return { ok: false, reason: 'expired' };
    }

    // 2. Decrypt the access token
    const { decryptWithSymmetricKey } = await import('@kilocode/encryption');
    const token = decryptWithSymmetricKey(
      row.access_token_encrypted,
      this.env.USER_GH_APP_TOKEN_ENCRYPTION_KEY
    );

    // 3. Verify repo access
    const [owner, repo] = input.githubRepo.split('/');
    if (!owner || !repo) {
      return { ok: false, reason: 'no_repo_access' };
    }

    const cacheKey = `${REPO_CACHE_KEY_PREFIX}${input.kiloUserId}:${owner}:${repo}`;
    const cached = await this.getCachedRepoAccess(cacheKey);
    if (cached === false) {
      return { ok: false, reason: 'no_repo_access' };
    }
    if (cached === true) {
      // Access confirmed by cache — skip API call
    } else {
      const octokit = new Octokit({ auth: token });
      try {
        await octokit.rest.repos.get({ owner, repo });
        await this.cacheRepoAccess(cacheKey, true);
      } catch (error) {
        const status = getOctokitStatus(error);
        if (status === 404) {
          await this.cacheRepoAccess(cacheKey, false);
          return { ok: false, reason: 'no_repo_access' };
        }
        // On other errors, don't cache — retry next time
        console.error('GitHub repo access check failed:', { owner, repo, status });
        return { ok: false, reason: 'no_repo_access' };
      }
    }

    // 4. Return token + identity
    const expiresAt = row.access_token_expires_at
      ? new Date(row.access_token_expires_at).getTime()
      : Date.now() + 8 * 60 * 60 * 1000;

    // Best-effort fire-and-forget update of last_used_at
    try {
      await db
        .update(user_github_app_tokens)
        .set({ last_used_at: new Date().toISOString() })
        .where(eq(user_github_app_tokens.id, row.id));
    } catch {
      // Ignore update failures
    }

    return {
      ok: true,
      token,
      expiresAt,
      githubLogin: row.github_login,
      githubUserId: row.github_user_id,
      githubEmail: row.github_email ?? null,
    };
  }

  private async getCachedRepoAccess(cacheKey: string): Promise<boolean | null> {
    if (!this.env.TOKEN_CACHE) {
      return null;
    }
    const cached = await this.env.TOKEN_CACHE.get(cacheKey, 'json');
    if (cached === true || cached === false) {
      return cached;
    }
    return null;
  }

  private async cacheRepoAccess(cacheKey: string, allowed: boolean): Promise<void> {
    if (!this.env.TOKEN_CACHE) {
      return;
    }
    await this.env.TOKEN_CACHE.put(cacheKey, JSON.stringify(allowed), {
      expirationTtl: REPO_CACHE_TTL_SECONDS,
    });
  }
}
