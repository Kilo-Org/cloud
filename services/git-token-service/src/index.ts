import { timingSafeEqual } from '@kilocode/encryption';
import {
  BITBUCKET_REPOSITORY_LIST_AUDIENCE,
  extractBearerToken,
  verifyKiloToken,
} from '@kilocode/worker-utils';
import {
  BITBUCKET_CODE_REVIEW_PULL_REQUEST_AUDIENCE,
  BITBUCKET_CODE_REVIEW_WEBHOOK_DELETE_AUDIENCE,
  BITBUCKET_CODE_REVIEW_WEBHOOK_ENSURE_AUDIENCE,
  GITLAB_CREDENTIAL_BROKER_AUDIENCE,
  GITHUB_USER_ACCESS_TOKEN_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
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
import {
  GitLabCredentialBrokerRequestSchema,
  createGitLabCredentialBroker,
  handleGitLabCredentialBrokerRequest,
} from './gitlab-credential-broker-handler.js';
import type { GitLabCredentialBroker } from './gitlab-credential-broker.js';
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
import {
  listBitbucketRepositories,
  resolveBitbucketToken,
  type BitbucketRepositoryListResult,
  type GetBitbucketTokenParams,
  type GetBitbucketTokenResult,
} from './bitbucket-runtime-token-resolver.js';
import {
  BitbucketCodeReviewService,
  BitbucketDeleteWebhookRequestSchema,
  BitbucketEnsureWebhookRequestSchema,
  BitbucketPullRequestRequestSchema,
} from './bitbucket-code-review-service.js';
import {
  KiloSessionCapabilityCodec,
  KiloSessionCapabilityError,
  type KiloSessionCapabilityFailureReason,
  type KiloSessionCapabilitySubject,
} from './kilo-session-capability.js';
import {
  areValidKiloCapabilityTargets,
  classifyKiloCapabilityRequest,
  type KiloCapabilityRouteClass,
} from './kilo-capability-policy.js';

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
export type {
  BitbucketRepositoryListResult,
  GetBitbucketTokenParams,
  GetBitbucketTokenResult,
} from './bitbucket-runtime-token-resolver.js';

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
  | {
      success: false;
      reason:
        | GitLabCloneUrlFailureReason
        | 'integration_identity_missing'
        | 'capability_configuration_error';
    };
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

export type IssueKiloSessionCapabilityParams = KiloSessionCapabilitySubject;
export type IssueKiloSessionCapabilityResult =
  | { success: true; capability: string }
  | { success: false; reason: KiloSessionCapabilityFailureReason | 'invalid_targets' };

export type RedeemKiloSessionCapabilityParams = {
  capability: string;
  outboundContainerId: string;
  requestMethod: string;
  requestUrl: string;
  bootstrapKiloSessionId?: string;
};
export type RedeemKiloSessionCapabilityFailureReason =
  | KiloSessionCapabilityFailureReason
  | 'container_mismatch'
  | 'invalid_upstream_url'
  | 'upstream_not_allowed';
export type RedeemKiloSessionCapabilityResult =
  | { success: true; authorization: string; routeClass: KiloCapabilityRouteClass }
  | { success: false; reason: RedeemKiloSessionCapabilityFailureReason };

const DISCONNECT_PATH = '/internal/github-user-authorizations/disconnect';
const USER_ACCESS_TOKEN_PATH = '/internal/github-user-authorizations/token';
const BITBUCKET_REPOSITORIES_PATH = '/internal/bitbucket/repositories';
const BITBUCKET_CODE_REVIEW_PULL_REQUEST_PATH = '/internal/bitbucket/code-review/pull-request';
const BITBUCKET_CODE_REVIEW_WEBHOOK_ENSURE_PATH = '/internal/bitbucket/code-review/webhooks/ensure';
const BITBUCKET_CODE_REVIEW_WEBHOOK_DELETE_PATH = '/internal/bitbucket/code-review/webhooks/delete';
const GITLAB_CREDENTIAL_BROKER_PATH = '/internal/gitlab/credentials';
const INTERNAL_REQUEST_MAX_BYTES = 16_000;

const BitbucketPullRequestHttpRequestSchema = BitbucketPullRequestRequestSchema.omit({
  owner: true,
});
const BitbucketEnsureWebhookHttpRequestSchema = BitbucketEnsureWebhookRequestSchema.omit({
  owner: true,
});
const BitbucketDeleteWebhookHttpRequestSchema = BitbucketDeleteWebhookRequestSchema.omit({
  owner: true,
});

const UserAccessTokenFetchRequestSchema = z.object({ op: z.literal('fetch') });
const UserAccessTokenRotateRequestSchema = z.object({
  op: z.literal('rotate'),
  staleAuthorizationId: z.string().min(1),
  staleCredentialVersion: z.number().int().nonnegative(),
});
const UserAccessTokenReportRejectedRequestSchema = z.object({
  op: z.literal('reportRejected'),
  authorizationId: z.string().min(1),
  credentialVersion: z.number().int().nonnegative(),
});
const UserAccessTokenRequestSchema = z.union([
  UserAccessTokenFetchRequestSchema,
  UserAccessTokenRotateRequestSchema,
  UserAccessTokenReportRejectedRequestSchema,
]);

const bitbucketCodeReviewAudiences = new Map([
  [BITBUCKET_CODE_REVIEW_PULL_REQUEST_PATH, BITBUCKET_CODE_REVIEW_PULL_REQUEST_AUDIENCE],
  [BITBUCKET_CODE_REVIEW_WEBHOOK_ENSURE_PATH, BITBUCKET_CODE_REVIEW_WEBHOOK_ENSURE_AUDIENCE],
  [BITBUCKET_CODE_REVIEW_WEBHOOK_DELETE_PATH, BITBUCKET_CODE_REVIEW_WEBHOOK_DELETE_AUDIENCE],
]);

type ServiceHttpEnv = CloudflareEnv & {
  NEXTAUTH_SECRET: SecretsStoreSecret | string;
};

async function resolveSecret(secret: SecretsStoreSecret | string): Promise<string> {
  return typeof secret === 'string' ? secret : secret.get();
}

async function readBoundedInternalJsonRequest(request: Request): Promise<unknown> {
  const contentType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json' || !request.body) throw new Error('invalid_request');

  const contentLength = request.headers.get('Content-Length');
  if (contentLength) {
    if (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > INTERNAL_REQUEST_MAX_BYTES) {
      throw new Error('invalid_request');
    }
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) throw new Error('invalid_request');
      totalBytes += chunk.value.byteLength;
      if (totalBytes > INTERNAL_REQUEST_MAX_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The request remains rejected when cancellation itself fails.
        }
        throw new Error('invalid_request');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body));
  } catch {
    throw new Error('invalid_request');
  }
}

