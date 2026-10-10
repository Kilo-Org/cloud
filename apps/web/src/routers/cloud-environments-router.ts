import { createTRPCRouter, baseProcedure } from '@kilocode/web-shared/lib/trpc/init';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { getOrganizationById } from '@kilocode/web-shared/lib/organizations/organizations';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { AGENT_ENV_VARS_PUBLIC_KEY } from '@kilocode/web-shared/lib/config.server';
import { ORGANIZATION_MANAGE_ROLES } from '@kilocode/app-shared/organizations';
import { canonicalGitLabCloneUrl } from '@kilocode/worker-utils/git-url';
import { isUniqueViolation } from '@/lib/db-errors';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import {
  createEnvironment,
  deleteEnvironment,
  getEnvironment,
  listEnvironments,
  listEnvironmentsForOwner,
  updateEnvironment,
  ENVIRONMENT_KEY_PATTERN,
  ENVIRONMENT_LIMITS,
  type EnvironmentCreateInput,
  type EnvironmentOwner,
  type EnvironmentRepositoryIdentity,
} from '@kilocode/cloud-agent-profile';
import {
  buildGitLabCloneUrl,
  getGitLabInstanceUrlForOrganization,
  getGitLabInstanceUrlForUser,
} from '@/lib/cloud-agent/gitlab-integration-helpers';

const environmentNameSchema = z.string().trim().min(1).max(ENVIRONMENT_LIMITS.MAX_NAME_LENGTH);
const environmentKeySchema = z
  .string()
  .max(ENVIRONMENT_LIMITS.MAX_KEY_LENGTH)
  .regex(ENVIRONMENT_KEY_PATTERN);
const environmentPlainVarsSchema = z.record(
  environmentKeySchema,
  z.string().max(ENVIRONMENT_LIMITS.MAX_PLAINTEXT_VALUE_LENGTH)
);
const environmentSecretsSchema = z.record(
  environmentKeySchema,
  z.string().max(ENVIRONMENT_LIMITS.MAX_SECRET_VALUE_LENGTH)
);
const environmentCommandsSchema = z
  .array(z.string().min(1).max(ENVIRONMENT_LIMITS.MAX_COMMAND_LENGTH))
  .max(ENVIRONMENT_LIMITS.MAX_COMMANDS);
const environmentSecretChangesSchema = z.array(
  z.union([
    z.object({
      key: environmentKeySchema,
      value: z.string().max(ENVIRONMENT_LIMITS.MAX_SECRET_VALUE_LENGTH),
    }),
    z.object({ key: environmentKeySchema, delete: z.literal(true) }),
  ])
);

const listRepositorySchema = z.discriminatedUnion('platform', [
  z.object({ platform: z.literal('github'), fullName: z.string().min(1).max(500) }),
  z.object({ platform: z.literal('gitlab'), projectPath: z.string().min(1).max(500) }),
  z.object({
    platform: z.literal('bitbucket'),
    workspaceUuid: z.uuid(),
    repositoryUuid: z.uuid(),
  }),
]);

const createRepositorySchema = z.discriminatedUnion('platform', [
  z.object({ platform: z.literal('github'), fullName: z.string().min(1).max(500) }),
  z.object({ platform: z.literal('gitlab'), projectPath: z.string().min(1).max(500) }),
  z.object({
    platform: z.literal('bitbucket'),
    fullName: z.string().min(1).max(500),
    workspaceUuid: z.uuid(),
    repositoryUuid: z.uuid(),
  }),
]);

const environmentPlatformSchema = z.enum(['github', 'gitlab', 'bitbucket']);

const environmentSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  platform: environmentPlatformSchema,
  repoFullName: z.string(),
  gitlabCloneUrl: z.string().nullable(),
  bitbucketWorkspaceUuid: z.string().nullable(),
  bitbucketRepositoryUuid: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  plainVarCount: z.number(),
  secretCount: z.number(),
  commandCount: z.number(),
});

const environmentResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  platform: environmentPlatformSchema,
  repoFullName: z.string(),
  gitlabCloneUrl: z.string().nullable(),
  bitbucketWorkspaceUuid: z.string().nullable(),
  bitbucketRepositoryUuid: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  plainVars: z.array(
    z.object({
      key: z.string(),
      value: z.string(),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
  ),
  commands: z.array(z.string()),
  secretKeys: z.array(z.string()),
});

const publicKey = AGENT_ENV_VARS_PUBLIC_KEY ?? '';

const DUPLICATE_ENVIRONMENT_MESSAGE =
  'An environment with this name already exists for this repository.';

function getOwner(organizationId: string | undefined, userId: string): EnvironmentOwner {
  return organizationId
    ? { type: 'organization', id: organizationId }
    : { type: 'user', id: userId };
}

async function requireActiveOrganization(organizationId: string): Promise<void> {
  if (!(await getOrganizationById(organizationId))) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
  }
}

async function canonicalGitLabProjectUrl(
  projectPath: string,
  userId: string,
  organizationId: string | undefined
): Promise<string> {
  const instanceUrl = organizationId
    ? await getGitLabInstanceUrlForOrganization(organizationId)
    : await getGitLabInstanceUrlForUser(userId);
  const cloneUrl = canonicalGitLabCloneUrl(buildGitLabCloneUrl(projectPath, instanceUrl));
  if (!cloneUrl) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid GitLab project path' });
  }
  return cloneUrl;
}

