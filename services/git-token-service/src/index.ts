import { timingSafeEqual } from '@kilocode/encryption';
import { extractBearerToken, verifyKiloToken } from '@kilocode/worker-utils';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { GitHubTokenService, type GitHubAppType } from './github-token-service.js';
import { GitLabLookupService, type GitLabLookupSuccess } from './gitlab-lookup-service.js';
import {
  resolveGitLabRuntimeToken,
  type GetGitLabTokenParams,
  type GetGitLabTokenFailure,
  type GetGitLabTokenResult,
} from './gitlab-runtime-token-resolver.js';
import { DEFAULT_GITLAB_INSTANCE_URL } from './gitlab-constants.js';
import {
  GitLabSessionCapabilityCodec,
  GitLabSessionCapabilityError,
  sha256Digest,
  type GitLabAuthType,
  type GitLabCapabilityCredentialSource,
  type GitLabSessionCapabilityFailureReason,
  type GitLabSessionIdentity,
} from './gitlab-session-capability.js';
import {
  normalizeGitLabInstanceUrl,
  parseGitLabBaseUrl,
  parseGitLabCloneUrl,
  type GitLabCloneUrlFailureReason,
} from './gitlab-url.js';
import { GitLabTokenService } from './gitlab-token-service.js';
import { InstallationLookupService } from './installation-lookup-service.js';
import {
  GitHubSessionCapabilityCodec,
  GitHubSessionCapabilityError,
  normalizeGitHubRepository,
  type GitHubSessionCapabilityFailureReason,
  type GitHubSessionIdentity,
} from './github-session-capability.js';
import {
  GitHubUserAuthorizationService,
  type GitAuthorConfig,
  type ManagedGitHubFallbackReason as UserAuthorizationFallbackReason,
} from './github-user-authorization-service.js';

export type GetTokenForRepoParams = {
  githubRepo: string;
  userId: string;
  orgId?: string;
};

export type GetTokenForRepoSuccess = {
  success: true;
  token: string;
  installationId: string;
  accountLogin: string;
  appType: GitHubAppType;
};

export type GetTokenForRepoFailure = {
  success: false;
  reason:
    | 'database_not_configured'
    | 'invalid_repo_format'
    | 'no_installation_found'
    | 'repository_not_installed'
    | 'invalid_org_id';
};

export type GetTokenForRepoResult = GetTokenForRepoSuccess | GetTokenForRepoFailure;
export type {
  GetGitLabTokenParams,
  GetGitLabTokenSuccess,
  GetGitLabTokenFailure,
  GetGitLabTokenResult,
} from './gitlab-runtime-token-resolver.js';

export type ManagedGitHubFallbackReason = UserAuthorizationFallbackReason | 'lite_installation';

export type GetCloudAgentAuthForRepoParams = GetTokenForRepoParams & {
  allowUserAuthorization?: boolean;
};

export type GetCloudAgentAuthForRepoSuccess = {
  success: true;
  githubToken: string;
  installationId: string;
  accountLogin: string;
  appType: GitHubAppType;
  source: 'user' | 'installation';
  gitAuthor: GitAuthorConfig;
  commitCoAuthor?: GitAuthorConfig;
  fallbackReason?: ManagedGitHubFallbackReason;
};

export type GetCloudAgentAuthForRepoResult =
  | GetCloudAgentAuthForRepoSuccess
  | GetTokenForRepoFailure;

export type IssueGitHubSessionCapabilityParams = GetCloudAgentAuthForRepoParams & {
  outboundContainerId?: string;
};
export type IssueGitHubSessionCapabilitySuccess = Omit<
  GetCloudAgentAuthForRepoSuccess,
  'githubToken'
> & {
  capability: string;
};
export type IssueGitHubSessionCapabilityResult =
  | IssueGitHubSessionCapabilitySuccess
  | GetTokenForRepoFailure
  | { success: false; reason: 'capability_configuration_error' };

