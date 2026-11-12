import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { captureException } from '@sentry/nextjs';
import { createTRPCRouter, baseProcedure } from '@kilocode/web-shared/lib/trpc/init';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { isMobileClient } from '@kilocode/web-shared/lib/trpc/min-version';
import { egressDomainSchema, egressModeSchema } from '@kilocode/worker-utils/egress-allowlist';
import { sessionVariantSchema } from '@/routers/cloud-agent-next-schemas';
import {
  getSandboxAllocation,
  CLOUDFLARE_CONTAINERS_DEFAULT_ALLOCATION,
  getSandboxAllocationProvider,
  isSandboxAllocationAvailable,
} from '@kilocode/worker-utils/sandbox-allocation';
import {
  ENVIRONMENT_KEY_PATTERN,
  ENVIRONMENT_LIMITS,
  createSetupRunWithDraft,
  getEnvironment,
  getSetupRun,
  getSetupRunBySession,
  listSetupRunsForEnvironment,
  attachSetupSession,
  cancelUnstartedSetupRun,
  resolveSecretRequests,
  resolveNetworkRequests,
  publishSetupRun,
  revertSetupRun,
  cancelSetupRun,
  resumeSetupRun,
} from '@kilocode/cloud-agent-profile';
import {
  environmentRepositoryListSchema,
  toEnvironmentRepositoryEntry,
} from '@/lib/cloud-agent/environment-repository-input';
import { assertAllocationSupportsMultiRepository } from '@/lib/cloud-agent/multi-repository-environments';
import { loadSandboxCapabilities } from '@/lib/cloud-agent-next/sandbox-allocation-offers';
import { resolveGitHubPrepareParams } from '@/lib/cloud-agent-next/github-prepare-params';
import { environmentBuildClientFor } from '@/lib/cloud-agent-next/environment-build-client';
import { requireManageOwner, requireReadOwner } from '@/lib/cloud-agent/environment-setup/access';
import { publicKey, safeErrorMessage } from '@/lib/cloud-agent/environment-setup/common';
import { setupRunResponse } from '@/lib/cloud-agent/environment-setup/read';
import { buildSetupPrompt } from '@/lib/cloud-agent/environment-setup/prompt';
import { ENVIRONMENT_SETUP_SKILL } from '@/lib/cloud-agent/environment-setup/skill';
import {
  setupRepositoryPaths,
  setupWorkingDirectory,
} from '@/lib/cloud-agent/environment-setup/paths';
import {
  userCloudAgentClient,
  sendSetupFollowUp,
} from '@/lib/cloud-agent/environment-setup/worker';
import {
  secretsResolved,
  hostsResolved,
  resumeRun,
} from '@/lib/cloud-agent/environment-setup/follow-ups';
import { assertDraftPublishable } from '@/lib/cloud-agent/environment-setup/publish-validation';
import { cloudEnvironmentSetupAgentRouter } from './cloud-environment-setup-agent-router';

