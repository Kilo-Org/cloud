import { TRPCError } from '@trpc/server';
import { createTRPCRouter, baseProcedure } from '@kilocode/web-shared/lib/trpc/init';
import type { TRPCContext } from '@kilocode/web-shared/lib/trpc/init';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { environmentSetupAgentOperations } from '@kilocode/worker-utils/environment-setup-authority';
import { WORKSPACE_SESSION_CALLBACK_PREFIX } from '@kilocode/worker-utils/cloud-agent-authority';
import { SETUP_SCRIPT_LIMITS } from '@kilocode/worker-utils/setup-script';
import {
  getEnvironment,
  getSetupRun,
  updateDraftByAgent,
  addSecretRequests,
  addNetworkRequests,
  reserveVerification,
  attachVerificationChild,
  releaseVerification,
  recordVerification,
  evaluateCompletionGate,
  completeSetupRun,
  failSetupRunByAgent,
  type EnvironmentResponse,
  type EnvironmentSetupVerification,
} from '@kilocode/cloud-agent-profile';
import { requireAgentScope } from '@/lib/cloud-agent/environment-setup/access';
import { publicKey, safeErrorMessage } from '@/lib/cloud-agent/environment-setup/common';
import {
  setupRepositoryPaths,
  setupWorkingDirectory,
} from '@/lib/cloud-agent/environment-setup/paths';
import { verifySecretReferences } from '@/lib/cloud-agent/environment-setup/secret-references';
import { readEgressHosts } from '@/lib/cloud-agent/environment-setup/egress-evidence';
import { buildVerificationPrompt } from '@/lib/cloud-agent/environment-setup/verification-prompt';
import { userCloudAgentClient } from '@/lib/cloud-agent/environment-setup/worker';
import { assertDraftPublishable } from '@/lib/cloud-agent/environment-setup/publish-validation';
import { resolveGitHubPrepareParams } from '@/lib/cloud-agent-next/github-prepare-params';
import type { PrepareSessionOutput } from '@/lib/cloud-agent-next/cloud-agent-client';

async function loadAgentDraft(ctx: TRPCContext, runId: string) {
  const scope = await requireAgentScope(ctx, runId);
  const run = await getSetupRun(db, runId, scope.owner);
  if (run.draft_environment_id !== scope.claim.environmentId)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Environment setup draft does not match authority',
    });
  const draft = await getEnvironment(db, scope.claim.environmentId, scope.owner);
  return { scope, run, draft };
}

function completionGate(
  draft: EnvironmentResponse,
  run: Parameters<typeof evaluateCompletionGate>[0]['run']
) {
  return evaluateCompletionGate({
    draftRevision: draft.configurationRevision,
    draftSandboxAllocation: draft.sandboxAllocation,
    draftEgressMode: draft.egressMode,
    draftEgressAllowlist: draft.egressAllowlist,
    draftEgressRequiredHosts: draft.egressRequiredHosts,
    run,
  });
}

function repositoriesOf(draft: EnvironmentResponse) {
  if (!draft.repositories)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Setup draft must have repositories',
    });
  return draft.repositories;
}