async function listRepositoryIdentity(
  repository: z.infer<typeof listRepositorySchema>,
  userId: string,
  organizationId: string | undefined
): Promise<EnvironmentRepositoryIdentity> {
  switch (repository.platform) {
    case 'github':
      return { platform: 'github', repoFullName: repository.fullName };
    case 'gitlab':
      return {
        platform: 'gitlab',
        cloneUrl: await canonicalGitLabProjectUrl(repository.projectPath, userId, organizationId),
      };
    case 'bitbucket':
      return {
        platform: 'bitbucket',
        workspaceUuid: repository.workspaceUuid,
        repositoryUuid: repository.repositoryUuid,
      };
  }
}

async function createRepositoryIdentity(
  repository: z.infer<typeof createRepositorySchema>,
  userId: string,
  organizationId: string | undefined
): Promise<
  Pick<
    EnvironmentCreateInput,
    | 'platform'
    | 'repoFullName'
    | 'gitlabCloneUrl'
    | 'bitbucketWorkspaceUuid'
    | 'bitbucketRepositoryUuid'
  >
> {
  switch (repository.platform) {
    case 'github':
      return { platform: 'github', repoFullName: repository.fullName };
    case 'gitlab':
      return {
        platform: 'gitlab',
        repoFullName: repository.projectPath,
        gitlabCloneUrl: await canonicalGitLabProjectUrl(
          repository.projectPath,
          userId,
          organizationId
        ),
      };
    case 'bitbucket':
      return {
        platform: 'bitbucket',
        repoFullName: repository.fullName,
        bitbucketWorkspaceUuid: repository.workspaceUuid,
        bitbucketRepositoryUuid: repository.repositoryUuid,
      };
  }
}

/**
 * Repository environments. Personal environments are owned by the calling
 * user; organization environments require membership to read and
 * {@link ORGANIZATION_MANAGE_ROLES} to edit. Responses never expose secret
 * values or envelopes, only key names.
 */
export const cloudEnvironmentsRouter = createTRPCRouter({
  list: baseProcedure
    .input(z.object({ organizationId: z.uuid().optional(), repository: listRepositorySchema }))
    .output(z.array(environmentSummarySchema))
    .query(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
        await requireActiveOrganization(input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      const repository = await listRepositoryIdentity(
        input.repository,
        ctx.user.id,
        input.organizationId
      );
      return listEnvironments(db, owner, repository);
    }),

  /** Every environment for the owner, across repositories (settings view). */
  listAll: baseProcedure
    .input(z.object({ organizationId: z.uuid().optional() }))
    .output(z.array(environmentSummarySchema))
    .query(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
        await requireActiveOrganization(input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      return listEnvironmentsForOwner(db, owner);
    }),

  get: baseProcedure
    .input(z.object({ organizationId: z.uuid().optional(), environmentId: z.uuid() }))
    .output(environmentResponseSchema)
    .query(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
        await requireActiveOrganization(input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      return getEnvironment(db, input.environmentId, owner);
    }),

  create: baseProcedure
    .input(
      z.object({
        organizationId: z.uuid().optional(),
        name: environmentNameSchema,
        repository: createRepositorySchema,
        plainVars: environmentPlainVarsSchema.optional(),
        secrets: environmentSecretsSchema.optional(),
        commands: environmentCommandsSchema.optional(),
      })
    )
    .output(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId, ORGANIZATION_MANAGE_ROLES);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      const repository = await createRepositoryIdentity(
        input.repository,
        ctx.user.id,
        input.organizationId
      );
      return db
        .transaction(tx =>
          createEnvironment(tx, publicKey, {
            owner,
            createdByUserId: ctx.user.id,
            name: input.name,
            ...repository,
            plainVars: input.plainVars,
            secrets: input.secrets,
            commands: input.commands,
          })
        )
        .catch(error => {
          if (isUniqueViolation(error)) {
            throw new TRPCError({ code: 'CONFLICT', message: DUPLICATE_ENVIRONMENT_MESSAGE });
          }
          throw error;
        });
    }),

  update: baseProcedure
    .input(
      z.object({
        organizationId: z.uuid().optional(),
        environmentId: z.uuid(),
        name: environmentNameSchema.optional(),
        plainVars: environmentPlainVarsSchema.optional(),
        secrets: environmentSecretChangesSchema.optional(),
        commands: environmentCommandsSchema.optional(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId, ORGANIZATION_MANAGE_ROLES);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      await db
        .transaction(tx =>
          updateEnvironment(tx, publicKey, {
            owner,
            environmentId: input.environmentId,
            name: input.name,
            plainVars: input.plainVars,
            secrets: input.secrets,
            commands: input.commands,
          })
        )
        .catch(error => {
          if (isUniqueViolation(error)) {
            throw new TRPCError({ code: 'CONFLICT', message: DUPLICATE_ENVIRONMENT_MESSAGE });
          }
          throw error;
        });
      return { success: true };
    }),

  delete: baseProcedure
    .input(z.object({ organizationId: z.uuid().optional(), environmentId: z.uuid() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId, ORGANIZATION_MANAGE_ROLES);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      await deleteEnvironment(db, input.environmentId, owner);
      return { success: true };
    }),
});
