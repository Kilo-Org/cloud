import type {
  GitHubSessionCapabilityClaims,
  GitHubSessionIdentity,
} from './github-session-capability.js';
import type { GitHubUserAuthorizationService } from './github-user-authorization-service.js';
import type {
  GetCloudAgentAuthForRepoParams,
  GetCloudAgentAuthForRepoResult,
  GetCloudAgentAuthForRepoSuccess,
  RedeemGitHubSessionCapabilityParams,
  RedeemGitHubSessionCapabilityResult,
} from './index.js';
import { validateLegacyGitHubRequest } from './github-legacy-policy.js';
import { z } from 'zod';
import { readBoundedJsonBody } from './lib/bounded-read.js';

const GITHUB_REPOSITORY_METADATA_MAX_BYTES = 64 * 1024;
const GITHUB_REPOSITORY_METADATA_TIMEOUT_MS = 10_000;
const GitHubRepositoryMetadataSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  full_name: z.string().min(1),
});

export async function verifyLegacyGitHubRepositoryId(
  owner: string,
  repo: string,
  expectedRepositoryId: number,
  token: string
): Promise<'source_unavailable' | 'repository_mismatch' | null> {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'Kilo-Git-Token-Service',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(GITHUB_REPOSITORY_METADATA_TIMEOUT_MS),
    });
  } catch {
    return 'source_unavailable';
  }
  let body: unknown;
  try {
    if (response.status !== 200) {
      await response.body?.cancel();
      return 'source_unavailable';
    }
    if (!response.body) return 'source_unavailable';
    body = await readBoundedJsonBody(response.body, GITHUB_REPOSITORY_METADATA_MAX_BYTES);
  } catch {
    return 'source_unavailable';
  }

  const parsed = GitHubRepositoryMetadataSchema.safeParse(body);
  if (!parsed.success) return 'source_unavailable';
  if (
    parsed.data.id !== expectedRepositoryId ||
    parsed.data.full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase()
  ) {
    return 'repository_mismatch';
  }
  return null;
}

type LegacyAuthorizationDeps = {
  resolveAuth: (params: GetCloudAgentAuthForRepoParams) => Promise<GetCloudAgentAuthForRepoResult>;
  resolveUserAuth: (
    params: GetCloudAgentAuthForRepoParams & { strictRepositoryLookup?: true }
  ) => Promise<GetCloudAgentAuthForRepoResult | null>;
  selectUserAuthorization: GitHubUserAuthorizationService['selectUserAuthorization'];
  matchesIdentity: (
    identity: GitHubSessionIdentity,
    auth: GetCloudAgentAuthForRepoSuccess
  ) => boolean;
  formatAuthorization: (url: string, token: string) => string;
};

/** Retains the authorization policy of existing container-bound workspaces. */
export async function redeemLegacyGitHubCapability(
  params: RedeemGitHubSessionCapabilityParams,
  claims: Extract<GitHubSessionCapabilityClaims, { version: 2 }>,
  deps: LegacyAuthorizationDeps
): Promise<RedeemGitHubSessionCapabilityResult> {
  const upstream = validateLegacyGitHubRequest(params.requestMethod, params.requestUrl, claims);
  if (upstream.failure) return { success: false, reason: upstream.failure };

  const authParams = {
    userId: claims.userId,
    ...(claims.permissionScope ? { permissionScope: claims.permissionScope } : {}),
    accessPurpose: claims.accessPurpose ?? 'workflow',
    ...(claims.orgId !== undefined ? { orgId: claims.orgId } : {}),
    ...(claims.integrationId !== undefined ? { expectedIntegrationId: claims.integrationId } : {}),
    githubRepo: `${claims.owner}/${claims.repo}`,
  };
  if (upstream.credential === 'none') {
    return {
      success: true,
      authorization: null,
      installationId: claims.identity.installationId,
      source: claims.source,
      appType: claims.identity.appType,
    };
  }

  let auth: GetCloudAgentAuthForRepoResult | null;
  if (claims.source === 'user') {
    try {
      auth = await deps.resolveUserAuth({
        ...authParams,
        ...(upstream.credential === 'user' ? { strictRepositoryLookup: true } : {}),
      });
    } catch (error) {
      if (upstream.credential === 'user') return { success: false, reason: 'source_unavailable' };
      throw error;
    }
  } else {
    try {
      auth = await deps.resolveAuth(authParams);
    } catch {
      return { success: false, reason: 'source_unavailable' };
    }
  }
  if (auth && !auth.success && auth.reason === 'integration_mismatch') {
    return { success: false, reason: 'integration_mismatch' };
  }
  if (auth && !auth.success && auth.reason === 'repository_permissions_unavailable') {
    return { success: false, reason: 'repository_permissions_unavailable' };
  }
  if (!auth || !auth.success || auth.source !== claims.source) {
    return { success: false, reason: 'source_unavailable' };
  }
  if (!deps.matchesIdentity(claims.identity, auth)) {
    return { success: false, reason: 'identity_mismatch' };
  }

  let token = auth.githubToken;
  let source = auth.source;
  // GitHub user attachments reject installation tokens, even with repository write access.
  if (upstream.credential === 'user' && source !== 'user') {
    try {
      const selection = await deps.selectUserAuthorization({
        ...authParams,
        strictRepositoryLookup: true,
      });
      if (!selection.selected) return { success: false, reason: 'source_unavailable' };
      token = selection.token;
      source = 'user';
    } catch {
      return { success: false, reason: 'source_unavailable' };
    }
  }
  if (upstream.repositoryId !== undefined) {
    const repositoryFailure = await verifyLegacyGitHubRepositoryId(
      claims.owner,
      claims.repo,
      upstream.repositoryId,
      token
    );
    if (repositoryFailure !== null) return { success: false, reason: repositoryFailure };
  }
  return {
    success: true,
    authorization: deps.formatAuthorization(params.requestUrl, token),
    installationId: auth.installationId,
    source,
    appType: auth.appType,
  };
}
