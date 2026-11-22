import { isSafeRepositoryLeaf, repositoryLeaf } from '@kilocode/cloud-agent-profile';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { getPgDb } from '../../db/pg.js';
import { hostedGitHubRepositoriesSchema } from '../../persistence/hosted-github-repositories.js';
import type { SessionCreateRequest } from '../../session/session-requests.js';
import type { HostedGitHubRepositoryFailureReason, TRPCContext } from '../../types.js';
import { protectedProcedure } from '../auth.js';
import { githubRepoSchema } from '../schemas.js';
import { assertOrganizationMembership } from './organization-membership.js';

export const additionalHostedRepositoryIdsSchema = z.array(z.int().positive()).max(5);

const pageSchema = z.int().min(1).max(100);

export const listHostedWorkspaceRepositoriesInput = z.strictObject({
  organizationId: z.uuid(),
  integrationId: z.uuid(),
  primaryRepo: githubRepoSchema,
  page: pageSchema.optional(),
});

export const listHostedWorkspaceRepositoriesOutput = z.strictObject({
  hostedAdditionalRepositoriesVersion: z.literal(1),
  repositories: z
    .array(
      z.strictObject({ id: z.int().positive(), fullName: githubRepoSchema, private: z.boolean() })
    )
    .max(100),
  nextPage: pageSchema.optional(),
});

function catalogUnavailable() {
  return new TRPCError({
    code: 'SERVICE_UNAVAILABLE',
    message: 'hosted_workspace_repository_catalog_unavailable',
  });
}

async function readRepositoryBroker<T>(read: () => Promise<T> | undefined): Promise<T> {
  try {
    const result = await read();
    if (result !== undefined) return result;
  } catch {
    throw catalogUnavailable();
  }
  throw catalogUnavailable();
}

function repositoryAccessError(reason: HostedGitHubRepositoryFailureReason) {
  if (reason === 'access_denied') {
    return new TRPCError({
      code: 'FORBIDDEN',
      message: 'hosted_workspace_repository_access_denied',
    });
  }
  if (reason === 'repository_unavailable') {
    return new TRPCError({ code: 'NOT_FOUND', message: 'hosted_workspace_repository_unavailable' });
  }
  return catalogUnavailable();
}

export function assertHostedWorkspaceUser(ctx: Pick<TRPCContext, 'botId' | 'cloudAgentAuthority'>) {
  if (ctx.botId !== undefined || ctx.cloudAgentAuthority !== undefined) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Session access denied' });
  }
}

export const listHostedWorkspaceRepositories = protectedProcedure
  .input(listHostedWorkspaceRepositoriesInput)
  .output(listHostedWorkspaceRepositoriesOutput)
  .query(async ({ ctx, input }) => {
    assertHostedWorkspaceUser(ctx);
    await assertOrganizationMembership(getPgDb(ctx.env), ctx.userId, input.organizationId);
    const broker = ctx.env.GIT_TOKEN_SERVICE;
    const page = input.page ?? 1;
    const result = await readRepositoryBroker(() =>
      broker?.listHostedWorkspaceGitHubRepositories?.({ ...input, userId: ctx.userId, page })
    );
    if (!result.success) throw repositoryAccessError(result.reason);
    return {
      hostedAdditionalRepositoriesVersion: 1 as const,
      repositories: result.repositories.map(({ id, fullName, private: isPrivate }) => ({
        id,
        fullName,
        private: isPrivate,
      })),
      nextPage: result.nextPage,
    };
  });

export async function resolveHostedWorkspaceRepositories(
  ctx: Pick<TRPCContext, 'env' | 'userId'>,
  request: SessionCreateRequest,
  additionalRepositoryIds: number[]
): Promise<SessionCreateRequest> {
  const { repository } = request;
  const organizationId = request.options?.kilocodeOrganizationId;
  if (repository.type !== 'github' || !repository.githubIntegrationId || !organizationId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'hosted_workspace_repository_scope_required',
    });
  }
  if (new Set(additionalRepositoryIds).size !== additionalRepositoryIds.length) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'hosted_workspace_repository_duplicate' });
  }

  const integrationId = repository.githubIntegrationId;
  const ids = additionalRepositoryIds.toSorted((a, b) => a - b);
  const result = await readRepositoryBroker(() =>
    ctx.env.GIT_TOKEN_SERVICE?.resolveHostedWorkspaceGitHubRepositories?.({
      userId: ctx.userId,
      organizationId,
      integrationId,
      primaryRepo: repository.repo,
      additionalRepositoryIds: ids,
    })
  );
  if (!result.success) throw repositoryAccessError(result.reason);
  if (ids.includes(result.primary.id)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'hosted_workspace_repository_duplicate' });
  }
  const additional = result.additional.toSorted((a, b) => a.id - b.id);
  const hosted = hostedGitHubRepositoriesSchema.safeParse({
    integrationId,
    primary: result.primary,
    additional,
  });
  if (
    additional.length !== ids.length ||
    additional.some((repo, index) => repo.id !== ids[index]) ||
    result.primary.fullName.toLowerCase() !== repository.repo.toLowerCase()
  ) {
    throw catalogUnavailable();
  }
  const directories = [result.primary, ...additional].map(repo => repositoryLeaf(repo.fullName));
  if (
    directories.some(directory => !isSafeRepositoryLeaf(directory)) ||
    new Set(directories.map(directory => directory.toLowerCase())).size !== directories.length
  ) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'hosted_workspace_repository_path_conflict',
    });
  }
  if (!hosted.success) throw catalogUnavailable();
  return { ...request, hostedGitHubRepositories: hosted.data };
}
