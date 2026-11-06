import { getWorkerDb } from '@kilocode/db/client';
import { user_github_app_tokens } from '@kilocode/db/schema';
import {
  GitHubIdentityConflictError,
  isExpiredProvidedToken,
  lockGitHubIdentity,
  lockGitHubGrant,
  type GitHubIdentityPrecondition,
} from '@kilocode/db/github-identity';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { readBoundedJsonBody } from './lib/bounded-read.js';
import {
  GitHubAppCredentialLifecycle,
  CredentialSelectionError,
  type AuthorizationRow,
} from './github-app-credential-lifecycle.js';

export type GitAuthorConfig = {
  name: string;
  email: string;
};

export type ManagedGitHubFallbackReason =
  | 'no_user_authorization'
  | 'revoked'
  | 'refresh_failed'
  | 'insufficient_user_access'
  | 'credential_unreadable'
  | 'credential_configuration_error';

export type UserAuthorizationSelection =
  | { selected: true; token: string; gitAuthor: GitAuthorConfig }
  | { selected: false; reason: ManagedGitHubFallbackReason };

export type GitHubUserAccessTokenOp =
  | { op: 'fetch' }
  | { op: 'rotate'; staleAuthorizationId: string; staleCredentialVersion: number }
  | { op: 'reportRejected'; authorizationId: string; credentialVersion: number };

export type GitHubUserAccessTokenResult =
  | {
      connected: true;
      token: string;
      expiresAtEpochMs: number | null;
      credentialSource: 'github_app' | 'provided_token';
      refreshSupported: boolean;
      githubLogin: string;
      authorizationId: string;
      credentialVersion: number;
    }
  | { connected: false; reason: 'not_connected' | 'revoked' };

export type GitHubUserAccessTokenTransientReason = 'temporarily_unavailable';

const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const GITHUB_USER_AUTHORIZATION_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';
const RepositoryAccessSchema = z.object({ permissions: z.object({ push: z.boolean() }) });

export class GitHubUserAuthorizationService extends GitHubAppCredentialLifecycle {
  async selectUserAuthorization(params: {
    userId: string;
    githubRepo: string;
    strictRepositoryLookup?: boolean;
  }): Promise<UserAuthorizationSelection> {
    if (!this.env.HYPERDRIVE) {
      return { selected: false, reason: 'refresh_failed' };
    }
    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString, { statement_timeout: 10_000 });
    let [authorization] = await db
      .select()
      .from(user_github_app_tokens)
      .where(
        and(
          eq(user_github_app_tokens.kilo_user_id, params.userId),
          eq(user_github_app_tokens.github_app_type, 'standard')
        )
      )
      .limit(1);
    if (!authorization) return { selected: false, reason: 'no_user_authorization' };
    if (
      authorization.revoked_at ||
      isExpiredProvidedToken(authorization.credential_source, authorization.access_token_expires_at)
    ) {
      return { selected: false, reason: 'revoked' };
    }

