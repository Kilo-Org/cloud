import { cloudEnvironmentSetupRouter } from './cloud-environment-setup-router';
import { createTRPCRouter, baseProcedure } from '@kilocode/web-shared/lib/trpc/init';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { AGENT_ENV_VARS_PUBLIC_KEY } from '@kilocode/web-shared/lib/config.server';
import { ORGANIZATION_MANAGE_ROLES } from '@kilocode/app-shared/organizations';
import { SELECTABLE_SANDBOX_ALLOCATIONS } from '@kilocode/worker-utils/sandbox-allocation';
import { setupScriptSchema } from '@kilocode/cloud-agent-profile/setup-script';
import {
  egressDomainSchema,
  egressModeSchema,
  egressPolicySchema,
} from '@kilocode/worker-utils/egress-allowlist';
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
  ENVIRONMENT_SETUP_LIMITS,
  environmentRepositoryEntrySchema,
  type EnvironmentCreateInput,
  type EnvironmentPlatform,
  type EnvironmentRepositoryIdentity,
} from '@kilocode/cloud-agent-profile';
import { assertAllocationSupportsMultiRepository } from '@/lib/cloud-agent/multi-repository-environments';
import {
  canonicalGitLabProjectUrl,
  createRepositorySchema,
  environmentRepositoryListSchema,
  toEnvironmentRepositoryEntry,
} from '@/lib/cloud-agent/environment-repository-input';
import { getOwner, requireActiveOrganization } from '@/lib/cloud-agent/environment-owner';
import { environmentBuildClientFor } from '@/lib/cloud-agent-next/environment-build-client';
import {
  assertAllocationOffered,
  loadSandboxCapabilities,
} from '@/lib/cloud-agent-next/sandbox-allocation-offers';
import type { User } from '@kilocode/db/schema';
import {
  environmentBuildCancelResultSchema,
  environmentBuildLogsSchema,
  environmentBuildRequestResultSchema,
  environmentBuildStatusSchema,
} from '../../../../services/cloud-agent-next/src/shared/environment-build-status';

// Environments store network restrictions, but auditing is a session-only option.
const environmentEgressPolicySchema = egressPolicySchema.safeExtend({
  egressAudit: z.never().optional(),
});

const environmentNameSchema = z.string().trim().min(1).max(ENVIRONMENT_LIMITS.MAX_NAME_LENGTH);
const environmentKeySchema = z
  .string()
  .max(ENVIRONMENT_LIMITS.MAX_KEY_LENGTH)
  .regex(ENVIRONMENT_KEY_PATTERN);
export const environmentPlainVarsSchema = z
  .record(environmentKeySchema, z.string().max(ENVIRONMENT_LIMITS.MAX_PLAINTEXT_VALUE_LENGTH))
  .refine(vars => Object.keys(vars).length <= ENVIRONMENT_LIMITS.MAX_VARS, {
    message: `Maximum ${ENVIRONMENT_LIMITS.MAX_VARS} variables and secrets allowed`,
  });
const environmentSecretsSchema = z.record(
  environmentKeySchema,
  z.string().max(ENVIRONMENT_LIMITS.MAX_SECRET_VALUE_LENGTH)
);
const environmentCommandsSchema = z
  .array(setupScriptSchema.min(1))
  .max(ENVIRONMENT_LIMITS.MAX_COMMANDS);
/** A change list can remove every stored secret and add a full set at once. */
export const environmentSecretChangesSchema = z
  .array(
    z.union([
      z.object({
        key: environmentKeySchema,
        value: z.string().max(ENVIRONMENT_LIMITS.MAX_SECRET_VALUE_LENGTH),
      }),
      z.object({ key: environmentKeySchema, delete: z.literal(true) }),
    ])
  )
  .max(2 * ENVIRONMENT_LIMITS.MAX_VARS);

const environmentSandboxAllocationSchema = z.enum(SELECTABLE_SANDBOX_ALLOCATIONS).nullable();

