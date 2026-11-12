import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { createProfile } from '@kilocode/cloud-agent-profile';
import {
  generateKiloSessionId,
  cloudAgentWorktreeIdSchema,
} from '@kilocode/session-ingest-contracts';
import {
  cli_sessions_v2,
  platform_integrations,
  cloud_agent_pr_watches,
  cloud_agent_pr_maintenance_attempts,
  kilocode_users,
} from '@kilocode/db/schema';
import {
  watchPrMaintenanceInputSchema,
  watchPrMaintenancePolicySchema,
} from '@kilocode/db/cloud-agent-pr-maintenance';
import { signModernKiloToken } from '@kilocode/worker-utils';
import {
  createRuntimeAuthorization,
  sealRuntimeAuthorization,
} from '@kilocode/worker-utils/runtime-authorization';
import { ensureTestUser } from '../auth.js';
import { findControlPlaneKiloRuntime, executeDockerCommand } from '../sandbox-control.js';
import { createMessageId } from '../../../src/shared/message-id.js';
import type { MaintenanceStart } from '../../../src/pr-maintenance/contracts.js';
import { maintenanceFixturePrompt } from './review-fixtures.js';
import {
  emptyWatchPrProjection,
  projectWatchPrEvent,
} from '../../../../../apps/web/src/lib/cloud-agent/watch-pr-events.js';
import {
  identitySchema,
  describeMessageFailure,
  GIT_URL,
  MODEL,
  REPO_URL,
  type Context,
  type State,
  type Attempt,
} from './context.js';

export const createdSchema = identitySchema.extend({ workspaceId: cloudAgentWorktreeIdSchema });
export const policy = watchPrMaintenancePolicySchema.parse({
  version: 2,
  automaticWritesConsent: true,
  historyRewriteConsent: true,
  noHardSpendCapConsent: true,
  model: MODEL,
  profileId: null,
  environmentId: null,
  categories: { reviews: true, failedChecks: true, conflicts: true },
  quietPeriodSeconds: 30,
});

export function directive(state: Pick<State, 'tag'>, conversation: string) {
  return `__e2e_scope__:${state.tag}\n__fake__:${conversation}\nSynthetic local acceptance only. Do not edit, commit, push, or call GitHub.`;
}

export async function watch(context: Context, state: State) {
  const [row] = await context.db
    .select()
    .from(cloud_agent_pr_watches)
    .where(
      and(
        eq(cloud_agent_pr_watches.id, state.watchId),
        eq(cloud_agent_pr_watches.kilo_user_id, state.userId)
      )
    );
  assert(
    row && row.worktree_id === state.workspaceId && row.integration_id === state.integrationId,
    'Synthetic watch ownership changed'
  );
  assert.equal(row.repository_id, `local-maintenance:${state.runId}`);
  return row;
}

