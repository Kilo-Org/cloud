import { WorkerEntrypoint } from 'cloudflare:workers';
import { GitHubTokenService, type GitHubAppType } from './github-token-service.js';
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

export class GitTokenRPCEntrypoint extends WorkerEntrypoint<CloudflareEnv> {
  private githubService: GitHubTokenService;
  private installationLookupService: InstallationLookupService;

  constructor(ctx: ExecutionContext, env: CloudflareEnv) {
    super(ctx, env);
    this.githubService = new GitHubTokenService(env);
    this.installationLookupService = new InstallationLookupService(env);
  }

  /**
   * Get a GitHub token for a repository.
   *
   * This is the main entry point - it handles the full flow:
   * 1. Looks up the GitHub App installation for this repo/user
   * 2. Validates the user has access (via org membership if applicable)
   * 3. Generates an installation access token
   *
   * @param params - The repo and user context
   * @returns Token and installation details, or a failure reason
   */
  async getTokenForRepo(params: GetTokenForRepoParams): Promise<GetTokenForRepoResult> {
    // 1. Look up installation
    const installation = await this.installationLookupService.findInstallationId(params);
    if (!installation.success) {
      return installation;
    }

    // 2. Generate token for the installation (not scoped to specific repo)
    const token = await this.githubService.getToken(
      installation.installationId,
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
}

export default {
  // Cloudflare requires a fetch handler to deploy, even for RPC-only workers
  fetch() {
    return new Response(null, { status: 404 });
  },
};
