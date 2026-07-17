import * as z from 'zod';
import type { GitLabCredentialBroker } from './gitlab-credential-broker.js';
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

type GitLabCredentialResolver = Pick<GitLabCredentialBroker, 'resolveCredential'> & {
  hasProjectCredentialCandidates?(
    actor: { userId: string; orgId?: string },
    integrationId: string
  ): Promise<boolean>;
};

type GitLabRuntimeTokenDependencies = {
  lookupService: Pick<
    GitLabLookupService,
    'findGitLabIntegration' | 'findAuthorizedGitLabIntegrations'
  >;
  credentialResolver: GitLabCredentialResolver;
};

type GitLabProjectTokenCandidate = {
  token: string;
  instanceUrl: string;
  integrationId: string;
  projectId: number;
  credentialId?: string;
  credentialVersion?: number;
};

type GitLabCandidateEvaluation =
  | { status: 'qualified'; candidate: GitLabProjectTokenCandidate }
  | { status: 'ruled_out' }
  | { status: 'lookup_failed' }
  | { status: 'token_failed'; failure: GetGitLabTokenFailure };

const GitLabProjectIdentitySchema = z.object({ id: z.number().int().positive() }).strict();
const MAX_PROJECT_LOOKUP_RESPONSE_BYTES = 16_000;

function mapCredentialFailure(status: string, project = false): GetGitLabTokenFailure {
  return {
    success: false,
    reason:
      status === 'temporarily_unavailable'
        ? 'token_refresh_failed'
        : status === 'invalid_request'
          ? 'invalid_org_id'
          : project
            ? 'no_project_token'
            : 'no_token',
  };
}

async function readBoundedProjectIdentity(response: Response): Promise<number | null> {
  if (!response.body) return null;
  const contentLength = response.headers.get('Content-Length');
  if (
    contentLength &&
    (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > MAX_PROJECT_LOOKUP_RESPONSE_BYTES)
  ) {
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) return null;
      total += value.byteLength;
      if (total > MAX_PROJECT_LOOKUP_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = GitLabProjectIdentitySchema.safeParse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body))
    );
    return parsed.success ? parsed.data.id : null;
  } catch {
    return null;
  }
}

async function lookupGitLabProjectId(
  match: GitLabRepositoryMatch,
  integrationToken: string
): Promise<number | null> {
  try {
    const response = await fetch(
      `${match.instanceUrl}/api/v4/projects/${encodeURIComponent(match.projectPath)}`,
      {
        redirect: 'manual',
        headers: { Authorization: `Bearer ${integrationToken}` },
      }
    );
    return response.ok ? readBoundedProjectIdentity(response) : null;
  } catch {
    return null;
  }
}

async function evaluateGitLabProjectTokenCandidate(
  params: GetGitLabTokenParams,
  match: GitLabRepositoryMatch,
  resolver: GitLabCredentialResolver
): Promise<GitLabCandidateEvaluation> {
  if (
    (!match.metadata.project_tokens || Object.keys(match.metadata.project_tokens).length === 0) &&
    resolver.hasProjectCredentialCandidates
  ) {
    try {
      if (!(await resolver.hasProjectCredentialCandidates(params, match.integrationId))) {
        return { status: 'ruled_out' };
      }
    } catch {
      return {
        status: 'token_failed',
        failure: { success: false, reason: 'token_refresh_failed' },
      };
    }
  }

  const integrationCredential = await resolver.resolveCredential(params, {
    credential: 'integration',
    integrationId: match.integrationId,
  });
  if (integrationCredential.status !== 'available') {
    return { status: 'token_failed', failure: mapCredentialFailure(integrationCredential.status) };
  }
  if (integrationCredential.instanceUrl !== match.instanceUrl) return { status: 'ruled_out' };

  const projectId = await lookupGitLabProjectId(match, integrationCredential.token);
  if (projectId === null) return { status: 'lookup_failed' };

  const projectCredential = await resolver.resolveCredential(params, {
    credential: 'project-exact',
    integrationId: match.integrationId,
    projectId: String(projectId),
  });
  if (projectCredential.status !== 'available') {
    return projectCredential.status === 'not_connected'
      ? { status: 'ruled_out' }
      : { status: 'token_failed', failure: mapCredentialFailure(projectCredential.status, true) };
  }
  return {
    status: 'qualified',
    candidate: {
      token: projectCredential.token,
      instanceUrl: projectCredential.instanceUrl,
      integrationId: projectCredential.integrationId,
      projectId,
      ...(projectCredential.credentialId
        ? {
            credentialId: projectCredential.credentialId,
            credentialVersion: projectCredential.credentialVersion,
          }
        : {}),
    },
  };
}

