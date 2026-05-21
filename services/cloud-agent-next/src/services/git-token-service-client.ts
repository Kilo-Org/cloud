import { logger } from '../logger.js';
import type { GitTokenService } from '../types.js';

type GitTokenServiceEnv = {
  GIT_TOKEN_SERVICE?: GitTokenService;
};

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
  env: GitTokenServiceEnv,
  params: { githubRepo: string; userId: string; orgId?: string }
): Promise<ResolveGitHubTokenResult> {
  try {
    if (!env.GIT_TOKEN_SERVICE) {
      return {
        success: false,
        error: {
          reason: 'service_not_configured',
          message: 'git-token-service binding is not configured',
        },
      };
    }
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

export type ResolveManagedGitLabTokenResult =
  | { success: true; token: string }
  | { success: false; reason: string };

export async function resolveManagedGitLabToken(
  env: GitTokenServiceEnv,
  params: { userId: string; orgId?: string }
): Promise<ResolveManagedGitLabTokenResult> {
  try {
    if (!env.GIT_TOKEN_SERVICE) {
      return { success: false, reason: 'service_not_configured' };
    }
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