export type RedeemGitHubSessionCapabilityParams = {
  capability: string;
  outboundContainerId?: string;
  requestMethod: string;
  requestUrl: string;
};
export type RedeemGitHubSessionCapabilitySuccess = {
  success: true;
  authorization: string;
};
export type RedeemGitHubSessionCapabilityFailureReason =
  | GitHubSessionCapabilityFailureReason
  | 'container_mismatch'
  | 'invalid_upstream_url'
  | 'upstream_host_not_allowed'
  | 'repository_mismatch'
  | 'invalid_upstream_request'
  | 'source_unavailable'
  | 'identity_mismatch';
export type RedeemGitHubSessionCapabilityResult =
  | RedeemGitHubSessionCapabilitySuccess
  | { success: false; reason: RedeemGitHubSessionCapabilityFailureReason };

export type IssueGitLabSessionCapabilityParams = GetGitLabTokenParams & {
  gitUrl: string;
  outboundContainerId?: string;
};
export type IssueGitLabSessionCapabilitySuccess = {
  success: true;
  capability: string;
  instanceOrigin: string;
  instanceHost: string;
  projectPath: string;
  integrationId: string;
  authType: GitLabAuthType;
  identity: GitLabSessionIdentity;
  source: GitLabCapabilityCredentialSource;
  glabIsOAuth2: boolean;
};
export type IssueGitLabSessionCapabilityResult =
  | IssueGitLabSessionCapabilitySuccess
  | GetGitLabTokenFailure
  | { success: false; reason: GitLabCloneUrlFailureReason | 'capability_configuration_error' };
export type RedeemGitLabSessionCapabilityParams = {
  capability: string;
  outboundContainerId?: string;
  requestMethod: string;
  requestUrl: string;
};
export type RedeemGitLabSessionCapabilityFailureReason =
  | GitLabSessionCapabilityFailureReason
  | 'container_mismatch'
  | 'invalid_upstream_url'
  | 'upstream_origin_not_allowed'
  | 'repository_mismatch'
  | 'invalid_upstream_request'
  | 'source_unavailable'
  | 'identity_mismatch';
export type RedeemGitLabSessionCapabilityResult =
  | {
      success: true;
      headers:
        | { authorization: string; 'PRIVATE-TOKEN'?: never }
        | { authorization?: never; 'PRIVATE-TOKEN': string };
    }
  | { success: false; reason: RedeemGitLabSessionCapabilityFailureReason };

const DISCONNECT_PATH = '/internal/github-user-authorizations/disconnect';

type DisconnectEnv = CloudflareEnv & {
  NEXTAUTH_SECRET: SecretsStoreSecret | string;
};

async function resolveSecret(secret: SecretsStoreSecret | string): Promise<string> {
  return typeof secret === 'string' ? secret : secret.get();
}

function validateGitHubCapabilityUpstream(
  requestMethod: string,
  requestUrl: string,
  repository: { owner: string; repo: string }
): RedeemGitHubSessionCapabilityFailureReason | null {
  if (/%2f|%5c/i.test(requestUrl) || /\/(?:(?:\.|%2e){1,2})(?:\/|$)/i.test(requestUrl)) {
    return 'invalid_upstream_url';
  }
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return 'invalid_upstream_url';
  }
  if (url.protocol !== 'https:') return 'invalid_upstream_url';
  if (url.username || url.password || url.hash) return 'invalid_upstream_url';
  const method = requestMethod.toUpperCase();
  if (url.hostname === 'api.github.com' && url.port === '') {
    if (!['GET', 'POST', 'PATCH', 'HEAD'].includes(method)) {
      return 'invalid_upstream_request';
    }
    const repositoryApiPath = `/repos/${repository.owner}/${repository.repo}`;
    const path = url.pathname.toLowerCase();
    if (path !== repositoryApiPath && !path.startsWith(`${repositoryApiPath}/`)) {
      return 'repository_mismatch';
    }
    const relativePath = path.slice(repositoryApiPath.length);
    if (
      ['GET', 'HEAD'].includes(method) &&
      (/^\/pulls\/[1-9]\d*$/.test(relativePath) ||
        /^\/issues\/[1-9]\d*\/comments$/.test(relativePath) ||
        /^\/pulls\/[1-9]\d*\/(?:comments|reviews)$/.test(relativePath))
    ) {
      return null;
    }
    if (method === 'POST' && /^\/issues\/[1-9]\d*\/comments$/.test(relativePath)) return null;
    if (method === 'PATCH' && /^\/issues\/comments\/[1-9]\d*$/.test(relativePath)) return null;
    if (method === 'POST' && /^\/pulls\/[1-9]\d*\/reviews$/.test(relativePath)) return null;
    return 'invalid_upstream_request';
  }
  if (url.hostname !== 'github.com' || url.port !== '') return 'upstream_host_not_allowed';

  const repositoryPath = `/${repository.owner}/${repository.repo}.git`;
  const path = url.pathname.toLowerCase();
  if (!path.startsWith(`/${repository.owner}/${repository.repo}`)) return 'repository_mismatch';

  if (method === 'GET' && path === `${repositoryPath}/info/refs`) {
    const entries = [...url.searchParams.entries()];
    const service = url.searchParams.get('service');
    if (entries.length === 1 && (service === 'git-upload-pack' || service === 'git-receive-pack')) {
      return null;
    }
  }
  if (
    method === 'POST' &&
    url.search === '' &&
    (path === `${repositoryPath}/git-upload-pack` ||
      path === `${repositoryPath}/git-receive-pack` ||
      path === `${repositoryPath}/info/lfs/objects/batch` ||
      path === `${repositoryPath}/info/lfs/locks/verify`)
  ) {
    return null;
  }
  return 'invalid_upstream_request';
}