const environmentRequiredHostsSchema = z
  .array(egressDomainSchema)
  .max(ENVIRONMENT_SETUP_LIMITS.MAX_REQUIRED_HOSTS);

const listRepositorySchema = z.discriminatedUnion('platform', [
  z.object({ platform: z.literal('github'), fullName: z.string().min(1).max(500) }),
  z.object({ platform: z.literal('gitlab'), projectPath: z.string().min(1).max(500) }),
  z.object({
    platform: z.literal('bitbucket'),
    workspaceUuid: z.uuid(),
    repositoryUuid: z.uuid(),
  }),
]);

const environmentPlatformSchema = z.enum(['github', 'gitlab', 'bitbucket']);

// A response is a V1 environment (identity scalars) or a V2 environment
// (`repositories`). The other alternative's fields are absent.
const environmentV1IdentitySchema = {
  platform: environmentPlatformSchema,
  repoFullName: z.string(),
  gitlabCloneUrl: z.string().nullable(),
  bitbucketWorkspaceUuid: z.string().nullable(),
  bitbucketRepositoryUuid: z.string().nullable(),
  repositories: z.undefined().optional(),
};

const environmentV2IdentitySchema = {
  repositories: z.array(environmentRepositoryEntrySchema),
  platform: z.undefined().optional(),
  repoFullName: z.undefined().optional(),
  gitlabCloneUrl: z.undefined().optional(),
  bitbucketWorkspaceUuid: z.undefined().optional(),
  bitbucketRepositoryUuid: z.undefined().optional(),
};

