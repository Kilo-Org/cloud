import * as z from 'zod';
import {
  isValidGitLabRepositoryUrl,
  matchGitLabRepositoryToIntegration,
  type GitLabLookupService,
  type GitLabRepositoryMatch,
} from './gitlab-lookup-service.js';
import {
  sha256Digest,
  type GitLabCapabilityCredentialSource,
} from './gitlab-session-capability.js';
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
  integrationId: string;
  source: GitLabCapabilityCredentialSource;
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
    | 'invalid_instance_url'
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

type GitLabProjectTokenCandidate = {
  token: string;
  instanceUrl: string;
  integrationId: string;
  projectId: number;
};

type GitLabCandidateEvaluation =
  | { status: 'qualified'; candidate: GitLabProjectTokenCandidate }
  | { status: 'ruled_out' }
  | { status: 'lookup_failed' }
  | { status: 'token_failed'; failure: GetGitLabTokenFailure };

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

async function evaluateGitLabProjectTokenCandidate(
  match: GitLabRepositoryMatch,
  tokenService: Pick<GitLabTokenService, 'getToken'>
): Promise<GitLabCandidateEvaluation> {
  const projectTokens = match.metadata.project_tokens;
  if (!projectTokens || Object.keys(projectTokens).length === 0) {
    return { status: 'ruled_out' };
  }

  const integrationToken = await tokenService.getToken(match.integrationId, match.metadata);
  if (!integrationToken.success) {
    return { status: 'token_failed', failure: integrationToken };
  }

  const projectId = await lookupGitLabProjectId(match, integrationToken.token);
  if (projectId === null) {
    return { status: 'lookup_failed' };
  }

  const projectToken = projectTokens[String(projectId)];
  if (!projectToken) {
    return { status: 'ruled_out' };
  }

  return {
    status: 'qualified',
    candidate: {
      token: projectToken.token,
      instanceUrl: match.instanceUrl,
      integrationId: match.integrationId,
      projectId,
    },
  };
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

    return {
      ...tokenResult,
      glabIsOAuth2: true,
      integrationId: integration.integrationId,
      source: { type: 'integration' },
    };
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

  const evaluations = await Promise.all(
    matches.map(match => evaluateGitLabProjectTokenCandidate(match, dependencies.tokenService))
  );
  const qualifiedCandidates = evaluations.flatMap(evaluation =>
    evaluation.status === 'qualified' ? [evaluation.candidate] : []
  );

  if (qualifiedCandidates.length > 1) {
    return { success: false, reason: 'ambiguous_integration' };
  }

  if (qualifiedCandidates.length === 0) {
    const tokenFailure = evaluations.find(evaluation => evaluation.status === 'token_failed');
    if (tokenFailure?.status === 'token_failed') {
      return tokenFailure.failure;
    }
  }

  if (evaluations.some(evaluation => evaluation.status === 'lookup_failed')) {
    return { success: false, reason: 'project_lookup_failed' };
  }

  const candidate = qualifiedCandidates[0];
  if (!candidate) {
    return { success: false, reason: 'no_project_token' };
  }

  return {
    success: true,
    token: candidate.token,
    instanceUrl: candidate.instanceUrl,
    glabIsOAuth2: false,
    integrationId: candidate.integrationId,
    source: {
      type: 'project',
      projectId: candidate.projectId,
      tokenDigest: await sha256Digest(candidate.token),
    },
  };
}