function validateGitLabCapabilityUpstream(
  requestMethod: string,
  requestUrl: string,
  session: {
    instanceOrigin: string;
    projectPath: string;
    source: GitLabCapabilityCredentialSource;
  }
): { failure: RedeemGitLabSessionCapabilityFailureReason | null; authSurface: 'git' | 'api' } {
  if (/%5c/i.test(requestUrl) || /\/(?:(?:\.|%2e){1,2})(?:\/|$)/i.test(requestUrl)) {
    return { failure: 'invalid_upstream_url', authSurface: 'git' };
  }
  const base = parseGitLabBaseUrl(session.instanceOrigin);
  if (!base) return { failure: 'invalid_upstream_url', authSurface: 'git' };
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { failure: 'invalid_upstream_url', authSurface: 'git' };
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.origin !== base.origin
  ) {
    return {
      failure: url.origin !== base.origin ? 'upstream_origin_not_allowed' : 'invalid_upstream_url',
      authSurface: 'git',
    };
  }
  const method = requestMethod.toUpperCase();
  const apiPrefix = `${base.basePath}/api/v4/`;
  const projectApiPrefix = `${base.basePath}/api/v4/projects/`;
  if (url.pathname.startsWith(projectApiPrefix)) {
    const projectApiPath = url.pathname.slice(projectApiPrefix.length);
    const [projectSelector, ...remainingSegments] = projectApiPath.split('/');
    if (!projectSelector || remainingSegments.some(segment => /%2f|%5c/i.test(segment))) {
      return { failure: 'invalid_upstream_url', authSurface: 'api' };
    }
    let decodedProjectSelector: string;
    try {
      decodedProjectSelector = decodeURIComponent(projectSelector);
    } catch {
      return { failure: 'invalid_upstream_url', authSurface: 'api' };
    }
    const selectorMatches =
      decodedProjectSelector === session.projectPath ||
      (session.source.type === 'project' &&
        decodedProjectSelector === String(session.source.projectId));
    const relativePath = remainingSegments.join('/');
    const allowed =
      (['GET', 'HEAD'].includes(method) &&
        /^merge_requests\/[1-9]\d*(?:\/(?:changes|diffs|notes|discussions))?$/.test(
          relativePath
        )) ||
      (method === 'POST' &&
        /^merge_requests\/[1-9]\d*\/(?:notes|discussions)$/.test(relativePath)) ||
      (method === 'PUT' && /^merge_requests\/[1-9]\d*\/notes\/[1-9]\d*$/.test(relativePath));
    return {
      failure: selectorMatches
        ? allowed
          ? null
          : 'invalid_upstream_request'
        : 'repository_mismatch',
      authSurface: 'api',
    };
  }
  if (url.pathname === `${base.basePath}/api/graphql` || url.pathname.startsWith(apiPrefix)) {
    return { failure: 'invalid_upstream_request', authSurface: 'api' };
  }
  if (/%2f/i.test(requestUrl)) {
    return { failure: 'invalid_upstream_url', authSurface: 'git' };
  }

  const repositoryPath = `${base.basePath}/${session.projectPath}.git`;
  if (method === 'GET' && url.pathname === `${repositoryPath}/info/refs`) {
    const entries = [...url.searchParams.entries()];
    const service = url.searchParams.get('service');
    if (entries.length === 1 && (service === 'git-upload-pack' || service === 'git-receive-pack')) {
      return { failure: null, authSurface: 'git' };
    }
  }
  if (
    method === 'POST' &&
    url.search === '' &&
    (url.pathname === `${repositoryPath}/git-upload-pack` ||
      url.pathname === `${repositoryPath}/git-receive-pack` ||
      url.pathname === `${repositoryPath}/info/lfs/objects/batch` ||
      url.pathname === `${repositoryPath}/info/lfs/locks/verify`)
  ) {
    return { failure: null, authSurface: 'git' };
  }
  const repositoryPrefix = `${base.basePath}/${session.projectPath}`;
  return {
    failure:
      url.pathname.startsWith(repositoryPrefix) || !url.pathname.includes('.git/')
        ? 'invalid_upstream_request'
        : 'repository_mismatch',
    authSurface: 'git',
  };
}

