import { Buffer } from 'node:buffer';
import type {
  WorkspaceRepositoryAccess,
  WorkspaceGitHubRepositoryAccess,
} from '@kilocode/worker-utils/workspace-repository-access';
import type { GitHubTaskGrant } from '@kilocode/worker-utils/github-task-grant';
import type {
  RedeemGitHubSessionCapabilityParams,
  RedeemGitHubSessionCapabilityResult,
  GetCloudAgentAuthForRepoParams,
  GetCloudAgentAuthForRepoResult,
} from './index.js';
import { authorizeGitHubTaskRequest } from './github-task-policy.js';
import { authorizeGitHubTaskCredential } from './github-task-authorization.js';
import { GitHubTaskResources, GitHubTaskResourceError } from './github-task-resources.js';
import type { GitHubTokenService } from './github-token-service.js';

function sameIdentity(
  left: WorkspaceGitHubRepositoryAccess,
  right: WorkspaceGitHubRepositoryAccess
) {
  return (
    left.owner === right.owner &&
    left.integrationId === right.integrationId &&
    JSON.stringify(left.identity) === JSON.stringify(right.identity)
  );
}
/** Current policy is read by the caller on EVERY redemption, including legacy envelopes. */
export async function redeemWorkspaceGitHubRequest(
  input: RedeemGitHubSessionCapabilityParams & {
    organizationId?: string;
    ownerId: string;
    anchor?: {
      installationId: string;
      source: 'user' | 'installation';
      appType: 'standard' | 'lite';
    };
  },
  access: WorkspaceRepositoryAccess,
  deps: {
    env: CloudflareEnv;
    tokens: Pick<GitHubTokenService, 'getTokenForRepositoryIds'>;
    resolveAuth: (
      params: GetCloudAgentAuthForRepoParams
    ) => Promise<GetCloudAgentAuthForRepoResult>;
  }
): Promise<RedeemGitHubSessionCapabilityResult> {
  const deny = (
    reason:
      | 'repository_access_required'
      | 'repository_read_only'
      | 'operation_not_supported'
      | 'authorization_unavailable'
      | 'separate_repository_requests_required'
  ): RedeemGitHubSessionCapabilityResult => ({ success: false, reason });
  const request = {
    method: input.requestMethod,
    url: input.requestUrl,
    contentType: input.requestContentType,
    body: input.requestBody,
  };
  let last: ReturnType<typeof deny> = deny('repository_access_required');
  const url = new URL(input.requestUrl);
  const match =
    url.hostname === 'github.com'
      ? /^\/([^/]+)\/([^/]+)\.git\//.exec(url.pathname)
      : /^\/repos\/([^/]+)\/([^/]+)(?:\/|$)/.exec(url.pathname);
  const target = match ? `${match[1]}/${match[2]}`.toLowerCase() : undefined;
  const selected = target
    ? access.repositories.find(repo => `${repo.owner}/${repo.name}` === target)
    : undefined;
  if (target && !selected && match) {
    const owner = match[1].toLowerCase(),
      name = match[2].toLowerCase();
    const decision = authorizeGitHubTaskRequest(request, {
      revision: 1,
      scopeId: access.scopeId,
      mode: 'read',
      repository: { id: 1, nodeId: 'public-read', owner, name },
    });
    if (!decision.allowed || decision.operation !== 'read')
      return deny('repository_access_required');
    try {
      await new GitHubTaskResources('', deps.env).publicRepository(owner, name);
    } catch (error) {
      return deny(
        error instanceof GitHubTaskResourceError && error.reason === 'repository_access_required'
          ? 'repository_access_required'
          : 'authorization_unavailable'
      );
    }
    return { success: true, authorization: null, ...input.anchor };
  }
  const candidates = selected ? [selected] : access.repositories;
  for (const repository of candidates) {
    const grant: GitHubTaskGrant = {
      revision: 1,
      scopeId: access.scopeId,
      mode: repository.mode,
      repository: {
        id: repository.repositoryId,
        nodeId: repository.nodeId,
        owner: repository.owner,
        name: repository.name,
      },
    };
    const decision = authorizeGitHubTaskRequest(request, grant);
    if (!decision.allowed) {
      if (decision.reason === 'repository_read_only') last = deny('repository_read_only');
      else if (
        !['repository_mismatch'].includes(decision.reason) ||
        (!target && url.pathname !== '/graphql')
      )
        last = deny('operation_not_supported');
      continue;
    }
    const targets = decision.checks.flatMap(check =>
      check.kind === 'repository-read' ? [check] : []
    );
    if (new Set(targets.map(repo => repo.owner)).size > 1)
      return deny('separate_repository_requests_required');
    const approved = targets.flatMap(check => {
      const candidate = access.repositories.find(
        repo => repo.owner === check.owner && repo.name === check.name
      );
      return candidate ? [candidate] : [];
    });
    const targetIdentity = approved[0];
    if (targetIdentity && approved.some(repo => !sameIdentity(targetIdentity, repo)))
      return deny('separate_repository_requests_required');
    if (targetIdentity && !sameIdentity(repository, targetIdentity)) continue;
    try {
      const auth = await deps.resolveAuth({
        userId: input.ownerId,
        orgId: input.organizationId,
        githubRepo: `${repository.owner}/${repository.name}`,
        expectedIntegrationId: repository.integrationId,
        accessPurpose: 'agent',
        repositoryMode: 'read',
        allowUserAuthorization: repository.identity.source === 'user',
      });
      if (
        !auth.success ||
        auth.source !== repository.identity.source ||
        auth.appType !== repository.identity.appType
      )
        return deny('authorization_unavailable');
      const resources = new GitHubTaskResources(auth.githubToken, deps.env);
      if (decision.operation === 'write' && auth.source === 'user') {
        const current = await resources.repository(repository.owner, repository.name);
        if (current.permissions?.push !== true) return deny('repository_read_only');
      }
      const subject =
        auth.source === 'user' ? await resources.userSubjectId() : auth.installationId;
      if (subject !== repository.identity.providerSubjectId)
        return deny('authorization_unavailable');
      const authorization = await authorizeGitHubTaskCredential(
        deps.env,
        deps.tokens,
        auth,
        grant,
        decision,
        input.requestUrl,
        access.repositories
      );
      return {
        success: true,
        authorization:
          authorization === null
            ? null
            : url.hostname === 'github.com'
              ? `Basic ${Buffer.from(`x-access-token:${authorization}`).toString('base64')}`
              : `Bearer ${authorization}`,
        installationId: auth.installationId,
        source: auth.source,
        appType: auth.appType,
      };
    } catch (error) {
      if (
        error instanceof GitHubTaskResourceError &&
        ['repository_mismatch', 'operation_not_allowed'].includes(error.reason) &&
        url.pathname === '/graphql'
      )
        continue;
      return deny(
        error instanceof GitHubTaskResourceError && error.reason === 'repository_access_required'
          ? 'repository_access_required'
          : 'authorization_unavailable'
      );
    }
  }
  return last;
}
