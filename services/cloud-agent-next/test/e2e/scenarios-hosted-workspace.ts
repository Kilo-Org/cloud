/**
 * `hosted-workspace-sessions` — the `agent-manager` workspace mutation surface.
 *
 * The browser `cloud-agent-web` flows are covered by `worktree-chat` and
 * `worktree-multi-chat`. This scenario drives the operations an IDE Session
 * Host uses instead: create a workspace with its first root, add a root by
 * workspace id alone, delete one root while siblings keep the workspace, and
 * reject deleting the final root.
 *
 * The profile is created through `@kilocode/cloud-agent-profile` (the same
 * service the product uses) so the run needs no web sign-in. Everything else
 * goes through the public tRPC surface: real Worker, Session DO, sandbox and
 * the deterministic fake LLM.
 */

import { randomUUID } from 'node:crypto';
import { computeDatabaseUrl, createDrizzleClient } from '@kilocode/db';
import { createProfile } from '@kilocode/cloud-agent-profile';
import {
  createHostedWorkspace,
  createHostedWorkspaceSession,
  deleteHostedWorkspaceSession,
  getHostedWorkspace,
  getSessionSnapshot,
  type DriverConfig,
  type HostedWorkspaceCreateResult,
} from './client.js';
import { cleanupRemoteSession } from './scenarios-shared.js';
import {
  awaitDurableTerminal,
  createOwnedSessionRegistry,
  createScenarioDeadline,
  sessionSandboxObservation,
  type ScenarioDeadline,
} from './scenarios-shared-runtime.js';
import { assertScenarioPreconditions } from './public-surface-support.js';
import type { LifecycleArgs, LifecycleResult } from './lifecycle.js';
import type { SharedScenario } from './scenarios-shared.js';
import { HOSTED_WORKSPACE_CONTRACT_SCENARIOS } from './scenarios-hosted-workspace-contract.js';
import type { ScenarioEnvironment } from './scenario-capabilities.js';

const HOSTED_WORKSPACE_TIMEOUT_MS = 25 * 60_000;
const REMOTE_TURN_BUDGET_MS = 240_000;
const REMOTE_TERMINAL_BUDGET_MS = 180_000;
const PROFILE_CREATE_FAILED = 'persistent_profile_unavailable';
const FINAL_ROOT_REJECTION_DEADLINE_MS = 30_000;
const CLEANUP_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Poll the durable turn status inside one bounded scenario window. A cold
 * create can spend most of its budget preparing the container, so this repeats
 * the bounded durable read rather than relying on a single confirmation pass.
 */
async function requireDurableCompletion(
  deadline: ScenarioDeadline,
  config: DriverConfig,
  session: { cloudAgentSessionId: string },
  messageId: string,
  label: string
): Promise<void> {
  const status = await deadline.within(
    `${label} durable`,
    async signal => {
      for (;;) {
        const current = await awaitDurableTerminal(
          config,
          session.cloudAgentSessionId,
          messageId,
          Math.min(REMOTE_TERMINAL_BUDGET_MS, deadline.remaining(`${label} durable`)),
          signal
        );
        if (current === 'completed' || current === 'failed' || current === 'interrupted') {
          return current;
        }
      }
    },
    REMOTE_TERMINAL_BUDGET_MS
  );
  if (status !== 'completed') {
    throw new Error(`${label} turn durable status=${status}`);
  }
}

/**
 * Deletion cleanup must run against whatever roots remain. Session operations
 * intentionally cannot remove the final root, so siblings go first and the
 * registry cleanup afterwards meets only that documented guard.
 */