function validateGitHubCapabilityUpstream(
  requestUrl: string
): RedeemGitHubSessionCapabilityFailureReason | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return 'invalid_upstream_url';
  }
  if (url.protocol !== 'https:') return 'invalid_upstream_url';
  if (url.username || url.password || url.hash) return 'invalid_upstream_url';
  if (url.port !== '') return 'upstream_host_not_allowed';
  if (!['api.github.com', 'uploads.github.com', 'github.com'].includes(url.hostname)) {
    return 'upstream_host_not_allowed';
  }
  return null;
}

function validateLegacyGitHubCapabilityUpstream(
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

function isGitLabGitAuthPath(pathname: string): boolean {
  return /\.git\/(?:info\/refs|git-upload-pack|git-receive-pack|info\/lfs\/(?:objects\/batch|locks(?:\/verify|\/[^/]+\/unlock)?))$/.test(
    pathname
  );
}

function decodeGitLabPathname(pathname: string): string | null {
  let decoded = pathname;
  for (let depth = 0; depth < 4; depth++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return null;
    }
    if (next === decoded) return decoded;
    decoded = next;
  }
  return null;
}

function validateGitLabCapabilityUpstream(
  requestUrl: string,
  instanceOrigin: string
): { failure: RedeemGitLabSessionCapabilityFailureReason | null; authSurface: 'git' | 'api' } {
  if (/%5c/i.test(requestUrl) || /\/(?:(?:\.|%2e){1,2})(?:\/|$)/i.test(requestUrl)) {
    return { failure: 'invalid_upstream_url', authSurface: 'git' };
  }
  const base = parseGitLabBaseUrl(instanceOrigin);
  if (!base) return { failure: 'invalid_upstream_url', authSurface: 'git' };
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { failure: 'invalid_upstream_url', authSurface: 'git' };
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    return { failure: 'invalid_upstream_url', authSurface: 'git' };
  }
  if (url.origin !== base.origin) {
    return { failure: 'upstream_origin_not_allowed', authSurface: 'git' };
  }
  const decodedPathname = decodeGitLabPathname(url.pathname);
  if (
    decodedPathname === null ||
    decodedPathname.includes('\\') ||
    /(?:^|\/)\.{1,2}(?:\/|$)/.test(decodedPathname)
  ) {
    return { failure: 'invalid_upstream_url', authSurface: 'git' };
  }
  if (
    base.basePath !== '' &&
    url.pathname !== base.basePath &&
    !url.pathname.startsWith(`${base.basePath}/`)
  ) {
    return { failure: 'upstream_origin_not_allowed', authSurface: 'git' };
  }
  const apiV4Prefix = `${base.basePath}/api/v4`;
  const authSurface =
    !isGitLabGitAuthPath(url.pathname) &&
    (url.pathname === apiV4Prefix ||
      url.pathname.startsWith(`${apiV4Prefix}/`) ||
      url.pathname === `${base.basePath}/api/graphql`)
      ? 'api'
      : 'git';
  return { failure: null, authSurface };
}

