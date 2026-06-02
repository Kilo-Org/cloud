import { extractBearerToken, verifyKiloToken } from '@kilocode/worker-utils';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { GitHubTokenService, type GitHubAppType } from './github-token-service.js';
import { GitLabLookupService } from './gitlab-lookup-service.js';
import {
  resolveGitLabRuntimeToken,
  type GetGitLabTokenParams,
  type GetGitLabTokenResult,
} from './gitlab-runtime-token-resolver.js';
import { GitLabTokenService } from './gitlab-token-service.js';
import { InstallationLookupService } from './installation-lookup-service.js';
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

const DISCONNECT_PATH = '/internal/github-user-authorizations/disconnect';

type DisconnectEnv = CloudflareEnv & {
  NEXTAUTH_SECRET: SecretsStoreSecret | string;
};

async function resolveJwtSecret(secret: SecretsStoreSecret | string): Promise<string> {
  return typeof secret === 'string' ? secret : secret.get();
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
      secret = await resolveJwtSecret(env.NEXTAUTH_SECRET);
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
