import { logger } from '../logger.js';
import type {
  BitbucketTokenFailureReason,
  GitAuthorConfig,
  GitTokenService,
  KiloSessionCapabilityTargets,
  ManagedGitHubFallbackReason,
} from '../types.js';

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

export type ResolvedCloudAgentGitHubCapability = {
  capability: string;
  installationId: string;
  appType: 'standard' | 'lite';
  accountLogin: string;
  source: 'user' | 'installation';
  gitAuthor: GitAuthorConfig;
  commitCoAuthor?: GitAuthorConfig;
  fallbackReason?: ManagedGitHubFallbackReason;
};

type IssueCloudAgentGitHubSessionCapabilityParams = {
  githubRepo: string;
  userId: string;
  outboundContainerId: string;
  orgId?: string;
  allowUserAuthorization: boolean;
};

type IssueCloudAgentGitHubSessionCapabilityResult =
  | { success: true; value: ResolvedCloudAgentGitHubCapability | ResolvedCloudAgentGitHubAuth }
  | { success: false; error: ResolveGitHubTokenError };

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

function resolveGitHubAuthFallbackForCapability(
  env: GitTokenServiceEnv,
  params: IssueCloudAgentGitHubSessionCapabilityParams
): Promise<IssueCloudAgentGitHubSessionCapabilityResult> {
  return resolveCloudAgentGitHubAuthForRepo(env, {
    githubRepo: params.githubRepo,
    userId: params.userId,
    ...(params.orgId !== undefined ? { orgId: params.orgId } : {}),
    allowUserAuthorization: params.allowUserAuthorization,
  });
}

