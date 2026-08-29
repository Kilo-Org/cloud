import { logger } from '../logger.js';
import { ResolvedRepositoryIdentitySchema } from '../persistence/session-metadata.js';
import type { RepositoryIdentityResolution } from '../session/session-requests.js';
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
  identity: RepositoryIdentityResolution;
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

function githubIdentityFromResponse(
  response: { integrationId?: unknown; integrationOwner?: unknown },
  params: Parameters<GitTokenService['getTokenForRepo']>[0]
):
  | { success: true; identity: RepositoryIdentityResolution }
  | { success: false; error: ResolveGitHubTokenError } {
  // Old GitHub deployments omit both fields and can ignore newly added selectors.
  // Permit only their unpinned legacy path, without claiming exact identity.
  // Remove after old deployments/clients/records disappear and the 30-day ledger window expires.
  if (
    !Object.hasOwn(response, 'integrationId') &&
    !Object.hasOwn(response, 'integrationOwner') &&
    params.expectedIntegrationId === undefined &&
    params.expectedIntegrationOwner === undefined
  ) {
    return { success: true, identity: { kind: 'legacy-unresolved' } };
  }
  const parsed = ResolvedRepositoryIdentitySchema.safeParse({
    kind: 'resolved',
    integrationId: response.integrationId,
    integrationOwner: response.integrationOwner,
    instanceUrl: 'https://github.com',
  });
  if (!parsed.success) {
    return {
      success: false,
      error: {
        reason: 'service_compatibility_error',
        message:
          'GitHub token service cannot prove the repository identity (service_compatibility_error)',
      },
    };
  }
  const identity = parsed.data;
  if (
    (params.expectedIntegrationId !== undefined &&
      params.expectedIntegrationId !== identity.integrationId) ||
    (params.expectedIntegrationOwner !== undefined &&
      (params.expectedIntegrationOwner.type !== identity.integrationOwner.type ||
        params.expectedIntegrationOwner.id !== identity.integrationOwner.id))
  ) {
    return {
      success: false,
      error: {
        reason: 'integration_mismatch',
        message: 'GitHub repository identity does not match the requested integration',
      },
    };
  }
  return { success: true, identity };
}

export async function resolveGitHubTokenForRepo(
  env: GitTokenServiceEnv,
  params: Parameters<GitTokenService['getTokenForRepo']>[0]
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
      const resolution = githubIdentityFromResponse(result, params);
      if (!resolution.success) return resolution;
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
          identity: resolution.identity,
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
  identity: RepositoryIdentityResolution;
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
  identity: RepositoryIdentityResolution;
  appType: 'standard' | 'lite';
  accountLogin: string;
  source: 'user' | 'installation';
  gitAuthor: GitAuthorConfig;
  commitCoAuthor?: GitAuthorConfig;
  fallbackReason?: ManagedGitHubFallbackReason;
};

type IssueCloudAgentGitHubSessionCapabilityParams = Parameters<
  GitTokenService['getTokenForRepo']
>[0] & {
  outboundContainerId: string;
  allowUserAuthorization: boolean;
};

type IssueCloudAgentGitHubSessionCapabilityResult =
  | { success: true; value: ResolvedCloudAgentGitHubCapability | ResolvedCloudAgentGitHubAuth }
  | { success: false; error: ResolveGitHubTokenError };

type CloudAgentGitHubAuthResult =
  | { success: true; value: ResolvedCloudAgentGitHubAuth }
  | { success: false; error: ResolveGitHubTokenError };

// Old service deployments lack managed-auth/capability RPCs. Remove these
// fallbacks only after old clients/records disappear and the 30-day ledger window expires.
async function resolveLegacyInstallationAuthForRepo(
  env: GitTokenServiceEnv,
  params: Parameters<GitTokenService['getTokenForRepo']>[0]
): Promise<CloudAgentGitHubAuthResult> {
  const legacyParams = {
    githubRepo: params.githubRepo,
    userId: params.userId,
    ...(params.orgId !== undefined ? { orgId: params.orgId } : {}),
    ...(params.expectedIntegrationOwner !== undefined
      ? { expectedIntegrationOwner: params.expectedIntegrationOwner }
      : {}),
    ...(params.expectedIntegrationId !== undefined
      ? { expectedIntegrationId: params.expectedIntegrationId }
      : {}),
  };
  const result = await resolveGitHubTokenForRepo(env, legacyParams);
  if (!result.success) return result;
  return {
    success: true,
    value: {
      githubToken: result.value.token,
      installationId: result.value.installationId,
      identity: result.value.identity,
      appType: result.value.appType,
      accountLogin: result.value.accountLogin,
      source: 'installation',
    },
  };
}

