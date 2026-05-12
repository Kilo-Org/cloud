import { logger } from '../logger.js';
import type { Env as WorkerEnv } from '../types.js';
import type { GitIdentity } from '../types/git-identity.js';

export type ResolvedGitHubToken = {
  token: string;
  installationId: string;
  appType: 'standard' | 'lite';
  accountLogin: string;
};

export type ResolveGitHubTokenError = {
  reason: string;
  message: string;
};

export type ResolveGitHubTokenResult =
  | { success: true; value: ResolvedGitHubToken }
  | { success: false; error: ResolveGitHubTokenError };

export async function resolveGitHubTokenForRepo(
  env: WorkerEnv,
  params: { githubRepo: string; userId: string; orgId?: string }
): Promise<ResolveGitHubTokenResult> {
  try {
    const result = await env.GIT_TOKEN_SERVICE.getTokenForRepo(params);
    if (result.success) {
      logger
        .withFields({
          installationId: result.installationId,
          accountLogin: result.accountLogin,
          githubAppType: result.appType,
        })
        .info('Resolved GitHub token via git-token-service');
      return {
        success: true,
        value: {
          token: result.token,
          installationId: result.installationId,
          appType: result.appType,
          accountLogin: result.accountLogin,
        },
      };
    }
    logger
      .withFields({ reason: result.reason, githubRepo: params.githubRepo })
      .info('GitHub token lookup failed');
    return {
      success: false,
      error: {
        reason: result.reason,
        message: `GitHub token lookup failed (${result.reason})`,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.withFields({ error: message }).error('Failed to call git-token-service getTokenForRepo');
    return {
      success: false,
      error: { reason: 'rpc_error', message: `git-token-service RPC failed: ${message}` },
    };
  }
}

export type ResolveUserGitHubTokenResult =
  | { success: true; token: string; identity: Extract<GitIdentity, { kind: 'user' }> }
  | { success: false; reason: string };

/**
 * Attempt to resolve a GitHub user-to-server token for `githubRepo`.
 * Returns `{ success: false }` on any failure (not connected, expired, revoked,
 * no repo access, or RPC error) — callers fall back to the app installation token.
 *
 * Does NOT log the token on success. Logs `{ kiloUserId, githubRepo, reason }` on failure.
 */
export async function resolveUserGitHubTokenForRepo(
  env: WorkerEnv,
  params: { kiloUserId: string; githubRepo: string; appType?: 'standard' | 'lite' }
): Promise<ResolveUserGitHubTokenResult> {
  try {
    const result = await env.GIT_TOKEN_SERVICE.getUserTokenForRepo(params);
    if (result.ok) {
      logger
        .withFields({ kiloUserId: params.kiloUserId, githubRepo: params.githubRepo })
        .info('Resolved GitHub user token via git-token-service');
      return {
        success: true,
        token: result.token,
        identity: {
          kind: 'user',
          login: result.githubLogin,
          userId: result.githubUserId,
          email: result.githubEmail,
        },
      };
    }
    logger
      .withFields({
        kiloUserId: params.kiloUserId,
        githubRepo: params.githubRepo,
        reason: result.reason,
      })
      .info('GitHub user token lookup failed, will fall back to app token');
    return { success: false, reason: result.reason };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger
      .withFields({ error: message })
      .error('Failed to call git-token-service getUserTokenForRepo');
    return { success: false, reason: 'rpc_error' };
  }
}

export type ResolveManagedGitLabTokenResult =
  | { success: true; token: string }
  | { success: false; reason: string };

export async function resolveManagedGitLabToken(
  env: WorkerEnv,
  params: { userId: string; orgId?: string }
): Promise<ResolveManagedGitLabTokenResult> {
  try {
    const result = await env.GIT_TOKEN_SERVICE.getGitLabToken(params);
    if (result.success) {
      logger.info('Resolved GitLab token via git-token-service');
      return { success: true, token: result.token };
    }
    logger.withFields({ reason: result.reason }).info('GitLab token lookup failed');
    return { success: false, reason: result.reason };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.withFields({ error: message }).error('Failed to call git-token-service getGitLabToken');
    return { success: false, reason: 'rpc_error' };
  }
}