export async function issueCloudAgentGitHubSessionCapability(
  env: GitTokenServiceEnv,
  params: IssueCloudAgentGitHubSessionCapabilityParams
): Promise<IssueCloudAgentGitHubSessionCapabilityResult> {
  if (!env.GIT_TOKEN_SERVICE) {
    return {
      success: false,
      error: {
        reason: 'service_not_configured',
        message: 'git-token-service capability issuance is not configured',
      },
    };
  }
  if (typeof env.GIT_TOKEN_SERVICE.issueGitHubSessionCapability !== 'function') {
    logger.warn('Managed GitHub capability RPC unavailable; using direct authentication fallback');
    return resolveGitHubAuthFallbackForCapability(env, params);
  }

  try {
    const result = await env.GIT_TOKEN_SERVICE.issueGitHubSessionCapability(params);
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
      .info('Issued managed GitHub session capability via git-token-service');
    return {
      success: true,
      value: {
        capability: result.capability,
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
      .warn('Managed GitHub capability RPC unavailable; using direct authentication fallback');
    return resolveGitHubAuthFallbackForCapability(env, params);
  }
}

export type ResolvedCloudAgentGitLabCapability = {
  capability: string;
  gitUrl: string;
  instanceOrigin: string;
  instanceHost: string;
  projectPath: string;
  integrationId: string;
  authType: 'oauth' | 'pat';
  identity: { accountId: string | null; accountLogin: string | null };
  glabIsOAuth2: boolean;
};

export type ResolveManagedGitLabTokenResult =
  | { success: true; token: string; instanceUrl: string; glabIsOAuth2: boolean }
  | { success: false; reason: string };

export type ManagedBitbucketTokenFailureReason =
  | BitbucketTokenFailureReason
  | 'service_not_configured'
  | 'rpc_error';

export type ResolveManagedBitbucketTokenResult =
  | { success: true; token: string }
  | { success: false; reason: ManagedBitbucketTokenFailureReason };

export function isTemporaryManagedBitbucketTokenFailure(
  reason: ManagedBitbucketTokenFailureReason
): boolean {
  return (
    reason === 'temporarily_unavailable' ||
    reason === 'service_not_configured' ||
    reason === 'rpc_error'
  );
}

export async function resolveManagedBitbucketToken(
  env: GitTokenServiceEnv,
  params: {
    userId: string;
    orgId: string;
    expectedIntegrationId?: string;
    workspaceUuid: string;
    repositoryUuid: string;
    repositoryUrl: string;
  }
): Promise<ResolveManagedBitbucketTokenResult> {
  if (!params.orgId) {
    return { success: false, reason: 'invalid_request' };
  }

  try {
    if (!env.GIT_TOKEN_SERVICE?.getBitbucketToken) {
      logger.warn('Bitbucket git-token-service binding is not configured');
      return { success: false, reason: 'service_not_configured' };
    }
    const result = await env.GIT_TOKEN_SERVICE.getBitbucketToken(params);
    if (result.success) {
      logger.info('Resolved Bitbucket token via git-token-service');
      return { success: true, token: result.token };
    }
    logger.withFields({ reason: result.reason }).info('Bitbucket token lookup failed');
    return { success: false, reason: result.reason };
  } catch {
    logger.error('Failed to call git-token-service getBitbucketToken');
    return { success: false, reason: 'rpc_error' };
  }
}

export async function issueCloudAgentGitLabSessionCapability(
  env: GitTokenServiceEnv,
  params: {
    gitUrl: string;
    userId: string;
    outboundContainerId: string;
    orgId?: string;
    createdOnPlatform?: string;
  }
): Promise<
  { success: true; value: ResolvedCloudAgentGitLabCapability } | { success: false; reason: string }
> {
  if (!env.GIT_TOKEN_SERVICE) {
    return { success: false, reason: 'service_not_configured' };
  }

  try {
    const result = await env.GIT_TOKEN_SERVICE.issueGitLabSessionCapability(params);
    if (!result.success) return result;
    logger
      .withFields({
        instanceHost: result.instanceHost,
        projectPath: result.projectPath,
        authType: result.authType,
      })
      .info('Issued managed GitLab session capability via git-token-service');
    return {
      success: true,
      value: {
        capability: result.capability,
        gitUrl: `${result.instanceOrigin}/${result.projectPath}.git`,
        instanceOrigin: result.instanceOrigin,
        instanceHost: result.instanceHost,
        projectPath: result.projectPath,
        integrationId: result.integrationId,
        authType: result.authType,
        identity: result.identity,
        glabIsOAuth2: result.glabIsOAuth2,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger
      .withFields({ error: message })
      .error('Failed to issue managed GitLab session capability');
    return { success: false, reason: 'rpc_error' };
  }
}

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
      return {
        success: true,
        token: result.token,
        instanceUrl: result.instanceUrl,
        glabIsOAuth2: result.glabIsOAuth2,
      };
    }
    logger.withFields({ reason: result.reason }).info('GitLab token lookup failed');
    return { success: false, reason: result.reason };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.withFields({ error: message }).error('Failed to call git-token-service getGitLabToken');
    return { success: false, reason: 'rpc_error' };
  }
}

export type ResolvedCloudAgentKiloCapability = {
  capability: string;
};

export async function issueCloudAgentKiloSessionCapability(
  env: GitTokenServiceEnv,
  params: {
    userId: string;
    cloudAgentSessionId: string;
    kiloSessionId: string;
    outboundContainerId: string;
    userToken: string;
    targets: KiloSessionCapabilityTargets;
  }
): Promise<
  | { success: true; value: ResolvedCloudAgentKiloCapability }
  | { success: false; error: ResolveGitHubTokenError }
> {
  if (!env.GIT_TOKEN_SERVICE) {
    return {
      success: false,
      error: {
        reason: 'service_not_configured',
        message: 'git-token-service capability issuance is not configured',
      },
    };
  }

  try {
    const result = await env.GIT_TOKEN_SERVICE.issueKiloSessionCapability(params);
    if (!result.success) {
      return {
        success: false,
        error: {
          reason: result.reason,
          message: `Kilo session capability issuance failed (${result.reason})`,
        },
      };
    }
    logger.info('Issued Kilo session capability via git-token-service');
    return { success: true, value: { capability: result.capability } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.withFields({ error: message }).error('Failed to issue Kilo session capability');
    return {
      success: false,
      error: { reason: 'rpc_error', message: `git-token-service RPC failed: ${message}` },
    };
  }
}