    try {
      if (
        authorization.credential_source === 'github_app' &&
        new Date(authorization.access_token_expires_at ?? 0).getTime() - Date.now() <
          EXPIRY_BUFFER_MS
      ) {
        const refreshResult = await this.refreshAuthorizationWithLock(db, authorization);
        if (refreshResult === 'terminal_rejection') {
          await this.revokeCurrentGeneration(db, authorization, 'github_token_rejected');
          return { selected: false, reason: 'revoked' };
        }
        if (refreshResult === 'transient_failure') {
          return { selected: false, reason: 'refresh_failed' };
        }
        const [reloaded] = await db
          .select()
          .from(user_github_app_tokens)
          .where(eq(user_github_app_tokens.id, authorization.id))
          .limit(1);
        if (!reloaded || reloaded.revoked_at) {
          return { selected: false, reason: 'no_user_authorization' };
        }
        authorization = reloaded;
      }

      const token = this.decryptCredential(authorization, 'access');
      const repoParts = params.githubRepo.split('/');
      // Same base override the PR-review client honors (apps/web), so a dev
      // stub serving api.github.com is probed through the stub instead of
      // rejecting the stub token against real GitHub and revoking the row. An
      // empty override counts as unset — `.dev.vars.example` ships
      // `GITHUB_API_BASE_URL=`, and `??` would keep it, making the probe target
      // a relative URL.
      const apiBaseUrl = (
        this.env.GITHUB_API_BASE_URL?.trim() || DEFAULT_GITHUB_API_BASE_URL
      ).replace(/\/+$/, '');
      const endpoint = `${apiBaseUrl}/repos/${encodeURIComponent(repoParts[0])}/${encodeURIComponent(repoParts[1])}`;
      let response: Response;
      try {
        response = await fetch(endpoint, {
          ...(params.strictRepositoryLookup
            ? {
                redirect: 'manual' as const,
                signal: AbortSignal.timeout(GITHUB_USER_AUTHORIZATION_REQUEST_TIMEOUT_MS),
              }
            : {}),
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'User-Agent': 'Kilo-Git-Token-Service',
          },
        });
      } catch {
        return { selected: false, reason: 'insufficient_user_access' };
      }
      if (response.status === 401) {
        await this.revokeCurrentGeneration(db, authorization, 'github_token_rejected');
        if (params.strictRepositoryLookup) {
          await response.body?.cancel().catch(() => undefined);
        }
        return { selected: false, reason: 'revoked' };
      }
      if (params.strictRepositoryLookup && response.status !== 200) {
        try {
          await response.body?.cancel();
        } catch {
          return { selected: false, reason: 'insufficient_user_access' };
        }
        return { selected: false, reason: 'insufficient_user_access' };
      }
      if (!response.ok) return { selected: false, reason: 'insufficient_user_access' };

      const repositoryAccess = RepositoryAccessSchema.safeParse(
        params.strictRepositoryLookup
          ? response.body && (await readBoundedJsonBody(response.body, 64 * 1024))
          : await response.json()
      );
      if (!repositoryAccess.success || !repositoryAccess.data.permissions.push) {
        return { selected: false, reason: 'insufficient_user_access' };
      }