async function cleanupRemainingRoots(
  config: DriverConfig,
  workspaceId: string | undefined
): Promise<void> {
  if (!workspaceId) return;
  const workspace = await getHostedWorkspace(
    config,
    workspaceId,
    AbortSignal.timeout(CLEANUP_REQUEST_TIMEOUT_MS)
  ).catch(() => null);
  if (!workspace) return;
  // The final root intentionally cannot be deleted through a session operation;
  // siblings go first so the registry cleanup afterwards only meets that guard.
  const [first, ...siblings] = workspace.sessions;
  for (const session of siblings) {
    await deleteHostedWorkspaceSession(
      config,
      {
        workspaceId,
        sessionId: session.cloudAgentSessionId,
      },
      AbortSignal.timeout(CLEANUP_REQUEST_TIMEOUT_MS)
    ).catch(() => undefined);
  }
  void first;
}

export async function runHostedWorkspaceSessions(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = HOSTED_WORKSPACE_TIMEOUT_MS } = args;
  const scenarioName = 'hosted-workspace-sessions';
  const sandbox = sessionSandboxObservation(env);
  const owned = createOwnedSessionRegistry(config, cleanupRemoteSession);
  const scenarioConfig = owned.config;
  const deadline = createScenarioDeadline(startedAt, timeoutMs);
  const runId = randomUUID();

  let workspaceId: string | undefined;
  let result: LifecycleResult;

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message,
    events: [],
    durationMs: Date.now() - startedAt,
  });

  try {
    assertScenarioPreconditions(scenarioConfig, args.api);
    const databaseUrl =
      env.database?.url ?? (env.profile === 'local' ? computeDatabaseUrl() : undefined);
    if (!databaseUrl) throw new Error(PROFILE_CREATE_FAILED);

    const client = createDrizzleClient({
      connectionString: databaseUrl,
      poolConfig: { max: 1 },
      ssl: false,
    });
    let profileId: string;
    try {
      const profile = await createProfile(
        client.db,
        { type: 'user', id: scenarioConfig.user.id },
        scenarioConfig.user.id,
        `e2e-hosted-workspace-${runId}`
      );
      profileId = profile.id;
    } catch (error) {
      throw new Error(`${PROFILE_CREATE_FAILED}: ${String(error)}`);
    } finally {
      await client.pool.end().catch(() => undefined);
    }

    const rootMarkers = {
      create: `hw-create-${runId}`,
      firstSibling: `hw-sib-a-${runId}`,
      secondSibling: `hw-sib-b-${runId}`,
    };

    const created: HostedWorkspaceCreateResult = await deadline.within(
      'create workspace',
      signal =>
        createHostedWorkspace(
          scenarioConfig,
          { profileId, prompt: `echo:${rootMarkers.create}` },
          signal
        ),
      REMOTE_TURN_BUDGET_MS
    );
    workspaceId = created.workspaceId;
    owned.register({
      ...created,
      worktreeId: created.workspaceId,
    });
    if (!created.workspaceId.startsWith('worktree_')) {
      throw new Error(`create returned workspaceId=${created.workspaceId}; expected worktree_*`);
    }
    if (!created.cloudAgentSessionId.startsWith('workspace_')) {
      throw new Error(
        `create returned cloudAgentSessionId=${created.cloudAgentSessionId}; expected workspace_*`
      );
    }
    await requireDurableCompletion(deadline, scenarioConfig, created, created.messageId, 'create');
    const rootSnapshot = await deadline.within('root snapshot', signal =>
      getSessionSnapshot(scenarioConfig, created.cloudAgentSessionId, signal)
    );
    if (rootSnapshot.worktreeId !== created.workspaceId) {
      throw new Error(
        `root worktreeId=${rootSnapshot.worktreeId ?? 'none'}; expected ${created.workspaceId}`
      );
    }
    if (!rootSnapshot.sandboxId) throw new Error('root did not expose a durable sandbox id');
    const rootAllocation = await deadline.within(
      'root allocation',
      signal =>
        sandbox.waitForContainer({
          cloudAgentSessionId: created.cloudAgentSessionId,
          kiloSessionId: created.kiloSessionId,
          timeoutMs: REMOTE_TURN_BUDGET_MS,
          signal,
        }),
      REMOTE_TURN_BUDGET_MS
    );
    if (rootAllocation === null) throw new Error('root did not expose a physical allocation');

    const firstSibling = await deadline.within(
      'first sibling',
      signal =>
        createHostedWorkspaceSession(
          scenarioConfig,
          {
            workspaceId: created.workspaceId,
            prompt: `echo:${rootMarkers.firstSibling}`,
          },
          signal
        ),
      REMOTE_TURN_BUDGET_MS
    );
    owned.register({ ...firstSibling, worktreeId: created.workspaceId });
    if (firstSibling.workspaceId !== created.workspaceId) {
      throw new Error('first sibling create returned a different workspace id');
    }
    await requireDurableCompletion(
      deadline,
      scenarioConfig,
      firstSibling,
      firstSibling.messageId,
      'first sibling'
    );
    const firstSiblingSnapshot = await deadline.within('first sibling snapshot', signal =>
      getSessionSnapshot(scenarioConfig, firstSibling.cloudAgentSessionId, signal)
    );
    if (
      firstSiblingSnapshot.worktreeId !== created.workspaceId ||
      firstSiblingSnapshot.sandboxId !== rootSnapshot.sandboxId
    ) {
      throw new Error(
        `first sibling did not join the workspace: worktree=${firstSiblingSnapshot.worktreeId ?? 'none'} sandbox=${firstSiblingSnapshot.sandboxId ?? 'none'}; root sandbox=${rootSnapshot.sandboxId}`
      );
    }
    if (firstSiblingSnapshot.parentSessionId !== null) {
      throw new Error('first sibling is not a root session');
    }

    const secondSibling = await deadline.within(
      'second sibling',
      signal =>
        createHostedWorkspaceSession(
          scenarioConfig,
          {
            workspaceId: created.workspaceId,
            prompt: `echo:${rootMarkers.secondSibling}`,
          },
          signal
        ),
      REMOTE_TURN_BUDGET_MS
    );
    owned.register({ ...secondSibling, worktreeId: created.workspaceId });
    await requireDurableCompletion(
      deadline,
      scenarioConfig,
      secondSibling,
      secondSibling.messageId,
      'second sibling'
    );

    const catalogBefore = await deadline.within('catalog before delete', signal =>
      getHostedWorkspace(scenarioConfig, created.workspaceId, signal)
    );
    if (!catalogBefore || catalogBefore.sessions.length !== 3) {
      throw new Error(
        `workspace catalog listed ${catalogBefore?.sessions.length ?? 0} roots; expected 3`
      );
    }
    const rootIds = new Set(catalogBefore.sessions.map(session => session.cloudAgentSessionId));
    for (const id of [
      created.cloudAgentSessionId,
      firstSibling.cloudAgentSessionId,
      secondSibling.cloudAgentSessionId,
    ]) {
      if (!rootIds.has(id)) throw new Error(`workspace catalog is missing root ${id}`);
    }

    await deadline.within(
      'delete first sibling',
      signal =>
        deleteHostedWorkspaceSession(
          scenarioConfig,
          {
            workspaceId: created.workspaceId,
            sessionId: firstSibling.cloudAgentSessionId,
          },
          signal
        ),
      REMOTE_TURN_BUDGET_MS
    );

    const afterFirstDelete = await deadline.within('catalog after delete', signal =>
      getHostedWorkspace(scenarioConfig, created.workspaceId, signal)
    );
    const remaining = new Set(
      afterFirstDelete?.sessions.map(session => session.cloudAgentSessionId) ?? []
    );
    if (afterFirstDelete?.deletionState !== 'active') {
      throw new Error('deleting one root changed the workspace lifecycle state');
    }
    if (remaining.size !== 2 || remaining.has(firstSibling.cloudAgentSessionId)) {
      throw new Error(
        `workspace after sibling delete has roots [${[...remaining].join(', ')}]; expected the other two`
      );
    }
    if (afterFirstDelete?.gitUrl !== catalogBefore?.gitUrl) {
      throw new Error('deleting one root changed the workspace repository');
    }
    if (afterFirstDelete?.profileId !== profileId) {
      throw new Error('deleting one root changed the workspace profile');
    }

    const survivor = await deadline.within('survivor snapshot', signal =>
      getSessionSnapshot(scenarioConfig, secondSibling.cloudAgentSessionId, signal)
    );
    if (survivor.sandboxId !== rootSnapshot.sandboxId) {
      throw new Error('deleting a sibling changed the surviving workspace allocation');
    }

    await deadline.within(
      'delete second sibling',
      signal =>
        deleteHostedWorkspaceSession(
          scenarioConfig,
          { workspaceId: created.workspaceId, sessionId: secondSibling.cloudAgentSessionId },
          signal
        ),
      REMOTE_TURN_BUDGET_MS
    );
    const afterSecondDelete = await deadline.within('catalog after second delete', signal =>
      getHostedWorkspace(scenarioConfig, created.workspaceId, signal)
    );
    const afterSecondDeleteIds = new Set(
      afterSecondDelete?.sessions.map(session => session.cloudAgentSessionId) ?? []
    );
    if (afterSecondDeleteIds.size !== 1 || !afterSecondDeleteIds.has(created.cloudAgentSessionId)) {
      throw new Error(
        `workspace after the second sibling delete has roots [${[...afterSecondDeleteIds].join(', ')}]; expected only the original root`
      );
    }

    let finalRejection: string | undefined;
    try {
      await deadline.within(
        'second final root delete',
        signal =>
          deleteHostedWorkspaceSession(
            scenarioConfig,
            { workspaceId: created.workspaceId, sessionId: created.cloudAgentSessionId },
            signal
          ),
        FINAL_ROOT_REJECTION_DEADLINE_MS
      );
    } catch (error) {
      finalRejection = error instanceof Error ? error.message : String(error);
    }
    if (
      finalRejection === undefined ||
      !finalRejection.includes('workspace_requires_root_session')
    ) {
      throw new Error(
        `deleting the last remaining root was not rejected with workspace_requires_root_session: ${finalRejection ?? 'no error'}`
      );
    }
    const stillRoot = await deadline.within('snapshot after final rejection', signal =>
      getSessionSnapshot(scenarioConfig, created.cloudAgentSessionId, signal)
    );
    if (stillRoot.worktreeId !== created.workspaceId) {
      throw new Error('final-root rejection destroyed or detached the last root');
    }

    result = {
      name: scenarioName,
      conversation,
      ok: true,
      message: [
        `root=${created.cloudAgentSessionId}`,
        `workspace=${created.workspaceId}`,
        `sandbox=${rootSnapshot.sandboxId}`,
        'siblingsByWorkspaceId=2',
        'siblingJoinedWorkspace=true',
        'catalogRoots=3->2->1',
        'middleDeletePreservedWorkspace=true',
        'finalRootRejected=true',
      ].join('; '),
      events: [],
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    result = fail(error instanceof Error ? error.message : String(error));
  } finally {
    await cleanupRemainingRoots(scenarioConfig, workspaceId);
    await owned.cleanup(scenarioName);
  }
  return result;
}

export const HOSTED_WORKSPACE_SCENARIOS: Record<string, SharedScenario> = {
  ...HOSTED_WORKSPACE_CONTRACT_SCENARIOS,
  'hosted-workspace-sessions': {
    name: 'hosted-workspace-sessions',
    requires: ['sessionSandbox', 'database'],
    defaultApi: 'unified',
    defaultConversation: '_',
    defaultTimeoutMs: HOSTED_WORKSPACE_TIMEOUT_MS,
    run: runHostedWorkspaceSessions,
  },
};