function validateLegacyGitLabCapabilityUpstream(
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
  private gitlabCredentialResolver: GitLabCredentialBroker;
  private githubUserAuthorizationService: GitHubUserAuthorizationService;

  constructor(ctx: ExecutionContext, env: CloudflareEnv) {
    super(ctx, env);
    this.githubService = new GitHubTokenService(env);
    this.installationLookupService = new InstallationLookupService(env);
    this.gitlabLookupService = new GitLabLookupService(env);
    this.gitlabCredentialResolver = createGitLabCredentialBroker(env);
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

    const upstreamFailure =
      claims.version === 2
        ? validateGitHubCapabilityUpstream(params.requestUrl)
        : validateLegacyGitHubCapabilityUpstream(params.requestMethod, params.requestUrl, claims);
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
      credentialResolver: this.gitlabCredentialResolver,
    });
  }

  async getBitbucketToken(params: GetBitbucketTokenParams): Promise<GetBitbucketTokenResult> {
    if (!params.orgId) return { success: false, reason: 'invalid_request' };
    const result = await resolveBitbucketToken(this.env, params);
    return result.success ? { success: true, token: result.token } : result;
  }

  async issueGitLabSessionCapability(
    params: IssueGitLabSessionCapabilityParams
  ): Promise<IssueGitLabSessionCapabilityResult> {
    const runtimeToken = await resolveGitLabRuntimeToken(
      { ...params, repositoryUrl: params.gitUrl },
      {
        lookupService: this.gitlabLookupService,
        credentialResolver: this.gitlabCredentialResolver,
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
    if (!identity) return { success: false, reason: 'integration_identity_missing' };

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

    const upstream =
      claims.version === 2
        ? validateGitLabCapabilityUpstream(params.requestUrl, claims.instanceOrigin)
        : validateLegacyGitLabCapabilityUpstream(params.requestMethod, params.requestUrl, claims);
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

    const selector =
      claims.source.type === 'integration'
        ? ({ credential: 'integration', integrationId: claims.integrationId } as const)
        : ({
            credential: 'project-exact',
            integrationId: claims.integrationId,
            projectId: String(claims.source.projectId),
          } as const);
    const credential = await this.gitlabCredentialResolver.resolveCredential(context, selector);
    if (
      credential.status !== 'available' ||
      credential.source.type !== claims.source.type ||
      ('credentialId' in claims.source && credential.credentialId !== claims.source.credentialId) ||
      ('credentialVersion' in claims.source &&
        credential.credentialVersion !== claims.source.credentialVersion)
    ) {
      return { success: false, reason: 'source_unavailable' };
    }
    if ('tokenDigest' in claims.source) {
      const currentTokenDigest = await sha256Digest(credential.token);
      if (!timingSafeEqual(currentTokenDigest, claims.source.tokenDigest)) {
        return { success: false, reason: 'source_unavailable' };
      }
    }
    const token = credential.token;

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

  async issueKiloSessionCapability(
    params: IssueKiloSessionCapabilityParams
  ): Promise<IssueKiloSessionCapabilityResult> {
    if (!areValidKiloCapabilityTargets(params.targets)) {
      return { success: false, reason: 'invalid_targets' };
    }

    try {
      const encryptionKey = await resolveSecret(this.env.SCM_SESSION_CAPABILITY_ENCRYPTION_KEY);
      const capability = new KiloSessionCapabilityCodec(encryptionKey).issue(params);
      return { success: true, capability };
    } catch (error) {
      if (error instanceof KiloSessionCapabilityError) {
        return { success: false, reason: error.reason };
      }
      return { success: false, reason: 'capability_configuration_error' };
    }
  }

  async redeemKiloSessionCapability(
    params: RedeemKiloSessionCapabilityParams
  ): Promise<RedeemKiloSessionCapabilityResult> {
    let claims;
    try {
      const encryptionKey = await resolveSecret(this.env.SCM_SESSION_CAPABILITY_ENCRYPTION_KEY);
      claims = new KiloSessionCapabilityCodec(encryptionKey).decode(params.capability);
    } catch (error) {
      if (error instanceof KiloSessionCapabilityError) {
        return { success: false, reason: error.reason };
      }
      return { success: false, reason: 'capability_configuration_error' };
    }

    if (claims.outboundContainerId !== params.outboundContainerId) {
      return { success: false, reason: 'container_mismatch' };
    }

    const classification = classifyKiloCapabilityRequest(
      params.requestUrl,
      claims.targets,
      claims.kiloSessionId,
      {
        requestMethod: params.requestMethod,
        bootstrapKiloSessionId: params.bootstrapKiloSessionId,
      }
    );
    if (!classification.success) {
      return { success: false, reason: classification.reason };
    }

    return {
      success: true,
      authorization: `Bearer ${claims.userToken}`,
      routeClass: classification.routeClass,
    };
  }

  private getGitLabAuthType(integration: GitLabLookupSuccess): GitLabAuthType | null {
    if (integration.integrationType === 'oauth' || integration.integrationType === 'pat') {
      return integration.integrationType;
    }
    return integration.metadata.auth_type ?? null;
  }

  private getGitLabSessionIdentity(integration: GitLabLookupSuccess): GitLabSessionIdentity | null {
    if (integration.accountId === null && integration.accountLogin === null) return null;
    return { accountId: integration.accountId, accountLogin: integration.accountLogin };
  }
}

export default {
  async fetch(request: Request, env: ServiceHttpEnv): Promise<Response> {
    const url = new URL(request.url);
    const isGitLabCredentialBroker = url.pathname === GITLAB_CREDENTIAL_BROKER_PATH;
    // Credential-bearing endpoints must never be cached, including on their
    // shared early-return error paths (405/401/503). The GitHub user-access
    // token endpoint joins the GitLab private endpoints here.
    const privateNoStoreHeaders =
      isGitLabCredentialBroker || url.pathname === USER_ACCESS_TOKEN_PATH
        ? { 'Cache-Control': 'no-store' }
        : undefined;
    const codeReviewAudience = bitbucketCodeReviewAudiences.get(url.pathname);
    if (
      url.pathname !== DISCONNECT_PATH &&
      url.pathname !== USER_ACCESS_TOKEN_PATH &&
      url.pathname !== BITBUCKET_REPOSITORIES_PATH &&
      url.pathname !== GITLAB_CREDENTIAL_BROKER_PATH &&
      !codeReviewAudience
    ) {
      return new Response(null, { status: 404 });
    }
    if (request.method !== 'POST') {
      return new Response(null, { status: 405, headers: privateNoStoreHeaders });
    }

    const token = extractBearerToken(request.headers.get('Authorization'));
    if (!token) {
      return Response.json(
        { error: 'unauthorized' },
        { status: 401, headers: privateNoStoreHeaders }
      );
    }

    let secret: string;
    try {
      secret = await resolveSecret(env.NEXTAUTH_SECRET);
    } catch {
      return Response.json(
        { error: 'authentication_unavailable' },
        { status: 503, headers: privateNoStoreHeaders }
      );
    }
    if (!secret) {
      return Response.json(
        { error: 'authentication_unavailable' },
        { status: 503, headers: privateNoStoreHeaders }
      );
    }

    let authorization: Awaited<ReturnType<typeof verifyKiloToken>>;
    try {
      const audience =
        url.pathname === BITBUCKET_REPOSITORIES_PATH
          ? BITBUCKET_REPOSITORY_LIST_AUDIENCE
          : url.pathname === GITLAB_CREDENTIAL_BROKER_PATH
            ? GITLAB_CREDENTIAL_BROKER_AUDIENCE
            : url.pathname === USER_ACCESS_TOKEN_PATH
              ? GITHUB_USER_ACCESS_TOKEN_AUDIENCE
              : codeReviewAudience;
      authorization = await verifyKiloToken(token, secret, audience ? { audience } : undefined);
    } catch {
      return Response.json(
        { error: 'unauthorized' },
        { status: 401, headers: privateNoStoreHeaders }
      );
    }

    if (url.pathname === BITBUCKET_REPOSITORIES_PATH) {
      if (!authorization.organizationId) {
        return Response.json({ error: 'organization_required' }, { status: 403 });
      }
      try {
        const result: BitbucketRepositoryListResult = await listBitbucketRepositories(env, {
          userId: authorization.kiloUserId,
          orgId: authorization.organizationId,
        });
        return Response.json(result);
      } catch {
        return Response.json({ status: 'temporarily_unavailable' });
      }
    }

    if (url.pathname === GITLAB_CREDENTIAL_BROKER_PATH) {
      let body: unknown;
      try {
        body = await readBoundedInternalJsonRequest(request);
      } catch {
        return Response.json(
          { status: 'invalid_request' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }
      const parsed = GitLabCredentialBrokerRequestSchema.safeParse(body);
      if (!parsed.success) {
        return Response.json(
          { status: 'invalid_request' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }
      try {
        const result = await handleGitLabCredentialBrokerRequest(
          env,
          {
            userId: authorization.kiloUserId,
            ...(authorization.organizationId ? { orgId: authorization.organizationId } : {}),
          },
          parsed.data
        );
        return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
      } catch {
        return Response.json(
          { status: 'temporarily_unavailable' },
          { headers: { 'Cache-Control': 'no-store' } }
        );
      }
    }

    if (codeReviewAudience) {
      if (!authorization.organizationId) {
        return Response.json({ error: 'organization_required' }, { status: 403 });
      }
      let body: unknown;
      try {
        body = await readBoundedInternalJsonRequest(request);
      } catch {
        return Response.json({ success: false, reason: 'invalid_request' }, { status: 400 });
      }
      const owner = {
        userId: authorization.kiloUserId,
        orgId: authorization.organizationId,
      };
      const service = new BitbucketCodeReviewService(env);

      try {
        switch (url.pathname) {
          case BITBUCKET_CODE_REVIEW_PULL_REQUEST_PATH: {
            const parsed = BitbucketPullRequestHttpRequestSchema.safeParse(body);
            if (!parsed.success) {
              return Response.json({ success: false, reason: 'invalid_request' }, { status: 400 });
            }
            return Response.json(await service.getPullRequest({ owner, ...parsed.data }));
          }
          case BITBUCKET_CODE_REVIEW_WEBHOOK_ENSURE_PATH: {
            const parsed = BitbucketEnsureWebhookHttpRequestSchema.safeParse(body);
            if (!parsed.success) {
              return Response.json({ success: false, reason: 'invalid_request' }, { status: 400 });
            }
            return Response.json(await service.ensureWorkspaceWebhook({ owner, ...parsed.data }));
          }
          case BITBUCKET_CODE_REVIEW_WEBHOOK_DELETE_PATH: {
            const parsed = BitbucketDeleteWebhookHttpRequestSchema.safeParse(body);
            if (!parsed.success) {
              return Response.json({ success: false, reason: 'invalid_request' }, { status: 400 });
            }
            return Response.json(await service.deleteWorkspaceWebhooks({ owner, ...parsed.data }));
          }
          default:
            return new Response(null, { status: 404 });
        }
      } catch {
        return Response.json({ success: false, reason: 'temporarily_unavailable' });
      }
    }

    if (url.pathname === USER_ACCESS_TOKEN_PATH) {
      let body: unknown;
      try {
        body = await readBoundedInternalJsonRequest(request);
      } catch {
        return Response.json(
          { error: 'invalid_request' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }
      const parsed = UserAccessTokenRequestSchema.safeParse(body);
      if (!parsed.success) {
        return Response.json(
          { error: 'invalid_request' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }
      try {
        const service = new GitHubUserAuthorizationService(env);
        const result = await service.getUserAccessToken(authorization.kiloUserId, parsed.data);
        return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
      } catch (error) {
        if (error instanceof Error && error.message === 'temporarily_unavailable') {
          return Response.json(
            { error: 'temporarily_unavailable' },
            { status: 503, headers: { 'Cache-Control': 'no-store' } }
          );
        }
        return Response.json(
          { error: 'temporarily_unavailable' },
          { status: 503, headers: { 'Cache-Control': 'no-store' } }
        );
      }
    }

    try {
      const service = new GitHubUserAuthorizationService(env);
      await service.disconnectUserAuthorization(authorization.kiloUserId);
      return Response.json({ disconnected: true });
    } catch {
      return Response.json({ error: 'disconnect_failed' }, { status: 502 });
    }
  },
} satisfies ExportedHandler<ServiceHttpEnv>;
