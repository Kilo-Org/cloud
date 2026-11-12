import { z } from 'zod';
import { getWorkerDb } from '@kilocode/db/client';
import {
  platform_integrations,
  organization_memberships,
  github_app_installations,
} from '@kilocode/db/schema';
import { and, eq, exists, isNull, sql } from 'drizzle-orm';
import { GitHubTaskResources, GitHubTaskResourceError } from './github-task-resources.js';
import type { GetCloudAgentAuthForRepoParams, GetCloudAgentAuthForRepoResult } from './index.js';
import type { GitHubTokenService } from './github-token-service.js';
import type { ManagedInstallationLookupResult } from './installation-lookup-service.js';

import type {
  PrepareWorkspaceRepositoryParams,
  PrepareWorkspaceRepositoryResult,
} from '@kilocode/worker-utils/workspace-repository-access';
export type {
  PrepareWorkspaceRepositoryParams,
  PrepareWorkspaceRepositoryResult,
} from '@kilocode/worker-utils/workspace-repository-access';

/** Picker data supplies a name only. Provider metadata and current authorization decide authority. */
async function selectedRepository(env: CloudflareEnv, input: PrepareWorkspaceRepositoryParams) {
  if (input.githubRepo)
    return {
      fullName: input.githubRepo,
      integrationId: input.existing?.integrationId ?? input.expectedIntegrationId,
    };
  if (!env.HYPERDRIVE || !input.repositoryId) return null;
  const db = getWorkerDb(env.HYPERDRIVE.connectionString);
  const rows = await db
    .select({
      id: platform_integrations.id,
      repositories: sql`COALESCE(${github_app_installations.repositories}, ${platform_integrations.repositories})`,
    })
    .from(platform_integrations)
    .leftJoin(
      github_app_installations,
      eq(platform_integrations.github_installation_id, github_app_installations.id)
    )
    .where(
      and(
        eq(platform_integrations.platform, 'github'),
        eq(platform_integrations.integration_status, 'active'),
        input.orgId
          ? and(
              eq(platform_integrations.owned_by_organization_id, input.orgId),
              exists(
                db
                  .select({ one: sql`1` })
                  .from(organization_memberships)
                  .where(
                    and(
                      eq(organization_memberships.organization_id, input.orgId),
                      eq(organization_memberships.kilo_user_id, input.userId)
                    )
                  )
              )
            )
          : and(
              eq(platform_integrations.owned_by_user_id, input.userId),
              isNull(platform_integrations.owned_by_organization_id)
            )
      )
    );
  const repositories = z.array(z.object({ id: z.number(), full_name: z.string() }));
  for (const row of rows) {
    const parsed = repositories.safeParse(row.repositories);
    const selected = parsed.success
      ? parsed.data.find(repo => repo.id === input.repositoryId)
      : undefined;
    if (selected) return { fullName: selected.full_name, integrationId: row.id };
  }
  return null;
}

export async function prepareWorkspaceRepository(
  env: CloudflareEnv,
  input: PrepareWorkspaceRepositoryParams,
  deps: {
    findInstallation: (
      params: GetCloudAgentAuthForRepoParams
    ) => Promise<ManagedInstallationLookupResult>;
    resolveAuth: (
      params: GetCloudAgentAuthForRepoParams
    ) => Promise<GetCloudAgentAuthForRepoResult>;
    tokens: Pick<GitHubTokenService, 'getTokenForRepositoryIds'>;
    expectedIdentity?: {
      source: 'user' | 'installation';
      installationId: string;
      accountLogin: string;
      appType: 'standard' | 'lite';
      gitAuthor: { name: string; email: string };
    };
  }
): Promise<PrepareWorkspaceRepositoryResult> {
  try {
    const selected = await selectedRepository(env, input);
    if (!selected) return { success: false, reason: 'repository_access_required' };
    const params = {
      userId: input.userId,
      orgId: input.orgId,
      githubRepo: selected.fullName.toLowerCase(),
      expectedIntegrationId: selected.integrationId,
      accessPurpose: input.accessPurpose ?? 'agent',
      repositoryMode: 'read' as const,
      allowUserAuthorization:
        (input.existing?.identity.source ?? input.expectedSource) !== 'installation',
    };
    const installation = await deps.findInstallation(params);
    if (!installation.success) return { success: false, reason: 'authorization_unavailable' };
    const auth = await deps.resolveAuth(params);
    if (!auth.success) return { success: false, reason: 'authorization_unavailable' };
    if (
      (input.existing?.identity.source ?? input.expectedSource) &&
      auth.source !== (input.existing?.identity.source ?? input.expectedSource)
    )
      return { success: false, reason: 'authorization_unavailable' };
    const original = deps.expectedIdentity;
    if (
      original &&
      (original.source !== auth.source ||
        original.installationId !== auth.installationId ||
        original.accountLogin !== auth.accountLogin ||
        original.appType !== auth.appType ||
        JSON.stringify(original.gitAuthor) !== JSON.stringify(auth.gitAuthor))
    )
      return { success: false, reason: 'authorization_unavailable' };
    const [owner, name] = params.githubRepo.split('/');
    if (!owner || !name) return { success: false, reason: 'repository_access_required' };
    const resources = new GitHubTaskResources(auth.githubToken, env);
    const repository = await resources.repository(owner, name);
    if (input.repositoryId && input.repositoryId !== repository.id)
      return { success: false, reason: 'repository_access_required' };
    const providerSubjectId =
      auth.source === 'installation' ? auth.installationId : await resources.userSubjectId();
    const identity = { source: auth.source, providerSubjectId, appType: auth.appType };
    if (
      input.existing &&
      (input.existing.repositoryId !== repository.id ||
        input.existing.owner !== owner ||
        input.existing.name !== name ||
        JSON.stringify(input.existing.identity) !== JSON.stringify(identity))
    )
      return { success: false, reason: 'authorization_unavailable' };
    const write =
      installation.permissions?.contents === 'write' &&
      installation.permissions?.pull_requests === 'write' &&
      auth.appType !== 'lite' &&
      (auth.source !== 'user' || repository.permissions?.push === true);
    const mode = input.mode === 'contribute' && !write ? 'read' : input.mode;
    if (input.source === 'user' && mode !== input.mode)
      return { success: false, reason: 'repository_read_only' };
    // Prepare and validate attenuation before a grant can commit.
    if (auth.source === 'user')
      await resources.scopeUserToken({ owner, repositoryIds: [repository.id] }, mode);
    else
      await deps.tokens.getTokenForRepositoryIds(
        auth.installationId,
        [repository.id],
        auth.appType,
        mode
      );
    return {
      success: true,
      repository: {
        repositoryId: repository.id,
        nodeId: repository.node_id,
        owner,
        name,
        mode,
        source: input.existing?.source ?? input.source,
        approvedBy: input.userId,
        approvedAt: Date.now(),
        integrationId: installation.integrationId,
        identity,
        gitAuthor: auth.gitAuthor,
      },
    };
  } catch (error) {
    return {
      success: false,
      reason:
        error instanceof GitHubTaskResourceError && error.reason === 'repository_access_required'
          ? 'repository_access_required'
          : 'authorization_unavailable',
    };
  }
}