const environmentSummaryBaseSchema = {
  id: z.uuid(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  plainVarCount: z.number(),
  secretCount: z.number(),
  commandCount: z.number(),
  configurationRevision: z.number(),
  sandboxAllocation: z.string().nullable(),
};

const environmentSummarySchema = z.union([
  z.object({ ...environmentSummaryBaseSchema, ...environmentV1IdentitySchema }),
  z.object({ ...environmentSummaryBaseSchema, ...environmentV2IdentitySchema }),
]);

const environmentResponseBaseSchema = {
  id: z.uuid(),
  name: z.string(),
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
  startCommands: z.array(z.string()),
  secretKeys: z.array(z.string()),
  configurationRevision: z.number(),
  sandboxAllocation: z.string().nullable(),
  egressMode: egressModeSchema.nullable(),
  egressAllowlist: z.array(z.string()).nullable(),
  egressRequiredHosts: z.array(z.string()),
  isDraft: z.boolean(),
};

const environmentResponseSchema = z.union([
  z.object({ ...environmentResponseBaseSchema, ...environmentV1IdentitySchema }),
  z.object({ ...environmentResponseBaseSchema, ...environmentV2IdentitySchema }),
]);

const publicKey = AGENT_ENV_VARS_PUBLIC_KEY ?? '';

const DUPLICATE_ENVIRONMENT_MESSAGE = 'This repository already has an environment.';

/**
 * Rejects a sandbox the owner is not offered for every platform the environment
 * contains. Callers check only a newly chosen key: an unchanged saved key may be
 * stale, and sessions skip it, so it must not block an unrelated edit.
 */
async function assertEnvironmentAllocationOffered(
  user: User,
  headersList: Headers | undefined,
  organizationId: string | undefined,
  platforms: EnvironmentPlatform[],
  allocation: string
): Promise<void> {
  for (const platform of platforms) {
    const capabilities = await loadSandboxCapabilities(user, headersList, organizationId, platform);
    assertAllocationOffered(capabilities, allocation, platform);
  }
}

const environmentBuildScopeSchema = z.object({
  organizationId: z.uuid().optional(),
  environmentId: z.uuid(),
});

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

/**
 * Repository environments. Personal environments are owned by the calling
 * user; organization environments require membership to read and
 * {@link ORGANIZATION_MANAGE_ROLES} to edit. Responses never expose secret
 * values or envelopes, only key names.
 */
export const cloudEnvironmentsRouter = createTRPCRouter({
  setupRuns: cloudEnvironmentSetupRouter,
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
      z
        .object({
          organizationId: z.uuid().optional(),
          name: environmentNameSchema,
          /** One repository: a V1 environment. */
          repository: createRepositorySchema.optional(),
          /** One or more repositories: a V2 environment. */
          repositories: environmentRepositoryListSchema.optional(),
          plainVars: environmentPlainVarsSchema.optional(),
          secrets: environmentSecretsSchema.optional(),
          commands: environmentCommandsSchema.optional(),
          startCommands: environmentCommandsSchema.optional(),
          sandboxAllocation: environmentSandboxAllocationSchema.optional(),
        })
        .and(environmentEgressPolicySchema)
    )
    .output(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId, ORGANIZATION_MANAGE_ROLES);
      }
      if ((input.repository === undefined) === (input.repositories === undefined)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Provide either repository or repositories',
        });
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      const submitted = input.repositories ?? (input.repository ? [input.repository] : []);
      if (input.repositories) {
        assertAllocationSupportsMultiRepository(input.sandboxAllocation);
      }
      const entries = await Promise.all(
        submitted.map(repository =>
          toEnvironmentRepositoryEntry(repository, ctx.user.id, input.organizationId)
        )
      );
      if (input.sandboxAllocation) {
        await assertEnvironmentAllocationOffered(
          ctx.user,
          ctx.headersList,
          input.organizationId,
          [...new Set(entries.map(entry => entry.platform))],
          input.sandboxAllocation
        );
      }
      const base = {
        owner,
        createdByUserId: ctx.user.id,
        name: input.name,
        plainVars: input.plainVars,
        secrets: input.secrets,
        commands: input.commands,
        startCommands: input.startCommands,
        sandboxAllocation: input.sandboxAllocation,
        egressMode: input.egressMode,
        egressAllowlist: input.egressAllowlist,
      };
      const createInput: EnvironmentCreateInput = input.repositories
        ? { ...base, repositories: entries }
        : { ...base, ...entries[0] };
      return db
        .transaction(tx => createEnvironment(tx, publicKey, createInput))
        .catch(error => {
          if (isUniqueViolation(error)) {
            throw new TRPCError({ code: 'CONFLICT', message: DUPLICATE_ENVIRONMENT_MESSAGE });
          }
          throw error;
        });
    }),

  update: baseProcedure
    .input(
      z
        .object({
          organizationId: z.uuid().optional(),
          environmentId: z.uuid(),
          name: environmentNameSchema.optional(),
          /** Replaces repositories, converting older environments when needed. */
          repositories: environmentRepositoryListSchema.optional(),
          plainVars: environmentPlainVarsSchema.optional(),
          secrets: environmentSecretChangesSchema.optional(),
          commands: environmentCommandsSchema.optional(),
          startCommands: environmentCommandsSchema.optional(),
          sandboxAllocation: environmentSandboxAllocationSchema.optional(),
          requiredHosts: environmentRequiredHostsSchema.optional(),
        })
        .and(environmentEgressPolicySchema)
    )
    .output(z.object({ success: z.boolean(), configurationRevision: z.number() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId, ORGANIZATION_MANAGE_ROLES);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      const repositories = input.repositories
        ? await Promise.all(
            input.repositories.map(repository =>
              toEnvironmentRepositoryEntry(repository, ctx.user.id, input.organizationId)
            )
          )
        : undefined;
      if (input.sandboxAllocation || repositories) {
        const saved = await getEnvironment(db, input.environmentId, owner);
        if (saved.repositories || repositories) {
          assertAllocationSupportsMultiRepository(
            input.sandboxAllocation === undefined
              ? saved.sandboxAllocation
              : input.sandboxAllocation
          );
        }
        if (input.sandboxAllocation && input.sandboxAllocation !== saved.sandboxAllocation) {
          const platforms = (repositories ?? saved.repositories ?? [saved]).map(
            repository => repository.platform
          );
          await assertEnvironmentAllocationOffered(
            ctx.user,
            ctx.headersList,
            input.organizationId,
            [...new Set(platforms)],
            input.sandboxAllocation
          );
        }
      }
      const { configurationRevision } = await db.transaction(tx =>
        updateEnvironment(tx, publicKey, {
          owner,
          environmentId: input.environmentId,
          name: input.name,
          repositories,
          plainVars: input.plainVars,
          secrets: input.secrets,
          commands: input.commands,
          startCommands: input.startCommands,
          sandboxAllocation: input.sandboxAllocation,
          egressMode: input.egressMode,
          egressAllowlist: input.egressAllowlist,
          requiredHosts: input.requiredHosts,
        })
      );
      return { success: true, configurationRevision };
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
      // Prompt build cleanup. Best effort: the coordinator also notices the
      // deletion on its own, so a failed notice changes nothing.
      try {
        const builds = await environmentBuildClientFor(
          ctx.user,
          ctx.headersList,
          input.organizationId
        );
        await builds.environmentDeleted(input.environmentId);
      } catch {
        // Ignored; see above.
      }
      return { success: true };
    }),

  /** Snapshot build status. Members may read it; it carries no values or handles. */
  buildStatus: baseProcedure
    .input(environmentBuildScopeSchema)
    .output(environmentBuildStatusSchema)
    .query(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
        await requireActiveOrganization(input.organizationId);
      }
      const builds = await environmentBuildClientFor(
        ctx.user,
        ctx.headersList,
        input.organizationId
      );
      return builds.status({
        environmentId: input.environmentId,
        ...(input.organizationId ? { kilocodeOrganizationId: input.organizationId } : {}),
      });
    }),

  /**
   * Build or refresh the environment snapshot from the base image. A retried
   * request after a lost response reuses its `requestId`.
   */
  build: baseProcedure
    .input(
      environmentBuildScopeSchema.extend({
        expectedRevision: z.number().int().positive(),
        requestId: z.uuid(),
      })
    )
    .output(environmentBuildRequestResultSchema)
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId, ORGANIZATION_MANAGE_ROLES);
      }
      const builds = await environmentBuildClientFor(
        ctx.user,
        ctx.headersList,
        input.organizationId
      );
      return builds.build({
        environmentId: input.environmentId,
        expectedRevision: input.expectedRevision,
        requestId: input.requestId,
        ...(input.organizationId ? { kilocodeOrganizationId: input.organizationId } : {}),
      });
    }),

  buildLogs: baseProcedure
    .input(
      environmentBuildScopeSchema.extend({
        buildId: z.uuid(),
        cursor: z.number().int().nonnegative().optional(),
      })
    )
    .output(environmentBuildLogsSchema)
    .query(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId, ORGANIZATION_MANAGE_ROLES);
      }
      const builds = await environmentBuildClientFor(
        ctx.user,
        ctx.headersList,
        input.organizationId
      );
      return builds.logs({
        environmentId: input.environmentId,
        buildId: input.buildId,
        cursor: input.cursor,
        limit: 500,
        ...(input.organizationId ? { kilocodeOrganizationId: input.organizationId } : {}),
      });
    }),

  cancelBuild: baseProcedure
    .input(environmentBuildScopeSchema.extend({ buildId: z.uuid() }))
    .output(environmentBuildCancelResultSchema)
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId, ORGANIZATION_MANAGE_ROLES);
      }
      const builds = await environmentBuildClientFor(
        ctx.user,
        ctx.headersList,
        input.organizationId
      );
      return builds.cancel({
        environmentId: input.environmentId,
        buildId: input.buildId,
        ...(input.organizationId ? { kilocodeOrganizationId: input.organizationId } : {}),
      });
    }),
});
