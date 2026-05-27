import * as z from 'zod';
import {
  isValidGitLabRepositoryUrl,
  matchGitLabRepositoryToIntegration,
  type GitLabLookupService,
  type GitLabRepositoryMatch,
} from './gitlab-lookup-service.js';
import type { GitLabTokenService } from './gitlab-token-service.js';

export type GetGitLabTokenParams = {
  userId: string;
  orgId?: string;
  repositoryUrl?: string;
  createdOnPlatform?: string;
};

export type GetGitLabTokenSuccess = {
  success: true;
  token: string;
  instanceUrl: string;
  glabIsOAuth2: boolean;
};

export type GetGitLabTokenFailure = {
  success: false;
  reason:
    | 'database_not_configured'
    | 'no_integration_found'
    | 'invalid_org_id'
    | 'no_token'
    | 'token_refresh_failed'
    | 'token_expired_no_refresh'
    | 'repository_url_required'
    | 'invalid_repository_url'
    | 'no_matching_integration'
    | 'ambiguous_integration'
    | 'project_lookup_failed'
    | 'no_project_token';
};

export type GetGitLabTokenResult = GetGitLabTokenSuccess | GetGitLabTokenFailure;

type GitLabRuntimeTokenDependencies = {
  lookupService: Pick<
    GitLabLookupService,
    'findGitLabIntegration' | 'findAuthorizedGitLabIntegrations'
  >;
  tokenService: Pick<GitLabTokenService, 'getToken'>;
};

const GitLabProjectIdentitySchema = z.object({
  id: z.number().int().positive(),
});

async function lookupGitLabProjectId(
  match: GitLabRepositoryMatch,
  integrationToken: string
): Promise<number | null> {
  try {
    const response = await fetch(
      `${match.instanceUrl}/api/v4/projects/${encodeURIComponent(match.projectPath)}`,
      { headers: { Authorization: `Bearer ${integrationToken}` } }
    );
    if (!response.ok) {
      return null;
    }

    const parsed = GitLabProjectIdentitySchema.safeParse(await response.json());
    return parsed.success ? parsed.data.id : null;
  } catch {
    return null;
  }
}

export async function resolveGitLabRuntimeToken(
  params: GetGitLabTokenParams,
  dependencies: GitLabRuntimeTokenDependencies
): Promise<GetGitLabTokenResult> {
  if (params.createdOnPlatform !== 'code-review') {
    const integration = await dependencies.lookupService.findGitLabIntegration(params);
    if (!integration.success) {
      return integration;
    }

    const tokenResult = await dependencies.tokenService.getToken(
      integration.integrationId,
      integration.metadata
    );
    if (!tokenResult.success) {
      return tokenResult;
    }

    return { ...tokenResult, glabIsOAuth2: true };
  }

  if (!params.repositoryUrl) {
    return { success: false, reason: 'repository_url_required' };
  }
  const repositoryUrl = params.repositoryUrl;
  if (!isValidGitLabRepositoryUrl(repositoryUrl)) {
    return { success: false, reason: 'invalid_repository_url' };
  }

  const authorizedIntegrations =
    await dependencies.lookupService.findAuthorizedGitLabIntegrations(params);
  if (!authorizedIntegrations.success) {
    return authorizedIntegrations;
  }

  const matches = authorizedIntegrations.integrations
    .map(integration => matchGitLabRepositoryToIntegration(repositoryUrl, integration))
    .filter((match): match is GitLabRepositoryMatch => match !== null);

  if (matches.length === 0) {
    return { success: false, reason: 'no_matching_integration' };
  }
  if (matches.length !== 1) {
    return { success: false, reason: 'ambiguous_integration' };
  }

  const match = matches[0];
  const integrationToken = await dependencies.tokenService.getToken(
    match.integrationId,
    match.metadata
  );
  if (!integrationToken.success) {
    return integrationToken;
  }

  const projectId = await lookupGitLabProjectId(match, integrationToken.token);
  if (projectId === null) {
    return { success: false, reason: 'project_lookup_failed' };
  }

  const projectToken = match.metadata.project_tokens?.[String(projectId)];
  if (!projectToken) {
    return { success: false, reason: 'no_project_token' };
  }

  return {
    success: true,
    token: projectToken.token,
    instanceUrl: match.instanceUrl,
    glabIsOAuth2: false,
  };
}
