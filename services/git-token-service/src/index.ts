import { WorkerEntrypoint } from 'cloudflare:workers';
import { GitHubTokenService, type GitHubAppType } from './github-token-service.js';
import { GitLabLookupService } from './gitlab-lookup-service.js';
import { GitLabTokenService } from './gitlab-token-service.js';
import { InstallationLookupService } from './installation-lookup-service.js';

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
    | 'invalid_org_id';
};

export type GetTokenForRepoResult = GetTokenForRepoSuccess | GetTokenForRepoFailure;

export type GetGitLabTokenParams = {
  userId: string;
  orgId?: string;
};

export type GetGitLabTokenSuccess = {
  success: true;
  token: string;
  instanceUrl: string;
};

export type GetGitLabTokenFailure = {
  success: false;
  reason:
    | 'database_not_configured'
    | 'no_integration_found'
    | 'invalid_org_id'
    | 'no_token'
    | 'token_refresh_failed'
    | 'token_expired_no_refresh';
};

export type GetGitLabTokenResult = GetGitLabTokenSuccess | GetGitLabTokenFailure;

export class GitTokenRPCEntrypoint extends WorkerEntrypoint<CloudflareEnv> {
  private githubService: GitHubTokenService;
  private installationLookupService: InstallationLookupService;
  private gitlabLookupService: GitLabLookupService;
  private gitlabTokenService: GitLabTokenService;

  constructor(ctx: ExecutionContext, env: CloudflareEnv) {
    super(ctx, env);
    this.githubService = new GitHubTokenService(env);
    this.installationLookupService = new InstallationLookupService(env);
    this.gitlabLookupService = new GitLabLookupService(env);
    this.gitlabTokenService = new GitLabTokenService(env);
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
   * Get a GitLab token for the user/org.
   *
   * Looks up the GitLab integration and returns a valid access token,
   * refreshing OAuth tokens if needed.
   *
   * @param params - The user and optional org context
   * @returns Token and instance URL, or a failure reason
   */
  async getGitLabToken(params: GetGitLabTokenParams): Promise<GetGitLabTokenResult> {
    const integration = await this.gitlabLookupService.findGitLabIntegration(params);
    if (!integration.success) {
      return integration;
    }

    return this.gitlabTokenService.getToken(integration.integrationId, integration.metadata);
  }
}

export default {
  // Cloudflare requires a fetch handler to deploy, even for RPC-only workers
  fetch() {
    return new Response(null, { status: 404 });
  },
};