export class GitTokenRPCEntrypoint extends WorkerEntrypoint<CloudflareEnv> {
  private githubService: GitHubTokenService;
  private installationLookupService: InstallationLookupService;
  private gitlabLookupService: GitLabLookupService;
  private gitlabTokenService: GitLabTokenService;
  private githubUserAuthorizationService: GitHubUserAuthorizationService;

  constructor(ctx: ExecutionContext, env: CloudflareEnv) {
    super(ctx, env);
    this.githubService = new GitHubTokenService(env);
    this.installationLookupService = new InstallationLookupService(env);
    this.gitlabLookupService = new GitLabLookupService(env);
    this.gitlabTokenService = new GitLabTokenService(env);
    this.githubUserAuthorizationService = new GitHubUserAuthorizationService(env);
  }

  private async refreshGitHubInstallationLogins(params: GetTokenForRepoParams): Promise<void> {
    const candidates = await this.installationLookupService.findRefreshCandidates(params);
    if (!candidates.success) {
      return;
    }

    for (const candidate of candidates.candidates) {
      const refreshedAccountLogin = await this.githubService.refreshInstallationAccountLoginIfDue(
        candidate.installationId,
        candidate.githubAppType
      );
      if (
        !refreshedAccountLogin ||
        refreshedAccountLogin.toLowerCase() === candidate.accountLogin?.toLowerCase()
      ) {
        continue;
      }

      const wasUpdated = await this.installationLookupService.updateAccountLogin(
        candidate.integrationId,
        refreshedAccountLogin
      );
      if (!wasUpdated) {
        console.warn(
          JSON.stringify({
            message: 'GitHub installation login repair found no integration row to update',
            integrationId: candidate.integrationId,
            installationId: candidate.installationId,
            appType: candidate.githubAppType,
          })
        );
        continue;
      }

      console.log(
        JSON.stringify({
          message: 'Repaired GitHub installation account login after token lookup miss',
          integrationId: candidate.integrationId,
          installationId: candidate.installationId,
          appType: candidate.githubAppType,
        })
      );
    }
  }

  /**
   * Get a GitHub token for a repository.
   *
   * This is the main entry point - it handles the full flow:
   * 1. Looks up the GitHub App installation for this repo/user
   * 2. Validates the user has access (via org membership if applicable)
   * 3. Generates an installation access token restricted to this repository
   *
   * @param params - The repo and user context
   * @returns Token and installation details, or a failure reason
   */
  async getTokenForRepo(params: GetTokenForRepoParams): Promise<GetTokenForRepoResult> {
    let installation = await this.installationLookupService.findInstallationId(params);
    if (!installation.success && installation.reason === 'no_installation_found') {
      await this.refreshGitHubInstallationLogins(params);
      installation = await this.installationLookupService.findInstallationId(params);
    }
    if (!installation.success) {
      switch (installation.reason) {
        case 'ambiguous_installation':
          return { success: false, reason: 'no_installation_found' };
        case 'database_not_configured':
        case 'invalid_repo_format':
        case 'no_installation_found':
        case 'invalid_org_id':
          return { success: false, reason: installation.reason };
      }
    }

    const [, repoName] = params.githubRepo.split('/');
    if (!repoName) {
      return { success: false, reason: 'invalid_repo_format' };
    }

    const token = await this.githubService.getTokenForRepo(
      installation.installationId,
      repoName,
      installation.githubAppType
    );

    return {
      success: true,
      token,
      installationId: installation.installationId,
      accountLogin: installation.accountLogin,
      appType: installation.githubAppType,
    };
  }