export async function feedback(context: Context, state: State, suffix: string) {
  const current = await watch(context, state);
  const projected = projectWatchPrEvent(
    current,
    {
      kind: 'feedback',
      installationId: current.installation_id,
      repositoryId: current.repository_id,
      prNumber: current.pr_number,
      key: `review:${suffix}`,
      action: 'submitted',
      updatedAt: new Date().toISOString(),
      sha: current.head_sha,
      actorId: '100000000000001',
      actorLogin: 'synthetic-local-reviewer',
      actorType: 'User',
      authorAssociation: 'COLLABORATOR',
      source: 'review',
      sourceId: suffix,
      body: `Synthetic review ${suffix}; verify this local fixture without changing files.`,
      state: 'commented',
      reviewAction: 'submitted',
    },
    current.generation
  );
  await context.db
    .update(cloud_agent_pr_watches)
    .set({
      projection: projected.projection,
      pending_revision: projected.pending_revision,
      pending_since: current.pending_since ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .where(eq(cloud_agent_pr_watches.id, state.watchId));
}

export async function prepare(context: Context) {
  const runId = randomUUID();
  const tag = `maintenance-${runId.slice(0, 12)}`;
  const user = await ensureTestUser(
    context.stack.database,
    `${tag}@cloud-agent-next-e2e.example.com`,
    { funded: true }
  );
  await context.authenticate(user);
  const profile = await createProfile(
    context.db,
    { type: 'user', id: user.id },
    user.id,
    tag,
    `Synthetic maintenance acceptance ${runId}`
  );
  const bootstrapOperationKey = randomUUID();
  await writeFile(
    path.join(context.out, 'bootstrap.json'),
    JSON.stringify({ runId, tag, userId: user.id, profileId: profile.id, bootstrapOperationKey }),
    { mode: 0o600, flag: 'wx' }
  );
  const root = await context.trpc(
    'createHostedWorkspace',
    {
      operationKey: bootstrapOperationKey,
      clientProvenance: 'agent-manager',
      repository: { type: 'git', url: GIT_URL, branch: 'master' },
      profile: { id: profile.id },
      message: { prompt: directive({ tag }, 'echo:maintenance-bootstrap') },
      agent: { mode: 'code', model: MODEL },
    },
    createdSchema
  );
  const state: State = {
    version: 1,
    runId,
    tag,
    userId: user.id,
    profileId: profile.id,
    workspaceId: root.workspaceId,
    root,
    integrationId: randomUUID(),
    watchId: randomUUID(),
    attempts: [],
    bootstrapOperationKey,
    cleaned: false,
  };
  await context.save(state);
  const completed = await context.until(
    'bootstrap exact message',
    async () => {
      const result = await context.result(root);
      return ['completed', 'failed', 'interrupted'].includes(result.status) ? result : undefined;
    },
    120_000
  );
  assert.equal(
    completed.status,
    'completed',
    `Public-clone bootstrap did not complete: ${describeMessageFailure(completed)}`
  );
  const metadata = await context.trpc(
    'getSession',
    { cloudAgentSessionId: root.cloudAgentSessionId },
    z.object({
      branchName: z.string().min(1),
      worktreeId: z.string(),
      autoCommit: z.boolean().optional(),
    }),
    'GET'
  );
  assert.equal(metadata.worktreeId, state.workspaceId);
  assert.equal(metadata.branchName, 'master', 'The public fixture branch must exist remotely');
  const runtime = await findControlPlaneKiloRuntime(root.kiloSessionId);
  assert(runtime, 'Cannot identify the owned public-clone checkout');
  const head = z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .parse(
      (
        await executeDockerCommand([
          'exec',
          runtime.container.id,
          'git',
          '-C',
          runtime.directory,
          'rev-parse',
          '--verify',
          'HEAD',
        ])
      ).stdout.trim()
    );
  await context.db.insert(platform_integrations).values({
    id: state.integrationId,
    owned_by_user_id: user.id,
    platform: 'github',
    integration_type: 'app',
    platform_installation_id: `synthetic-local-${runId}`,
    github_app_type: 'standard',
    metadata: { prMaintenanceLocalRun: runId },
  });
  await context.db.insert(cloud_agent_pr_watches).values({
    id: state.watchId,
    kilo_user_id: user.id,
    integration_id: state.integrationId,
    installation_id: `synthetic-local-${runId}`,
    github_app_type: 'standard',
    repository_id: `local-maintenance:${runId}`,
    repo_url: REPO_URL,
    pr_number: 1,
    source_session_id: root.kiloSessionId,
    source_cloud_agent_session_id: root.cloudAgentSessionId,
    worktree_id: state.workspaceId,
    head_ref: metadata.branchName,
    base_ref: 'master',
    head_sha: head,
    base_sha: head,
    status: 'paused',
    policy: { ...policy, profileId: profile.id },
    projection: emptyWatchPrProjection(new Date().toISOString()),
    lifecycle_reason: 'synthetic_local_fixture_not_github_authorized',
    expires_at: null,
    last_assessed_at: new Date().toISOString(),
  });
  await feedback(context, state, 'initial');
  context.pass('real public-clone workspace and exact bootstrap message completed');
  context.pass('synthetic watch fixture seeded without claiming GitHub authorization');
  return state;
}

export async function seedAttempt(context: Context, state: State, kind: Attempt['kind']) {
  const existing = state.attempts.find(attempt => attempt.kind === kind);
  if (existing) {
    const [saved] = await context.db
      .select()
      .from(cloud_agent_pr_maintenance_attempts)
      .where(
        and(
          eq(cloud_agent_pr_maintenance_attempts.id, existing.id),
          eq(cloud_agent_pr_maintenance_attempts.watch_id, state.watchId)
        )
      );
    assert(
      saved &&
        saved.session_id === existing.kiloSessionId &&
        saved.cloud_agent_session_id === existing.cloudAgentSessionId &&
        saved.message_id === existing.messageId,
      'Attempt identity changed; do not retry this mutation'
    );
    assert(
      ['creating', 'running', 'needs_input'].includes(saved.status),
      'This attempt is terminal. Inspect its evidence and prepare a fresh fixture instead of replaying it.'
    );
    return existing;
  }
  const current = await watch(context, state);
  const ordinal = state.attempts.length + 1;
  const attempt: Attempt = {
    id: randomUUID(),
    creationOperationKey: randomUUID(),
    kind,
    kiloSessionId: generateKiloSessionId(),
    cloudAgentSessionId: `workspace_${randomUUID()}`,
    messageId: createMessageId(),
    gate: `${state.tag}-${kind}`,
  };
  const input = watchPrMaintenanceInputSchema.parse({
    version: 1,
    purpose: 'Synthetic local runtime acceptance; no repository writes.',
    constraints: ['Do not publish or edit files.'],
    repository: {
      repositoryId: current.repository_id,
      repoUrl: current.repo_url,
      prNumber: current.pr_number,
      headRef: current.head_ref,
      baseRef: current.base_ref,
      headSha: current.head_sha,
      baseSha: current.base_sha,
      parentCommitSha: null,
    },
    policy: current.policy,
    ordinal,
    problems: [
      {
        kind: 'review',
        problemKey: 'review:initial',
        contentFingerprint: 'synthetic-initial',
        source: 'review',
        sourceId: 'initial',
        threadId: null,
        authorLogin: 'synthetic-local-reviewer',
        body: 'Verify this local runtime fixture without changing files.',
        url: null,
        commitSha: current.head_sha,
      },
    ],
    problemAttempts: [],
    priorDispositions: [],
    previousResults: [],
    verificationCommands: [],
    references: [],
  });
  await context.db.transaction(async tx => {
    await tx.insert(cloud_agent_pr_maintenance_attempts).values({
      id: attempt.id,
      watch_id: state.watchId,
      worktree_id: state.workspaceId,
      generation: current.generation,
      pending_revision: current.pending_revision + 1,
      ordinal,
      session_id: attempt.kiloSessionId,
      cloud_agent_session_id: attempt.cloudAgentSessionId,
      creation_operation_key: attempt.creationOperationKey,
      message_id: attempt.messageId,
      input,
      started_at: new Date().toISOString(),
      next_run_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    await tx
      .update(cloud_agent_pr_watches)
      .set({
        status: 'watching',
        execution_status: 'fixing',
        lifecycle_reason: null,
        pending_revision: current.pending_revision + 1,
        total_attempts: ordinal,
        last_attempt_id: attempt.id,
        next_run_at: null,
        updated_at: new Date().toISOString(),
      })
      .where(eq(cloud_agent_pr_watches.id, state.watchId));
  });
  state.attempts.push(attempt);
  await context.save(state);
  return attempt;
}

export async function startPayload(
  context: Context,
  state: State,
  attempt: Attempt
): Promise<MaintenanceStart> {
  const current = await watch(context, state);
  const [principal] = await context.db
    .select({
      id: kilocode_users.id,
      apiTokenPepper: kilocode_users.api_token_pepper,
      blockedAt: kilocode_users.blocked_at,
      blockedReason: kilocode_users.blocked_reason,
      isBot: kilocode_users.is_bot,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, state.userId));
  assert(principal, 'Fixture principal disappeared');
  const admission = await signModernKiloToken({
    userId: state.userId,
    pepper: principal.apiTokenPepper,
    env: 'development',
    audience: 'cloud-agent-next',
    secret: context.vars.NEXTAUTH_SECRET,
    expiresInSeconds: 600,
    tokenPurpose: 'internal-service',
    credentialExchange: false,
    extra: {
      tokenSource: 'cloud-agent',
      runtimeAdmission: {
        source: 'automation',
        authorizationUserId: principal.id,
        authorizationPepper: principal.apiTokenPepper,
      },
    },
  });
  const authorization = await createRuntimeAuthorization({
    token: admission.token,
    secret: context.vars.NEXTAUTH_SECRET,
    connectionString: context.stack.database,
    resourceKind: 'cloud-agent-next',
    resourceId: attempt.cloudAgentSessionId,
    adapters: {
      getPrincipal: async ({ userId }) => {
        const [row] = await context.db
          .select({
            id: kilocode_users.id,
            apiTokenPepper: kilocode_users.api_token_pepper,
            blockedAt: kilocode_users.blocked_at,
            blockedReason: kilocode_users.blocked_reason,
            isBot: kilocode_users.is_bot,
          })
          .from(kilocode_users)
          .where(eq(kilocode_users.id, userId));
        return row ?? null;
      },
    },
  });
  const seal = await sealRuntimeAuthorization(
    authorization.authorization,
    context.vars.NEXTAUTH_SECRET
  );
  context.secrets.push(admission.token, authorization.token, seal);
  return {
    userId: state.userId,
    worktreeId: state.workspaceId,
    watchId: state.watchId,
    attemptId: attempt.id,
    creationOperationKey: attempt.creationOperationKey,
    kiloSessionId: attempt.kiloSessionId,
    cloudAgentSessionId: attempt.cloudAgentSessionId,
    messageId: attempt.messageId,
    prompt: maintenanceFixturePrompt(state.tag, attempt),
    model: MODEL,
    profileId: state.profileId,
    environmentId: null,
    runtimeToken: authorization.token,
    runtimeAuthorizationSeal: seal,
    allowRebase: current.policy.version === 2 && current.policy.categories.conflicts,
    parentCommitSha: null,
    recoverableAttemptIds: state.attempts
      .filter(previous => previous.id !== attempt.id)
      .map(previous => previous.id),
    publication: {
      repoUrl: current.repo_url,
      headRef: current.head_ref,
      baseRef: current.base_ref,
      observedHeadSha: current.head_sha,
      baseSha: current.base_sha,
    },
  };
}

export async function maintenanceChats(context: Context, state: State) {
  return context.db
    .select()
    .from(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.kilo_user_id, state.userId),
        eq(cli_sessions_v2.cloud_agent_worktree_id, state.workspaceId),
        eq(cli_sessions_v2.chat_kind, 'maintenance')
      )
    );
}

export async function due(context: Context, state: State) {
  await watch(context, state);
  await context.db
    .update(cloud_agent_pr_watches)
    .set({
      status: 'watching',
      lifecycle_reason: null,
      next_run_at: new Date(Date.now() - 1_000).toISOString(),
    })
    .where(eq(cloud_agent_pr_watches.id, state.watchId));
}