export const cloudEnvironmentSetupAgentRouter = createTRPCRouter({
  getDraft: baseProcedure
    .input(environmentSetupAgentOperations.getDraft.schema)
    .query(async ({ ctx, input }) => {
      const { scope, run, draft } = await loadAgentDraft(ctx, input.runId);
      const repositories = repositoriesOf(draft);
      const paths = setupRepositoryPaths(repositories);
      const client = await userCloudAgentClient(ctx, scope.organizationId);
      const discoveryAudit = run.cloud_agent_session_id
        ? await readEgressHosts(
            client,
            run.cloud_agent_session_id,
            scope.organizationId,
            input.auditCursor
          )
        : null;
      return {
        runId: run.id,
        status: run.status,
        requirements: run.requirements,
        model: run.model,
        variant: run.variant,
        repositories: repositories.map((repository, index) => ({
          repoFullName: repository.repoFullName,
          platform: repository.platform,
          path: paths[index],
        })),
        workingDirectory: setupWorkingDirectory(repositories),
        configurationRevision: draft.configurationRevision,
        plainVars: Object.fromEntries(
          draft.plainVars.map(variable => [variable.key, variable.value])
        ),
        secretKeys: draft.secretKeys,
        sandboxAllocation: draft.sandboxAllocation,
        offeredSandboxAllocations: run.sandbox_options,
        network: {
          discoveryAccess: 'full',
          discoveryAudit,
          mode:
            draft.egressMode === 'allowlist'
              ? draft.egressAllowlist?.length || draft.egressRequiredHosts.length
                ? 'limited'
                : 'none'
              : 'full',
          allowlist: draft.egressAllowlist,
          requiredHosts: draft.egressRequiredHosts,
          restricted: draft.egressMode === 'allowlist',
          baseline: 'Kilo, Git, and repository hosts are always allowed.',
        },
        limits: {
          maxScriptLength: SETUP_SCRIPT_LIMITS.MAX_LENGTH,
          maxVars: 50,
          maxPlainValueLength: 256,
          maxSecretValueLength: 8192,
          reservedKeys: 'HOME, SESSION_*, XDG_*, KILO*, OPENCODE*, sandbox control names',
          setupInactivityTimeoutSeconds: 300,
          setupTotalTimeoutSeconds: 480,
          verificationsRemaining: run.verification_limit - run.verification_count,
        },
        secretRequests: run.secret_requests,
        networkRequests: run.network_requests,
        pendingVerification: run.pending_verification,
        lastVerification: run.last_verification,
        // Last, so an over-cap tool result cuts only the script.
        script: draft.commands[0] ?? '',
      };
    }),
  updateDraft: baseProcedure
    .input(environmentSetupAgentOperations.updateDraft.schema)
    .mutation(async ({ ctx, input }) => {
      const { scope } = await loadAgentDraft(ctx, input.runId);
      return db.transaction(tx =>
        updateDraftByAgent(tx, publicKey, { ...input, owner: scope.owner })
      );
    }),
  requestSecrets: baseProcedure
    .input(environmentSetupAgentOperations.requestSecrets.schema)
    .mutation(async ({ ctx, input }) => {
      const { scope, run, draft } = await loadAgentDraft(ctx, input.runId);
      const requests = await verifySecretReferences(
        scope.owner,
        repositoriesOf(draft),
        input.secrets
      );
      await db.transaction(tx =>
        addSecretRequests(tx, { runId: run.id, owner: scope.owner, requests })
      );
      return {
        status: 'needs_input' as const,
        message:
          'The user was asked in the environment editor. Wait for a follow-up message; do not ask for values in chat.',
      };
    }),
  requestNetworkHosts: baseProcedure
    .input(environmentSetupAgentOperations.requestNetworkHosts.schema)
    .mutation(async ({ ctx, input }) => {
      const { scope, run, draft } = await loadAgentDraft(ctx, input.runId);
      const sessionId = input.childSessionId ?? run.cloud_agent_session_id;
      const restricted = draft.egressMode === 'allowlist';
      if (restricted && sessionId === run.cloud_agent_session_id)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Restricted hosts require denied requests from a verification session.',
        });
      if (!sessionId)
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Setup session is not available.',
        });
      if (
        sessionId !== run.cloud_agent_session_id &&
        run.pending_verification?.childSessionId !== input.childSessionId &&
        run.last_verification?.childSessionId !== input.childSessionId
      )
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown verification session.' });
      const client = await userCloudAgentClient(ctx, scope.organizationId);
      const audit = await readEgressHosts(
        client,
        sessionId,
        scope.organizationId,
        input.auditCursor
      );
      const requests = input.hosts.map(request => {
        const observed = audit.hosts.find(entry => entry.host === request.host);
        const requestCount = restricted ? observed?.deniedRequestCount : observed?.requestCount;
        if (!requestCount)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `No ${restricted ? 'denied' : 'observed'} request to ${request.host} in ${sessionId}'s egress audit.`,
          });
        return { ...request, evidence: { sessionId, requestCount } };
      });
      return db.transaction(tx =>
        addNetworkRequests(tx, { runId: run.id, owner: scope.owner, requests })
      );
    }),
  startVerification: baseProcedure
    .input(environmentSetupAgentOperations.startVerification.schema)
    .mutation(async ({ ctx, input }) => {
      const { scope, run, draft } = await loadAgentDraft(ctx, input.runId);
      const setupSessionId = run.cloud_agent_session_id;
      if (!setupSessionId)
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Setup session is not available.',
        });
      const reservation = await db.transaction(tx =>
        reserveVerification(tx, { ...input, owner: scope.owner })
      );
      if (reservation.status === 'limit_reached')
        return {
          status: 'limit_reached' as const,
          message: 'The verification limit was reached. The user must allow more tests.',
        };
      const { operationKey, configurationRevision } = reservation;
      // Release the reservation only when no child started. Once a child runs,
      // it keeps its slot even if attaching it fails.
      let result: PrepareSessionOutput;
      try {
        const client = await userCloudAgentClient(ctx, scope.organizationId, run.model);
        const github = await resolveGitHubPrepareParams({
          userId: ctx.user.id,
          organizationId: scope.organizationId,
          githubRepo: run.launch_repo_full_name,
        });
        result = await client.prepareSession({
          ...github,
          prompt: buildVerificationPrompt({
            checks: input.checks,
            workingDirectory: setupWorkingDirectory(repositoriesOf(draft)),
          }),
          mode: 'code',
          model: run.model,
          ...(run.variant ? { variant: run.variant } : {}),
          autoInitiate: true,
          autoCommit: false,
          operationKey,
          callbackTarget: { url: `${WORKSPACE_SESSION_CALLBACK_PREFIX}${setupSessionId}` },
          requestedEnvironment: { id: scope.claim.environmentId },
          verificationOf: { runId: run.id },
          createdOnPlatform: 'cloud-agent-web',
          githubAccessPurpose: 'agent',
          clientProvenance: 'browser',
          ...(scope.organizationId ? { kilocodeOrganizationId: scope.organizationId } : {}),
        });
      } catch (error) {
        await db.transaction(tx =>
          releaseVerification(tx, { runId: run.id, owner: scope.owner, operationKey })
        );
        throw error;
      }
      await db.transaction(tx =>
        attachVerificationChild(tx, {
          runId: run.id,
          owner: scope.owner,
          operationKey,
          childSessionId: result.cloudAgentSessionId,
          childKiloSessionId: result.kiloSessionId,
        })
      );
      return {
        childSessionId: result.cloudAgentSessionId,
        configurationRevision,
        message:
          'Verification started. You will receive its result as a message. Then call report_verification_results.',
      };
    }),
  recordVerification: baseProcedure
    .input(environmentSetupAgentOperations.recordVerification.schema)
    .mutation(async ({ ctx, input }) => {
      const { scope, run, draft } = await loadAgentDraft(ctx, input.runId);
      const previous =
        run.pending_verification?.childSessionId === input.childSessionId
          ? run.pending_verification
          : run.last_verification?.childSessionId === input.childSessionId
            ? run.last_verification
            : null;
      if (!previous)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'Unknown verification session. A draft change may have superseded it; start a new verification.',
        });
      const client = await userCloudAgentClient(ctx, scope.organizationId);
      const session = await client.getSession(input.childSessionId, scope.organizationId);
      const verification: EnvironmentSetupVerification = {
        childSessionId: input.childSessionId,
        childKiloSessionId: session.kiloSessionId ?? previous.childKiloSessionId,
        configurationRevision: session.environment?.configurationRevision ?? null,
        preparation: session.latestPreparation?.status ?? 'missing',
        preparationError: session.latestPreparation?.safeError ?? null,
        setupDurationMs: session.latestPreparation?.setupDurationMs ?? null,
        egressMode: session.egress?.mode ?? null,
        egressAllowlist: session.egress?.allowlist ?? null,
        sandboxAllocation: previous.sandboxAllocation,
        checks: previous.checks,
        results: input.results,
        recordedAt: new Date().toISOString(),
      };
      await db.transaction(tx =>
        recordVerification(tx, {
          runId: run.id,
          owner: scope.owner,
          childSessionId: input.childSessionId,
          verification,
        })
      );
      return {
        verification,
        gate: completionGate(draft, { ...run, last_verification: verification }),
      };
    }),
  complete: baseProcedure
    .input(environmentSetupAgentOperations.complete.schema)
    .mutation(async ({ ctx, input }) => {
      const { scope, run, draft } = await loadAgentDraft(ctx, input.runId);
      const gate = completionGate(draft, run);
      if (!gate.ok) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: gate.reason });
      try {
        assertDraftPublishable(draft);
      } catch (error) {
        const message = safeErrorMessage(error);
        await db.transaction(tx =>
          failSetupRunByAgent(tx, {
            runId: run.id,
            owner: scope.owner,
            reason: 'publish_validation_failed',
            detail: message,
          })
        );
        return { status: 'failed' as const, message };
      }
      const result = await db.transaction(tx =>
        completeSetupRun(tx, { runId: run.id, owner: scope.owner, summary: input.summary })
      );
      const messages = {
        published: 'Published. The environment now applies to new sessions.',
        publish_conflict:
          'The environment changed while you worked. The user must choose to publish or discard.',
        draft_missing: 'The draft environment was deleted.',
      };
      return { status: result.status, message: messages[result.status] };
    }),
  fail: baseProcedure
    .input(environmentSetupAgentOperations.fail.schema)
    .mutation(async ({ ctx, input }) => {
      const { scope } = await loadAgentDraft(ctx, input.runId);
      await db.transaction(tx =>
        failSetupRunByAgent(tx, {
          runId: input.runId,
          owner: scope.owner,
          reason: 'agent_failed',
          detail: input.reason,
        })
      );
      return { status: 'failed' as const };
    }),
});