  async getCloudAgentAuthForRepo(
    params: GetCloudAgentAuthForRepoParams
  ): Promise<GetCloudAgentAuthForRepoResult> {
    let installation = await this.installationLookupService.findManagedInstallationForRepo(params);
    if (!installation.success && installation.reason === 'no_installation_found') {
      await this.refreshGitHubInstallationLogins(params);
      installation = await this.installationLookupService.findManagedInstallationForRepo(params);
    }
    if (!installation.success) {
      switch (installation.reason) {
        case 'ambiguous_installation':
          return { success: false, reason: 'no_installation_found' };
        case 'database_not_configured':
        case 'invalid_repo_format':
        case 'no_installation_found':
        case 'repository_not_installed':
        case 'invalid_org_id':
          return { success: false, reason: installation.reason };
      }
    }

    const installationAuthor = this.getInstallationAuthor(installation.githubAppType);
    const installationAuth = async (
      fallbackReason?: ManagedGitHubFallbackReason
    ): Promise<GetCloudAgentAuthForRepoSuccess> => ({
      success: true,
      githubToken: await this.githubService.getTokenForRepo(
        installation.installationId,
        installation.repoName,
        installation.githubAppType
      ),
      installationId: installation.installationId,
      accountLogin: installation.accountLogin,
      appType: installation.githubAppType,
      source: 'installation',
      gitAuthor: installationAuthor,
      ...(fallbackReason !== undefined ? { fallbackReason } : {}),
    });

    if (params.allowUserAuthorization !== true) return installationAuth();
    if (installation.githubAppType === 'lite') return installationAuth('lite_installation');
    if (
      installation.permissions?.contents !== 'write' ||
      installation.permissions?.pull_requests !== 'write'
    ) {
      return installationAuth('insufficient_user_access');
    }

    const selection = await this.githubUserAuthorizationService.selectUserAuthorization(params);
    if (!selection.selected) return installationAuth(selection.reason);

    return {
      success: true,
      githubToken: selection.token,
      installationId: installation.installationId,
      accountLogin: installation.accountLogin,
      appType: installation.githubAppType,
      source: 'user',
      gitAuthor: selection.gitAuthor,
      commitCoAuthor: installationAuthor,
    };
  }

  async issueGitHubSessionCapability(
    params: IssueGitHubSessionCapabilityParams
  ): Promise<IssueGitHubSessionCapabilityResult> {
    const repository = normalizeGitHubRepository(params.githubRepo);
    if (!repository) return { success: false, reason: 'invalid_repo_format' };

    const auth = await this.getCloudAgentAuthForRepo({
      ...params,
      githubRepo: `${repository.owner}/${repository.repo}`,
    });
    if (!auth.success) return auth;

    let capability: string;
    try {
      const encryptionKey = await resolveSecret(this.env.SCM_SESSION_CAPABILITY_ENCRYPTION_KEY);
      capability = new GitHubSessionCapabilityCodec(encryptionKey).issue({
        userId: params.userId,
        ...(params.outboundContainerId !== undefined
          ? { outboundContainerId: params.outboundContainerId }
          : {}),
        ...(params.orgId !== undefined ? { orgId: params.orgId } : {}),
        ...repository,
        source: auth.source,
        identity: this.getSessionIdentity(auth),
      });
    } catch {
      return { success: false, reason: 'capability_configuration_error' };
    }
    return {
      success: true,
      capability,
      installationId: auth.installationId,
      accountLogin: auth.accountLogin,
      appType: auth.appType,
      source: auth.source,
      gitAuthor: auth.gitAuthor,
      ...(auth.commitCoAuthor !== undefined ? { commitCoAuthor: auth.commitCoAuthor } : {}),
      ...(auth.fallbackReason !== undefined ? { fallbackReason: auth.fallbackReason } : {}),
    };
  }