function integrationSource(input: {
  glabIsOAuth2: boolean;
  credentialId?: string;
  credentialVersion?: number;
}): GitLabCapabilityCredentialSource {
  if (!input.credentialId) return { type: 'integration' };
  if (input.glabIsOAuth2) return { type: 'integration', credentialId: input.credentialId };
  if (!input.credentialVersion) throw new Error('PAT credential version is missing');
  return {
    type: 'integration',
    credentialId: input.credentialId,
    credentialVersion: input.credentialVersion,
  };
}

export async function resolveGitLabRuntimeToken(
  params: GetGitLabTokenParams,
  dependencies: GitLabRuntimeTokenDependencies
): Promise<GetGitLabTokenResult> {
  if (params.createdOnPlatform !== 'code-review') {
    const integration = await dependencies.lookupService.findGitLabIntegration(params);
    if (!integration.success) return integration;
    const credential = await dependencies.credentialResolver.resolveCredential(params, {
      credential: 'integration',
      integrationId: integration.integrationId,
    });
    if (credential.status !== 'available') return mapCredentialFailure(credential.status);
    return {
      success: true,
      token: credential.token,
      instanceUrl: credential.instanceUrl,
      glabIsOAuth2: credential.glabIsOAuth2,
      integrationId: credential.integrationId,
      source: integrationSource(credential),
    };
  }

  const repositoryUrl = params.repositoryUrl;
  if (!repositoryUrl) return { success: false, reason: 'repository_url_required' };
  if (!isValidGitLabRepositoryUrl(repositoryUrl)) {
    return { success: false, reason: 'invalid_repository_url' };
  }
  const authorized = await dependencies.lookupService.findAuthorizedGitLabIntegrations(params);
  if (!authorized.success) return authorized;
  const matches = authorized.integrations
    .map(integration => matchGitLabRepositoryToIntegration(repositoryUrl, integration))
    .filter((match): match is GitLabRepositoryMatch => match !== null);
  if (matches.length === 0) return { success: false, reason: 'no_matching_integration' };

  const evaluations = await Promise.all(
    matches.map(match =>
      evaluateGitLabProjectTokenCandidate(params, match, dependencies.credentialResolver)
    )
  );
  const qualified = evaluations.flatMap(evaluation =>
    evaluation.status === 'qualified' ? [evaluation.candidate] : []
  );
  if (qualified.length > 1) return { success: false, reason: 'ambiguous_integration' };
  if (qualified.length === 0) {
    const tokenFailure = evaluations.find(evaluation => evaluation.status === 'token_failed');
    if (tokenFailure?.status === 'token_failed') return tokenFailure.failure;
  }
  if (evaluations.some(evaluation => evaluation.status === 'lookup_failed')) {
    return { success: false, reason: 'project_lookup_failed' };
  }
  const candidate = qualified[0];
  if (!candidate) return { success: false, reason: 'no_project_token' };

  const source: GitLabCapabilityCredentialSource =
    candidate.credentialId && candidate.credentialVersion
      ? {
          type: 'project',
          projectId: candidate.projectId,
          credentialId: candidate.credentialId,
          credentialVersion: candidate.credentialVersion,
        }
      : {
          type: 'project',
          projectId: candidate.projectId,
          tokenDigest: await sha256Digest(candidate.token),
        };
  return {
    success: true,
    token: candidate.token,
    instanceUrl: candidate.instanceUrl,
    glabIsOAuth2: false,
    integrationId: candidate.integrationId,
    source,
  };
}