const ownerInput = z.object({ organizationId: z.uuid().optional() });
const runInput = ownerInput.extend({ runId: z.uuid() });
const keySchema = z.string().max(ENVIRONMENT_LIMITS.MAX_KEY_LENGTH).regex(ENVIRONMENT_KEY_PATTERN);
export const cloudEnvironmentSetupRouter = createTRPCRouter({
  isEnabled: baseProcedure.input(ownerInput).query(async ({ ctx, input }) => {
    try {
      await requireManageOwner(ctx, input.organizationId);
      return { enabled: true, canStart: true };
    } catch (error) {
      if (
        error instanceof TRPCError &&
        ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'].includes(error.code)
      )
        return { enabled: true, canStart: false };
      throw error;
    }
  }),
  start: baseProcedure
    .input(
      ownerInput.extend({
        repositories: environmentRepositoryListSchema,
        requirements: z.string().trim().max(8000).default(''),
        model: z.string().min(1).max(200),
        variant: sessionVariantSchema.optional(),
        name: z.string().trim().min(1).max(ENVIRONMENT_LIMITS.MAX_NAME_LENGTH).optional(),
        targetEnvironmentId: z.uuid().optional(),
        egressMode: egressModeSchema.optional(),
        secrets: z.record(keySchema, z.string().min(1).max(8192)).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const owner = await requireManageOwner(ctx, input.organizationId);
      const entries = await Promise.all(
        input.repositories.map(repository =>
          toEnvironmentRepositoryEntry(repository, ctx.user.id, input.organizationId)
        )
      );
      const first = entries[0];
      if (!first || first.platform !== 'github')
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'The first repository must be a GitHub repository.',
        });
      const capabilities = await loadSandboxCapabilities(
        ctx.user,
        ctx.headersList,
        input.organizationId,
        'github'
      );
      const sandboxOptions = capabilities.options
        .flatMap(option => {
          const allocation = getSandboxAllocation(option.allocation);
          return allocation ? [allocation] : [];
        })
        .filter(allocation => {
          if (!isSandboxAllocationAvailable(capabilities, allocation)) return false;
          if (getSandboxAllocationProvider(allocation) !== 'cloudflare-containers') return false;
          try {
            assertAllocationSupportsMultiRepository(allocation);
            return true;
          } catch {
            return false;
          }
        });
      if (!sandboxOptions.length)
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'Environment setup needs a sandbox with network auditing, and none is available for this account.',
        });
      const target = input.targetEnvironmentId
        ? await getEnvironment(db, input.targetEnvironmentId, owner)
        : null;
      const setupAllocation = 'cloudflare-containers-standard-4';
      if (
        !sandboxOptions.includes(setupAllocation) ||
        !sandboxOptions.includes(CLOUDFLARE_CONTAINERS_DEFAULT_ALLOCATION)
      )
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Environment setup needs standard-4 for setup and standard-3 for verification.',
        });
      const { runId, draftEnvironmentId } = await db.transaction(tx =>
        createSetupRunWithDraft(tx, publicKey, {
          owner,
          createdByUserId: ctx.user.id,
          repositories: entries,
          name: input.name,
          targetEnvironmentId: input.targetEnvironmentId,
          egressMode: input.egressMode,
          initialSecrets: input.secrets,
          requirements: input.requirements,
          model: input.model,
          variant: input.variant,
          launchRepoFullName: first.repoFullName,
          sandboxOptions,
          initialSandboxAllocation: CLOUDFLARE_CONTAINERS_DEFAULT_ALLOCATION,
        })
      );
      let createdSessionId: string | undefined;
      try {
        const client = await userCloudAgentClient(ctx, input.organizationId, input.model);
        const github = await resolveGitHubPrepareParams({
          userId: ctx.user.id,
          organizationId: input.organizationId,
          githubRepo: first.repoFullName,
        });
        const paths = setupRepositoryPaths(entries);
        const result = await client.prepareSession({
          ...github,
          prompt: buildSetupPrompt({
            requirements: input.requirements,
            repositories: entries.map((repository, index) => ({
              repoFullName: repository.repoFullName,
              path: paths[index],
            })),
            workingDirectory: setupWorkingDirectory(entries),
            isRefinement: !!target,
          }),
          mode: 'code',
          model: input.model,
          ...(input.variant ? { variant: input.variant } : {}),
          autoInitiate: true,
          autoCommit: false,
          operationKey: runId,
          requestedEnvironment: { id: draftEnvironmentId },
          requireEnvironmentChoice: true,
          environmentSetupRunId: runId,
          runtimeSkills: [ENVIRONMENT_SETUP_SKILL],
          sandboxAllocation: setupAllocation,
          egressAudit: true,
          createdOnPlatform: 'cloud-agent-web',
          githubAccessPurpose: 'agent',
          clientProvenance: isMobileClient(ctx.headersList) ? 'mobile' : 'browser',
          ...(input.organizationId ? { kilocodeOrganizationId: input.organizationId } : {}),
        });
        createdSessionId = result.cloudAgentSessionId;
        await db.transaction(tx =>
          attachSetupSession(tx, {
            runId,
            owner,
            cloudAgentSessionId: result.cloudAgentSessionId,
            kiloSessionId: result.kiloSessionId,
          })
        );
        return {
          runId,
          cloudAgentSessionId: result.cloudAgentSessionId,
          kiloSessionId: result.kiloSessionId,
        };
      } catch (error) {
        if (createdSessionId) {
          try {
            const client = await userCloudAgentClient(ctx, input.organizationId);
            await client.interruptSession(createdSessionId);
          } catch (interruptError) {
            captureException(interruptError, {
              tags: { source: 'environment-setup', op: 'unattached-session' },
              extra: { runId },
            });
          }
        }
        await db.transaction(tx =>
          cancelUnstartedSetupRun(tx, { runId, owner, detail: safeErrorMessage(error) })
        );
        throw error;
      }
    }),
  get: baseProcedure.input(runInput).query(async ({ ctx, input }) => {
    const owner = await requireReadOwner(ctx, input.organizationId);
    return setupRunResponse(
      await getSetupRun(db, input.runId, owner),
      owner,
      ctx,
      input.organizationId
    );
  }),
  getBySession: baseProcedure
    .input(ownerInput.extend({ cloudAgentSessionId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const owner = await requireReadOwner(ctx, input.organizationId);
      const run = await getSetupRunBySession(db, input.cloudAgentSessionId, owner);
      return run ? setupRunResponse(run, owner, ctx, input.organizationId) : null;
    }),
  listForEnvironment: baseProcedure
    .input(ownerInput.extend({ environmentId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const owner = await requireReadOwner(ctx, input.organizationId);
      const runs = await listSetupRunsForEnvironment(db, input.environmentId, owner);
      return Promise.all(
        runs.map(async run => ({ ...(await setupRunResponse(run, owner)), diff: null }))
      );
    }),
  resolveSecretRequests: baseProcedure
    .input(runInput.extend({ skipped: z.array(keySchema).max(20) }))
    .mutation(async ({ ctx, input }) => {
      const owner = await requireManageOwner(ctx, input.organizationId);
      const result = await db.transaction(tx => resolveSecretRequests(tx, { ...input, owner }));
      if (result.resumed || result.provided.length || result.skipped.length)
        await sendSetupFollowUp(
          await userCloudAgentClient(ctx, input.organizationId),
          await getSetupRun(db, input.runId, owner),
          secretsResolved(result.provided, result.skipped)
        );
      return result;
    }),
  resolveNetworkRequests: baseProcedure
    .input(
      runInput.extend({
        approved: z.array(egressDomainSchema).max(20),
        declined: z.array(egressDomainSchema).max(20),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const owner = await requireManageOwner(ctx, input.organizationId);
      const before = await getSetupRun(db, input.runId, owner);
      const pending = before.data.network_requests.filter(request => request.state === 'pending');
      const approved = input.approved.filter(host =>
        pending.some(request => request.host === host)
      );
      const declined = input.declined.filter(host =>
        pending.some(request => request.host === host)
      );
      const result = await db.transaction(tx =>
        resolveNetworkRequests(tx, publicKey, { ...input, owner })
      );
      if (result.resumed || approved.length || declined.length)
        await sendSetupFollowUp(
          await userCloudAgentClient(ctx, input.organizationId),
          before,
          hostsResolved(approved, declined)
        );
      return result;
    }),
  publish: baseProcedure
    .input(runInput.extend({ force: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      const owner = await requireManageOwner(ctx, input.organizationId);
      const run = await getSetupRun(db, input.runId, owner);
      if ((run.status === 'publish_conflict' || run.status === 'failed') && !input.force)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Confirm to overwrite the changed environment.',
        });
      if (!run.draft_environment_id)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Draft environment not found' });
      assertDraftPublishable(await getEnvironment(db, run.draft_environment_id, owner));
      return db.transaction(tx => publishSetupRun(tx, { runId: run.id, owner, mode: 'force' }));
    }),
  revert: baseProcedure
    .input(runInput.extend({ force: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      const owner = await requireManageOwner(ctx, input.organizationId);
      return db.transaction(tx => revertSetupRun(tx, { ...input, owner }));
    }),
  cancel: baseProcedure.input(runInput).mutation(async ({ ctx, input }) => {
    const owner = await requireManageOwner(ctx, input.organizationId);
    const run = await getSetupRun(db, input.runId, owner);
    await db.transaction(tx => cancelSetupRun(tx, { runId: run.id, owner }));
    try {
      const client = await userCloudAgentClient(ctx, input.organizationId);
      for (const sessionId of [
        run.cloud_agent_session_id,
        run.data.pending_verification?.childSessionId,
      ]) {
        if (!sessionId) continue;
        try {
          await client.interruptSession(sessionId);
        } catch (error) {
          captureException(error, {
            tags: { source: 'environment-setup', op: 'cancel' },
            extra: { runId: run.id },
          });
        }
      }
    } catch (error) {
      captureException(error, {
        tags: { source: 'environment-setup', op: 'cancel' },
        extra: { runId: run.id },
      });
    }
    return { success: true };
  }),
  resume: baseProcedure
    .input(runInput.extend({ raiseVerificationLimit: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      const owner = await requireManageOwner(ctx, input.organizationId);
      const run = await getSetupRun(db, input.runId, owner);
      const result = await db.transaction(tx => resumeSetupRun(tx, { ...input, owner }));
      await sendSetupFollowUp(
        await userCloudAgentClient(ctx, input.organizationId),
        run,
        resumeRun(run.data.status_reason ?? 'agent stopped')
      );
      return result;
    }),
  buildSnapshot: baseProcedure.input(runInput).mutation(async ({ ctx, input }) => {
    const owner = await requireManageOwner(ctx, input.organizationId);
    const run = await getSetupRun(db, input.runId, owner);
    if (
      run.status !== 'published' ||
      !run.published_environment_id ||
      run.data.published_revision === null
    )
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'The environment must be published first.',
      });
    const client = await environmentBuildClientFor(ctx.user, ctx.headersList, input.organizationId);
    return client.build({
      environmentId: run.published_environment_id,
      expectedRevision: run.data.published_revision,
      requestId: randomUUID(),
      ...(input.organizationId ? { kilocodeOrganizationId: input.organizationId } : {}),
    });
  }),
  agent: cloudEnvironmentSetupAgentRouter,
});