  async redeemGitHubSessionCapability(
    params: RedeemGitHubSessionCapabilityParams
  ): Promise<RedeemGitHubSessionCapabilityResult> {
    let claims;
    try {
      const encryptionKey = await resolveSecret(this.env.SCM_SESSION_CAPABILITY_ENCRYPTION_KEY);
      claims = new GitHubSessionCapabilityCodec(encryptionKey).decode(params.capability);
    } catch (error) {
      if (error instanceof GitHubSessionCapabilityError) {
        return { success: false, reason: error.reason };
      }
      return { success: false, reason: 'capability_configuration_error' };
    }

    if (claims.version === 2 && claims.outboundContainerId !== params.outboundContainerId) {
      return { success: false, reason: 'container_mismatch' };
    }

    const upstreamFailure = validateGitHubCapabilityUpstream(
      params.requestMethod,
      params.requestUrl,
      claims
    );
    if (upstreamFailure) return { success: false, reason: upstreamFailure };

    const authParams = {
      userId: claims.userId,
      ...(claims.orgId !== undefined ? { orgId: claims.orgId } : {}),
      githubRepo: `${claims.owner}/${claims.repo}`,
    };
    let auth: GetCloudAgentAuthForRepoResult | null;
    if (claims.source === 'user') {
      auth = await this.redeemPinnedUserAuthorization(authParams);
    } else {
      try {
        auth = await this.getCloudAgentAuthForRepo(authParams);
      } catch {
        return { success: false, reason: 'source_unavailable' };
      }
    }
    if (!auth || !auth.success || auth.source !== claims.source) {
      return { success: false, reason: 'source_unavailable' };
    }
    if (!this.matchesSessionIdentity(claims.identity, auth)) {
      return { success: false, reason: 'identity_mismatch' };
    }
    return {
      success: true,
      authorization: this.formatUpstreamAuthorization(params.requestUrl, auth.githubToken),
    };
  }

  private getSessionIdentity(auth: GetCloudAgentAuthForRepoSuccess): GitHubSessionIdentity {
    return {
      installationId: auth.installationId,
      accountLogin: auth.accountLogin,
      appType: auth.appType,
      gitAuthor: auth.gitAuthor,
      ...(auth.commitCoAuthor !== undefined ? { commitCoAuthor: auth.commitCoAuthor } : {}),
    };
  }

  private matchesSessionIdentity(
    issuedIdentity: GitHubSessionIdentity,
    auth: GetCloudAgentAuthForRepoSuccess
  ): boolean {
    return JSON.stringify(issuedIdentity) === JSON.stringify(this.getSessionIdentity(auth));
  }

