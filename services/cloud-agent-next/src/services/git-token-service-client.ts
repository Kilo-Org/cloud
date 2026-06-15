import { logger } from '../logger.js';
import type { GitAuthorConfig, GitTokenService, ManagedGitHubFallbackReason } from '../types.js';

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

export type ResolvedCloudAgentGitHubAuth = {
  githubToken: string;
  installationId: string;
  appType: 'standard' | 'lite';
  accountLogin: string;
  source: 'user' | 'installation';
  gitAuthor?: GitAuthorConfig;
  commitCoAuthor?: GitAuthorConfig;
  fallbackReason?: ManagedGitHubFallbackReason;
};

type CloudAgentGitHubAuthResult =
  | { success: true; value: ResolvedCloudAgentGitHubAuth }
  | { success: false; error: ResolveGitHubTokenError };

async function resolveLegacyInstallationAuthForRepo(
  env: GitTokenServiceEnv,
  params: { githubRepo: string; userId: string; orgId?: string }
): Promise<CloudAgentGitHubAuthResult> {
  const legacyParams = {
    githubRepo: params.githubRepo,
    userId: params.userId,
    ...(params.orgId !== undefined ? { orgId: params.orgId } : {}),
  };
  const result = await resolveGitHubTokenForRepo(env, legacyParams);
  if (!result.success) return result;
  return {
    success: true,
    value: {
      githubToken: result.value.token,
      installationId: result.value.installationId,
      appType: result.value.appType,
      accountLogin: result.value.accountLogin,
      source: 'installation',
    },
  };
}

export async function resolveCloudAgentGitHubAuthForRepo(
  env: GitTokenServiceEnv,
  params: {
    githubRepo: string;
    userId: string;
    orgId?: string;
    allowUserAuthorization: boolean;
  }
): Promise<CloudAgentGitHubAuthResult> {
  if (!env.GIT_TOKEN_SERVICE) {
    return {
      success: false,
      error: {
        reason: 'service_not_configured',
        message: 'git-token-service binding is not configured',
      },
    };
  }
  if (!env.GIT_TOKEN_SERVICE.getCloudAgentAuthForRepo) {
    return resolveLegacyInstallationAuthForRepo(env, params);
  }

  try {
    const result = await env.GIT_TOKEN_SERVICE.getCloudAgentAuthForRepo(params);
    if (!result.success) {
      return {
        success: false,
        error: {
          reason: result.reason,
          message: `GitHub managed auth lookup failed (${result.reason})`,
        },
      };
    }
    logger
      .withFields({
        installationId: result.installationId,
        accountLogin: result.accountLogin,
        githubAppType: result.appType,
        source: result.source,
        fallbackReason: result.fallbackReason,
      })
      .info('Resolved managed GitHub auth via git-token-service');
    return {
      success: true,
      value: {
        githubToken: result.githubToken,
        installationId: result.installationId,
        appType: result.appType,
        accountLogin: result.accountLogin,
        source: result.source,
        gitAuthor: result.gitAuthor,
        ...(result.commitCoAuthor ? { commitCoAuthor: result.commitCoAuthor } : {}),
        ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger
      .withFields({ error: message })
      .warn('Managed GitHub auth RPC unavailable; using installation authentication fallback');
    return resolveLegacyInstallationAuthForRepo(env, params);
  }
}

export type ResolveManagedGitLabTokenResult =
  | { success: true; token: string; glabIsOAuth2: boolean }
  | { success: false; reason: string };

export async function resolveManagedGitLabToken(
  env: GitTokenServiceEnv,
  params: {
    userId: string;
    orgId?: string;
    repositoryUrl?: string;
    createdOnPlatform?: string;
  }
): Promise<ResolveManagedGitLabTokenResult> {
  try {
    if (!env.GIT_TOKEN_SERVICE) {
      return { success: false, reason: 'service_not_configured' };
    }
    const result = await env.GIT_TOKEN_SERVICE.getGitLabToken(params);
    if (result.success) {
      logger.info('Resolved GitLab token via git-token-service');
      return { success: true, token: result.token, glabIsOAuth2: result.glabIsOAuth2 };
    }
    logger.withFields({ reason: result.reason }).info('GitLab token lookup failed');
    return { success: false, reason: result.reason };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.withFields({ error: message }).error('Failed to call git-token-service getGitLabToken');
    return { success: false, reason: 'rpc_error' };
  }
}