export async function resolveCloudAgentGitHubAuthForRepo(
  env: GitTokenServiceEnv,
  params: Parameters<GitTokenService['getTokenForRepo']>[0] & { allowUserAuthorization: boolean }
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
    const resolution = githubIdentityFromResponse(result, params);
    if (!resolution.success) return resolution;
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
        identity: resolution.identity,
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
    ...(params.expectedIntegrationOwner !== undefined
      ? { expectedIntegrationOwner: params.expectedIntegrationOwner }
      : {}),
    ...(params.expectedIntegrationId !== undefined
      ? { expectedIntegrationId: params.expectedIntegrationId }
      : {}),
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
    const resolution = githubIdentityFromResponse(result, params);
    if (!resolution.success) return resolution;
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
        identity: resolution.identity,
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
  | {
      success: true;
      token: string;
      instanceUrl: string;
      integrationId: string;
      glabIsOAuth2: boolean;
    }
  | { success: false; reason: string };

export type ManagedBitbucketTokenFailureReason =
  | BitbucketTokenFailureReason
  | 'service_not_configured'
  | 'rpc_error';

export type ResolveManagedBitbucketTokenResult =
  | { success: true; token: string; integrationId: string }
  | { success: false; reason: ManagedBitbucketTokenFailureReason };

export function isTemporaryManagedGitLabTokenFailure(reason: string): boolean {
  return (
    reason === 'token_refresh_failed' ||
    reason === 'project_lookup_failed' ||
    reason === 'service_not_configured' ||
    reason === 'database_not_configured' ||
    reason === 'rpc_error'
  );
}

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
      return { success: true, token: result.token, integrationId: result.integrationId };
    }
    logger.withFields({ reason: result.reason }).info('Bitbucket token lookup failed');
    return { success: false, reason: result.reason };
  } catch {
    logger.error('Failed to call git-token-service getBitbucketToken');
    return { success: false, reason: 'rpc_error' };
  }
}

export type ResolvedCloudAgentBitbucketCapability = {
  capability: string;
  gitUrl: string;
  integrationId: string;
};

export async function issueCloudAgentBitbucketSessionCapability(
  env: GitTokenServiceEnv,
  params: {
    userId: string;
    orgId: string;
    outboundContainerId: string;
    expectedIntegrationId?: string;
    workspaceUuid: string;
    repositoryUuid: string;
    repositoryUrl: string;
  }
): Promise<
  | { success: true; value: ResolvedCloudAgentBitbucketCapability }
  | {
      success: false;
      reason: ManagedBitbucketTokenFailureReason | 'capability_configuration_error';
    }
> {
  if (!env.GIT_TOKEN_SERVICE?.issueBitbucketSessionCapability) {
    return { success: false, reason: 'service_not_configured' };
  }
  try {
    const result = await env.GIT_TOKEN_SERVICE.issueBitbucketSessionCapability(params);
    if (!result.success) return { success: false, reason: result.reason };
    logger.info('Issued Bitbucket session capability via git-token-service');
    return {
      success: true,
      value: {
        capability: result.capability,
        gitUrl: result.gitUrl,
        integrationId: result.integrationId,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.withFields({ error: message }).error('Failed to issue Bitbucket session capability');
    return { success: false, reason: 'rpc_error' };
  }
}

export async function issueCloudAgentGitLabSessionCapability(
  env: GitTokenServiceEnv,
  params: Parameters<GitTokenService['issueGitLabSessionCapability']>[0]
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
  params: Parameters<GitTokenService['getGitLabToken']>[0]
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
        integrationId: result.integrationId,
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