      await db
        .update(user_github_app_tokens)
        .set({ last_used_at: new Date().toISOString() })
        .where(eq(user_github_app_tokens.id, authorization.id));
      return {
        selected: true,
        token,
        gitAuthor: {
          name: authorization.github_login,
          email: `${authorization.github_user_id}+${authorization.github_login}@users.noreply.github.com`,
        },
      };
    } catch (error) {
      if (error instanceof CredentialSelectionError) {
        return { selected: false, reason: error.reason };
      }
      throw error;
    }
  }

  async getUserAccessToken(
    kiloUserId: string,
    op: GitHubUserAccessTokenOp
  ): Promise<GitHubUserAccessTokenResult> {
    const db = this.getDatabase();
    const [authorization] = await db
      .select()
      .from(user_github_app_tokens)
      .where(
        and(
          eq(user_github_app_tokens.kilo_user_id, kiloUserId),
          eq(user_github_app_tokens.github_app_type, 'standard')
        )
      )
      .limit(1);
    if (!authorization) return { connected: false, reason: 'not_connected' };
    if (
      authorization.revoked_at ||
      isExpiredProvidedToken(authorization.credential_source, authorization.access_token_expires_at)
    ) {
      return { connected: false, reason: 'revoked' };
    }

    if (op.op === 'reportRejected') {
      if (
        authorization.id !== op.authorizationId ||
        authorization.credential_version !== op.credentialVersion
      ) {
        return this.toConnectedResult(authorization);
      }
      await this.revokeCurrentGeneration(db, authorization, 'github_token_rejected');
      return { connected: false, reason: 'revoked' };
    }

    let forceRefresh = false;
    if (op.op === 'rotate') {
      if (
        authorization.id !== op.staleAuthorizationId ||
        authorization.credential_version !== op.staleCredentialVersion
      ) {
        return this.toConnectedResult(authorization);
      }
      if (authorization.credential_source === 'provided_token') {
        await this.revokeCurrentGeneration(db, authorization, 'github_token_rejected');
        return { connected: false, reason: 'revoked' };
      }
      forceRefresh = true;
    }

    if (
      authorization.credential_source === 'github_app' &&
      (forceRefresh ||
        new Date(authorization.access_token_expires_at ?? 0).getTime() - Date.now() <
          EXPIRY_BUFFER_MS)
    ) {
      const refreshResult = await this.refreshAuthorizationWithLock(db, authorization, {
        force: forceRefresh,
      });
      if (refreshResult === 'terminal_rejection') {
        await this.revokeCurrentGeneration(db, authorization, 'github_token_rejected');
        return { connected: false, reason: 'revoked' };
      }
      if (refreshResult === 'transient_failure') {
        throw new Error('temporarily_unavailable');
      }
      const [reloaded] = await db
        .select()
        .from(user_github_app_tokens)
        .where(eq(user_github_app_tokens.id, authorization.id))
        .limit(1);
      if (!reloaded || reloaded.revoked_at) {
        return { connected: false, reason: 'not_connected' };
      }
      return this.toConnectedResult(reloaded);
    }

    return this.toConnectedResult(authorization);
  }

  private toConnectedResult(authorization: AuthorizationRow): GitHubUserAccessTokenResult {
    const token = this.decryptCredential(authorization, 'access');
    return {
      connected: true,
      token,
      expiresAtEpochMs: authorization.access_token_expires_at
        ? new Date(authorization.access_token_expires_at).getTime()
        : null,
      credentialSource: authorization.credential_source,
      refreshSupported: authorization.credential_source === 'github_app',
      githubLogin: authorization.github_login,
      authorizationId: authorization.id,
      credentialVersion: authorization.credential_version,
    };
  }

  async disconnectUserAuthorization(
    kiloUserId: string,
    expected: GitHubIdentityPrecondition
  ): Promise<void> {
    const db = this.getDatabase();
    const refreshedAuthorization = await db.transaction(async tx => {
      let authorization = await lockGitHubIdentity(tx, kiloUserId, expected);
      if (!authorization) return null;
      await lockGitHubGrant(tx, authorization.github_user_id);
      authorization = await lockGitHubIdentity(tx, kiloUserId, expected);
      if (!authorization) throw new GitHubIdentityConflictError();
      if (authorization.credential_source === 'provided_token' || authorization.revoked_at) {
        await this.deleteCurrentAuthorization(tx, authorization);
        return null;
      }
      const accessTokenExpired =
        new Date(authorization.access_token_expires_at ?? 0).getTime() <= Date.now();
      if (
        !accessTokenExpired &&
        (await this.revokeAuthorizationOnGitHub(
          this.decryptCredential(authorization, 'access')
        )) === 'revoked'
      ) {
        await this.deleteCurrentAuthorization(tx, authorization);
        return null;
      }
      const refreshed = await this.refreshAuthorizationForDisconnect(tx, authorization);
      if (refreshed === 'terminal_refresh_token' && accessTokenExpired) {
        await this.deleteCurrentAuthorization(tx, authorization);
        return null;
      }
      if (!refreshed || refreshed === 'terminal_refresh_token') {
        throw new Error('GitHub authorization grant could not be revoked');
      }
      return refreshed;
    });
    if (!refreshedAuthorization) return;
    // Commit rotated secrets before revocation. A provider failure must not roll
    // back to the refresh token that GitHub already consumed.
    await db.transaction(async tx => {
      const refreshedExpected = {
        authorizationId: refreshedAuthorization.id,
        credentialVersion: refreshedAuthorization.credential_version,
      };
      let authorization = await lockGitHubIdentity(tx, kiloUserId, refreshedExpected);
      await lockGitHubGrant(tx, refreshedAuthorization.github_user_id);
      authorization = await lockGitHubIdentity(tx, kiloUserId, refreshedExpected);
      if (!authorization) throw new GitHubIdentityConflictError();
      if (
        (await this.revokeAuthorizationOnGitHub(
          this.decryptCredential(authorization, 'access')
        )) !== 'revoked'
      ) {
        throw new Error('GitHub authorization grant could not be revoked');
      }
      await this.deleteCurrentAuthorization(tx, authorization);
    });
  }
}