  private formatUpstreamAuthorization(requestUrl: string, token: string): string {
    return new URL(requestUrl).hostname === 'github.com'
      ? `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
      : `Bearer ${token}`;
  }

  private async redeemPinnedUserAuthorization(
    params: GetTokenForRepoParams
  ): Promise<GetCloudAgentAuthForRepoSuccess | null> {
    const installation =
      await this.installationLookupService.findManagedInstallationForRepo(params);
    if (!installation.success || installation.githubAppType === 'lite') return null;
    if (
      installation.permissions?.contents !== 'write' ||
      installation.permissions?.pull_requests !== 'write'
    ) {
      return null;
    }
    const selection = await this.githubUserAuthorizationService.selectUserAuthorization(params);
    if (!selection.selected) return null;
    return {
      success: true,
      githubToken: selection.token,
      installationId: installation.installationId,
      accountLogin: installation.accountLogin,
      appType: installation.githubAppType,
      source: 'user',
      gitAuthor: selection.gitAuthor,
      commitCoAuthor: this.getInstallationAuthor(installation.githubAppType),
    };
  }

  private getInstallationAuthor(appType: GitHubAppType): GitAuthorConfig {
    const slug =
      appType === 'lite'
        ? this.env.GITHUB_LITE_APP_SLUG || this.env.GITHUB_APP_SLUG
        : this.env.GITHUB_APP_SLUG;
    const userId =
      appType === 'lite'
        ? this.env.GITHUB_LITE_APP_BOT_USER_ID || this.env.GITHUB_APP_BOT_USER_ID
        : this.env.GITHUB_APP_BOT_USER_ID;
    if (!slug || !userId) {
      throw new Error(`GitHub ${appType} App bot identity is not configured`);
    }
    return {
      name: `${slug}[bot]`,
      email: `${userId}+${slug}[bot]@users.noreply.github.com`,
    };
  }

  /**
   * Get a GitHub installation access token by installation ID.
   *
   * Use this when you already have the installation ID (e.g., from a previous
   * getTokenForRepo call that was stored in session metadata).
   *
   * @param installationId - GitHub App installation ID
   * @param appType - 'standard' (read/write) or 'lite' (read-only)
   * @returns The installation access token
   */
  async getToken(installationId: string, appType: GitHubAppType = 'standard'): Promise<string> {
    return this.githubService.getToken(installationId, appType);
  }

  /**
   * Get the runtime GitLab credential for the user/org and generic session context.
   * Review-origin repository sessions resolve their exact stored project token;
   * ordinary sessions preserve the existing integration-token path.
   */
  async getGitLabToken(params: GetGitLabTokenParams): Promise<GetGitLabTokenResult> {
    return resolveGitLabRuntimeToken(params, {
      lookupService: this.gitlabLookupService,
      tokenService: this.gitlabTokenService,
    });
  }

  async issueGitLabSessionCapability(
    params: IssueGitLabSessionCapabilityParams
  ): Promise<IssueGitLabSessionCapabilityResult> {
    const runtimeToken = await resolveGitLabRuntimeToken(
      { ...params, repositoryUrl: params.gitUrl },
      {
        lookupService: this.gitlabLookupService,
        tokenService: this.gitlabTokenService,
      }
    );
    if (!runtimeToken.success) return runtimeToken;

    const integration = await this.gitlabLookupService.findGitLabIntegration(
      params,
      runtimeToken.integrationId
    );
    if (!integration.success) return integration;
    const authType = this.getGitLabAuthType(integration);
    if (!authType) return { success: false, reason: 'no_token' };
    const instanceOrigin = normalizeGitLabInstanceUrl(runtimeToken.instanceUrl);
    if (!instanceOrigin) return { success: false, reason: 'unsupported_gitlab_instance' };
    const repository = parseGitLabCloneUrl(params.gitUrl, instanceOrigin);
    if (!repository.success) return repository;
    const identity = this.getGitLabSessionIdentity(integration);
    if (!identity) return { success: false, reason: 'no_token' };

    let capability: string;
    try {
      const encryptionKey = await resolveSecret(this.env.SCM_SESSION_CAPABILITY_ENCRYPTION_KEY);
      capability = new GitLabSessionCapabilityCodec(encryptionKey).issue({
        userId: params.userId,
        ...(params.outboundContainerId !== undefined
          ? { outboundContainerId: params.outboundContainerId }
          : {}),
        ...(params.orgId !== undefined ? { orgId: params.orgId } : {}),
        integrationId: integration.integrationId,
        instanceOrigin: repository.instanceOrigin,
        projectPath: repository.projectPath,
        authType,
        identity,
        source: runtimeToken.source,
      });
    } catch {
      return { success: false, reason: 'capability_configuration_error' };
    }
    return {
      success: true,
      capability,
      instanceOrigin: repository.instanceOrigin,
      instanceHost: repository.instanceHost,
      projectPath: repository.projectPath,
      integrationId: integration.integrationId,
      authType,
      identity,
      source: runtimeToken.source,
      glabIsOAuth2: runtimeToken.glabIsOAuth2,
    };
  }

  async redeemGitLabSessionCapability(
    params: RedeemGitLabSessionCapabilityParams
  ): Promise<RedeemGitLabSessionCapabilityResult> {
    let claims;
    try {
      const encryptionKey = await resolveSecret(this.env.SCM_SESSION_CAPABILITY_ENCRYPTION_KEY);
      claims = new GitLabSessionCapabilityCodec(encryptionKey).decode(params.capability);
    } catch (error) {
      if (error instanceof GitLabSessionCapabilityError) {
        return { success: false, reason: error.reason };
      }
      return { success: false, reason: 'capability_configuration_error' };
    }

    if (claims.version === 2 && claims.outboundContainerId !== params.outboundContainerId) {
      return { success: false, reason: 'container_mismatch' };
    }

    const upstream = validateGitLabCapabilityUpstream(
      params.requestMethod,
      params.requestUrl,
      claims
    );
    if (upstream.failure) return { success: false, reason: upstream.failure };
    const context = {
      userId: claims.userId,
      ...(claims.orgId !== undefined ? { orgId: claims.orgId } : {}),
    };
    const integration = await this.gitlabLookupService.findGitLabIntegration(
      context,
      claims.integrationId
    );
    if (!integration.success) return { success: false, reason: 'source_unavailable' };
    const authType = this.getGitLabAuthType(integration);
    const identity = this.getGitLabSessionIdentity(integration);
    if (
      authType !== claims.authType ||
      !identity ||
      JSON.stringify(identity) !== JSON.stringify(claims.identity)
    ) {
      return { success: false, reason: 'identity_mismatch' };
    }
    const currentInstanceOrigin = normalizeGitLabInstanceUrl(
      integration.metadata.gitlab_instance_url ?? DEFAULT_GITLAB_INSTANCE_URL
    );
    if (currentInstanceOrigin !== claims.instanceOrigin) {
      return { success: false, reason: 'identity_mismatch' };
    }

    let token: string;
    if (claims.source.type === 'integration') {
      const integrationToken = await this.gitlabTokenService.getToken(
        integration.integrationId,
        integration.metadata
      );
      if (!integrationToken.success) return { success: false, reason: 'source_unavailable' };
      token = integrationToken.token;
    } else {
      const projectToken = integration.metadata.project_tokens?.[String(claims.source.projectId)];
      if (!projectToken) return { success: false, reason: 'source_unavailable' };
      const currentTokenDigest = await sha256Digest(projectToken.token);
      if (!timingSafeEqual(currentTokenDigest, claims.source.tokenDigest)) {
        return { success: false, reason: 'source_unavailable' };
      }
      token = projectToken.token;
    }

    if (upstream.authSurface === 'git') {
      return {
        success: true,
        headers: { authorization: `Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}` },
      };
    }
    if (claims.source.type === 'project') {
      return { success: true, headers: { 'PRIVATE-TOKEN': token } };
    }
    return { success: true, headers: { authorization: `Bearer ${token}` } };
  }

  private getGitLabAuthType(integration: GitLabLookupSuccess): GitLabAuthType | null {
    if (integration.metadata.auth_type) return integration.metadata.auth_type;
    if (integration.integrationType === 'oauth' || integration.integrationType === 'pat') {
      return integration.integrationType;
    }
    return null;
  }

  private getGitLabSessionIdentity(integration: GitLabLookupSuccess): GitLabSessionIdentity | null {
    if (integration.accountId === null && integration.accountLogin === null) return null;
    return { accountId: integration.accountId, accountLogin: integration.accountLogin };
  }
}

export default {
  async fetch(request: Request, env: DisconnectEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== DISCONNECT_PATH) return new Response(null, { status: 404 });
    if (request.method !== 'POST') return new Response(null, { status: 405 });

    const token = extractBearerToken(request.headers.get('Authorization'));
    if (!token) return Response.json({ error: 'unauthorized' }, { status: 401 });

    let secret: string;
    try {
      secret = await resolveSecret(env.NEXTAUTH_SECRET);
    } catch {
      return Response.json({ error: 'authentication_unavailable' }, { status: 503 });
    }
    if (!secret) return Response.json({ error: 'authentication_unavailable' }, { status: 503 });

    let kiloUserId: string;
    try {
      const authorization = await verifyKiloToken(token, secret);
      kiloUserId = authorization.kiloUserId;
    } catch {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }

    try {
      const service = new GitHubUserAuthorizationService(env);
      await service.disconnectUserAuthorization(kiloUserId);
      return Response.json({ disconnected: true });
    } catch {
      return Response.json({ error: 'disconnect_failed' }, { status: 502 });
    }
  },
} satisfies ExportedHandler<DisconnectEnv>;
