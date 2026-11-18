/**
 * `hosted-workspace-contract` — the complete workspace-first Cloud proof.
 *
 * `hosted-workspace-sessions` proves the mutation surface (create, two siblings,
 * the 3->2->1 catalog, a middle delete and the final-root rejection). This
 * scenario proves the rest of the contract an Agent Manager Session Host will
 * consume: authorization and idempotency, one shared sandbox per workspace,
 * independent turn abort, passive no-wake workspace status, automatic idle
 * shutdown and wake-on-input, a second-repository workspace with its own
 * sandbox, and journaled whole-workspace deletion with a replayable tombstone.
 *
 * It drives the public tRPC surface against the real Worker, Session/Sandbox
 * Durable Objects, Docker sandbox and the deterministic fake LLM. Provider
 * faults cannot be injected here; the deletion-journal resume and stale
 * generation cases remain covered at the handler/integration layer, while this
 * scenario proves the real deletion, journal projection, tombstone replay and
 * post-delete rejection.
 */

import { randomUUID } from 'node:crypto';
import { computeDatabaseUrl, createDrizzleClient } from '@kilocode/db';
import { createProfile } from '@kilocode/cloud-agent-profile';
import {
  answerQuestion,
  createHostedWorkspace,
  createHostedWorkspaceSession,
  deleteHostedWorkspaceSession,
  deleteWorktree,
  fakeDirective,
  fetchFakeRequests,
  getHostedWorkspace,
  getHostedWorkspaceStatus,
  getMessageResult,
  getSessionSnapshot,
  hasPreparationForMessage,
  interruptSession,
  listHostedWorkspaces,
  openConnectedStream,
  sendMessage,
  type DriverConfig,
  type HostedWorkspaceStatus,
} from './client.js';
import { ensureTestUser, mintApiToken } from './auth.js';
import { cleanupRemoteSession } from './scenarios-shared.js';
import {
  awaitDurableTerminal,
  createOwnedSessionRegistry,
  createScenarioDeadline,
  readAllocation,
  requireContainer,
  requireRunning,
  sendTurn,
  sessionSandboxObservation,
  waitForPacedProgress,
  waitForPresentAllocation,
  type ScenarioDeadline,
} from './scenarios-shared-runtime.js';
import { assertScenarioPreconditions } from './public-surface-support.js';
import type { LifecycleArgs, LifecycleResult } from './lifecycle.js';
import type { SharedScenario } from './scenarios-shared.js';
import type { ScenarioEnvironment } from './scenario-capabilities.js';

const HOSTED_CONTRACT_TIMEOUT_MS = 50 * 60_000;
/** Generous budget for real first-container cold starts on both workspaces. */
const BOOT_TURN_BUDGET_MS = 300_000;
/** Per-turn budget once the workspace is warm. */
const TURN_BUDGET_MS = 180_000;
/** Long enough for the cold sandbox to accept and start a paced turn. */
const PACED_PROGRESS_BUDGET_MS = 60_000;
/** Unattended interval: the idle deadline plus stop confirmation. */
const IDLE_OBSERVATION_BUDGET_MS = 15 * 60_000;
const IDLE_POLL_INTERVAL_MS = 15_000;
/** Negative window for a provider create after a passive read. */
const NO_WAKE_WINDOW_MS = 10_000;
const CLEANUP_REQUEST_TIMEOUT_MS = 30_000;
/** Allowed skew between the reported idle deadline and the observed stop. */
const IDLE_SLEEP_GRACE_MS = 20_000;
const FOREIGN_USER_EMAIL = 'e2e-hosted-workspace-foreign@example.com';
const DEFAULT_SECOND_GIT_URL = 'https://github.com/octocat/Spoon-Knife.git';
const PROFILE_CREATE_FAILED = 'persistent_profile_unavailable';

async function requireDurableCompletion(
  deadline: ScenarioDeadline,
  config: DriverConfig,
  session: { cloudAgentSessionId: string },
  messageId: string,
  label: string
): Promise<void> {
  const status = await deadline.within(`${label} durable`, async signal => {
    for (;;) {
      const current = await awaitDurableTerminal(
        config,
        session.cloudAgentSessionId,
        messageId,
        Math.min(TURN_BUDGET_MS, deadline.remaining(`${label} durable`)),
        signal
      );
      if (current === 'completed' || current === 'failed' || current === 'interrupted') {
        return current;
      }
    }
  });
  if (status !== 'completed') throw new Error(`${label} turn durable status=${status}`);
}

/** Require the operation to fail with the stable contract fragment. */
async function expectFailure(
  operation: Promise<unknown>,
  fragment: string,
  label: string
): Promise<string> {
  try {
    await operation;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(fragment)) {
      throw new Error(`${label}: expected failure containing "${fragment}", got: ${message}`);
    }
    return message;
  }
  throw new Error(`${label}: expected failure containing "${fragment}", but it succeeded`);
}

function observationEndFor(startedAt: number): number {
  return startedAt + IDLE_OBSERVATION_BUDGET_MS;
}

function assertSleepingPassiveStatus(status: HostedWorkspaceStatus, label: string): void {
  if (status.deletionState !== 'active') {
    throw new Error(`${label}: deletionState=${status.deletionState}; expected active`);
  }
  if (status.compute.status !== 'sleeping') {
    throw new Error(
      `${label}: compute=${status.compute.status}/${status.compute.detailCode}; expected sleeping`
    );
  }
  if (!status.wakeOnInput.available) {
    throw new Error(
      `${label}: wakeOnInput unavailable (${status.wakeOnInput.blockedReason ?? 'none'})`
    );
  }
  if (status.activity.hasActiveTurn) {
    throw new Error(`${label}: passive read reported an active turn`);
  }
}

function foreignConfigFor(config: DriverConfig, user: { id: string }): DriverConfig {
  return {
    ...config,
    user,
    bearerToken: mintApiToken(user, config.nextAuthSecret),
    onSessionCreated: undefined,
  };
}

export async function runHostedWorkspaceContract(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config: baseConfig, conversation, timeoutMs = HOSTED_CONTRACT_TIMEOUT_MS } = args;
  const scenarioName = 'hosted-workspace-contract';
  const sandbox = sessionSandboxObservation(env);
  const containerInspection = env.sandbox;
  if (!containerInspection) throw new Error('sandbox capability is required');
  const owned = createOwnedSessionRegistry(baseConfig, cleanupRemoteSession);
  const config = owned.config;
  const deadline = createScenarioDeadline(startedAt, timeoutMs);
  const runId = randomUUID();

  let workspaceA: string | undefined;
  let workspaceB: string | undefined;
  let workspaceADeleted = false;
  let stream = undefined as Awaited<ReturnType<typeof openConnectedStream>> | undefined;
  const evidence: string[] = [];

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message,
    events: [],
    durationMs: Date.now() - startedAt,
  });

  try {
    assertScenarioPreconditions(config, args.api);
    const databaseUrl =
      env.database?.url ?? (env.profile === 'local' ? computeDatabaseUrl() : undefined);
    if (!databaseUrl) throw new Error(PROFILE_CREATE_FAILED);
    const secondGitUrl = process.env.E2E_SECOND_GIT_URL ?? DEFAULT_SECOND_GIT_URL;
    if (secondGitUrl === config.gitUrl) {
      throw new Error(
        'E2E_SECOND_GIT_URL must differ from E2E_GIT_URL; the workspace proof needs a second repository'
      );
    }

    const dbClient = createDrizzleClient({
      connectionString: databaseUrl,
      poolConfig: { max: 1 },
      ssl: false,
    });
    let profileId: string;
    let foreignConfig: DriverConfig;
    try {
      const profile = await createProfile(
        dbClient.db,
        { type: 'user', id: config.user.id },
        config.user.id,
        `e2e-hosted-contract-${runId}`
      );
      profileId = profile.id;
      const foreignUser = await ensureTestUser(databaseUrl, FOREIGN_USER_EMAIL);
      foreignConfig = foreignConfigFor(config, foreignUser);
    } catch (error) {
      throw new Error(`${PROFILE_CREATE_FAILED}: ${String(error)}`);
    } finally {
      await dbClient.pool.end().catch(() => undefined);
    }

    const markers = {
      root: `hwc-root-${runId}`,
      siblingOne: `hwc-sib1-${runId}`,
      siblingTwo: `hwc-sib2-${runId}`,
      secondRepo: `hwc-repo2-${runId}`,
      abort: `hwc-abort-${runId}`,
      wake: `hwc-wake-${runId}`,
    };

    // 1. Idempotent create: same key replays, changed intent conflicts.
    const createKey = randomUUID();
    const root = await deadline.within(
      'create workspace',
      signal =>
        createHostedWorkspace(
          config,
          {
            operationKey: createKey,
            profileId,
            prompt: fakeDirective(`echo:${markers.root}`),
          },
          signal
        ),
      BOOT_TURN_BUDGET_MS
    );
    workspaceA = root.workspaceId;
    const workspaceId = root.workspaceId;
    const readStatus = (signal?: AbortSignal): Promise<HostedWorkspaceStatus> =>
      getHostedWorkspaceStatus(config, { workspaceId }, signal);
    owned.register(root);
    if (!root.workspaceId.startsWith('worktree_')) {
      throw new Error(`create returned workspaceId=${root.workspaceId}; expected worktree_*`);
    }
    if (!root.cloudAgentSessionId.startsWith('workspace_')) {
      throw new Error(`create returned session=${root.cloudAgentSessionId}; expected workspace_*`);
    }
    const replayedCreate = await deadline.within('create replay', signal =>
      createHostedWorkspace(
        config,
        {
          operationKey: createKey,
          profileId,
          prompt: fakeDirective(`echo:${markers.root}`),
        },
        signal
      )
    );
    if (
      replayedCreate.replayed !== true ||
      replayedCreate.workspaceId !== root.workspaceId ||
      replayedCreate.cloudAgentSessionId !== root.cloudAgentSessionId ||
      replayedCreate.messageId !== root.messageId
    ) {
      throw new Error('same-key workspace create did not replay the canonical result');
    }
    await deadline.within('create conflict', signal =>
      expectFailure(
        createHostedWorkspace(
          config,
          {
            operationKey: createKey,
            profileId,
            prompt: fakeDirective(`echo:${markers.siblingOne}`),
          },
          signal
        ),
        'session_create_intent_conflict',
        'changed-intent workspace create'
      )
    );
    evidence.push('createReplay=true', 'createChangedIntentConflict=true');

    await requireDurableCompletion(deadline, config, root, root.messageId, 'root');
    const rootSnapshot = await deadline.within('root snapshot', signal =>
      getSessionSnapshot(config, root.cloudAgentSessionId, signal)
    );
    if (rootSnapshot.worktreeId !== workspaceA) {
      throw new Error(
        `root worktreeId=${rootSnapshot.worktreeId ?? 'none'}; expected ${workspaceA}`
      );
    }
    if (!rootSnapshot.sandboxId) throw new Error('root did not expose a durable sandbox id');
    const rootContainer = await deadline.within(
      'root container',
      signal => requireContainer(sandbox, root, BOOT_TURN_BUDGET_MS, signal),
      BOOT_TURN_BUDGET_MS
    );
    if (rootContainer === null) throw new Error('root did not expose a physical allocation');

    // A warm workspace status reports the real idle deadline and an open interval.
    const warmStatus = await deadline.within('warm status', signal => readStatus(signal));
    if (warmStatus.compute.status !== 'active') {
      throw new Error(
        `warm status compute=${warmStatus.compute.status}/${warmStatus.compute.detailCode}; expected active`
      );
    }
    if (warmStatus.compute.estimatedSleepAt === null) {
      throw new Error('warm status did not report an idle-stop deadline');
    }
    if (warmStatus.billing.intervalStartedAt === null) {
      throw new Error('warm status did not report the open billing interval');
    }
    evidence.push(
      `warmIdleDeadlineAt=${warmStatus.compute.estimatedSleepAt}`,
      'warmBillingInterval=true'
    );

    // 2. Siblings are created by workspace id only and share the workspace.
    const siblingKey = randomUUID();
    const siblingOne = await deadline.within('sibling one', signal =>
      createHostedWorkspaceSession(
        config,
        {
          workspaceId: workspaceId,
          operationKey: siblingKey,
          prompt: fakeDirective(`echo:${markers.siblingOne}`),
        },
        signal
      )
    );
    owned.register(siblingOne);
    const replayedSibling = await deadline.within('sibling replay', signal =>
      createHostedWorkspaceSession(
        config,
        {
          workspaceId: workspaceId,
          operationKey: siblingKey,
          prompt: fakeDirective(`echo:${markers.siblingOne}`),
        },
        signal
      )
    );
    if (
      replayedSibling.replayed !== true ||
      replayedSibling.cloudAgentSessionId !== siblingOne.cloudAgentSessionId
    ) {
      throw new Error('same-key sibling create did not replay the canonical result');
    }
    await deadline.within('sibling conflict', signal =>
      expectFailure(
        createHostedWorkspaceSession(
          config,
          {
            workspaceId: workspaceId,
            operationKey: siblingKey,
            prompt: fakeDirective(`echo:${markers.siblingTwo}`),
          },
          signal
        ),
        'operation_key_reuse_mismatch',
        'changed-intent sibling create'
      )
    );
    evidence.push('siblingReplay=true', 'siblingChangedIntentConflict=true');

    const siblingTwo = await deadline.within('sibling two', signal =>
      createHostedWorkspaceSession(
        config,
        { workspaceId: workspaceId, prompt: fakeDirective(`echo:${markers.siblingTwo}`) },
        signal
      )
    );
    owned.register(siblingTwo);
    await requireDurableCompletion(
      deadline,
      config,
      siblingOne,
      siblingOne.messageId,
      'sibling one'
    );
    await requireDurableCompletion(
      deadline,
      config,
      siblingTwo,
      siblingTwo.messageId,
      'sibling two'
    );

    for (const sibling of [siblingOne, siblingTwo]) {
      if (sibling.workspaceId !== workspaceA) {
        throw new Error('sibling create returned a different workspace id');
      }
      const snapshot = await deadline.within(`${sibling.cloudAgentSessionId} snapshot`, signal =>
        getSessionSnapshot(config, sibling.cloudAgentSessionId, signal)
      );
      if (snapshot.worktreeId !== workspaceA || snapshot.sandboxId !== rootSnapshot.sandboxId) {
        throw new Error(
          `sibling did not join the workspace: worktree=${snapshot.worktreeId ?? 'none'} sandbox=${
            snapshot.sandboxId ?? 'none'
          }; root sandbox=${rootSnapshot.sandboxId}`
        );
      }
      if (snapshot.parentSessionId !== null) throw new Error('sibling is not a root session');
    }
    const catalogWithThree = await deadline.within('catalog three', signal =>
      getHostedWorkspace(config, workspaceId, signal)
    );
    if (!catalogWithThree || catalogWithThree.sessions.length !== 3) {
      throw new Error(
        `workspace catalog listed ${catalogWithThree?.sessions.length ?? 0} roots; expected 3`
      );
    }
    evidence.push(`workspace=${workspaceA}`, `sandbox=${rootContainer}`, 'sharedSandbox=true');

    // 3. Authorization: another user sees nothing and cannot mutate the workspace.
    const foreignList = await deadline.within('foreign list', signal =>
      listHostedWorkspaces(foreignConfig, { limit: 50 }, signal)
    );
    if (foreignList.items.some(item => item.workspaceId === workspaceA)) {
      throw new Error('a foreign user can list another user’s workspace');
    }
    const foreignGet = await deadline.within('foreign get', signal =>
      getHostedWorkspace(foreignConfig, workspaceId, signal)
    );
    if (foreignGet !== null) throw new Error('a foreign user can read another user’s workspace');
    await deadline.within('foreign status', signal =>
      expectFailure(
        getHostedWorkspaceStatus(foreignConfig, { workspaceId: workspaceId }, signal),
        'NOT_FOUND',
        'foreign workspace status'
      )
    );
    await deadline.within('foreign sibling create', signal =>
      expectFailure(
        createHostedWorkspaceSession(
          foreignConfig,
          { workspaceId: workspaceId, prompt: fakeDirective('echo:foreign') },
          signal
        ),
        'workspace_unavailable',
        'foreign sibling create'
      )
    );
    await deadline.within('foreign delete', signal =>
      expectFailure(
        deleteHostedWorkspaceSession(
          foreignConfig,
          { workspaceId: workspaceId, sessionId: root.cloudAgentSessionId },
          signal
        ),
        'NOT_FOUND',
        'foreign root delete'
      )
    );
    const foreignOrgScope = randomUUID();
    await deadline.within('org scope', signal =>
      expectFailure(
        getHostedWorkspaceStatus(
          config,
          { workspaceId: workspaceId, kilocodeOrganizationId: foreignOrgScope },
          signal
        ),
        'FORBIDDEN',
        'org scope mismatch'
      )
    );
    evidence.push('foreignOwnerIsolated=true', 'orgScopeRejected=true');

    // 4. Abort one turn; the siblings and workspace runtime survive.
    stream = await deadline.within('abort stream', signal =>
      openConnectedStream(config, siblingTwo.cloudAgentSessionId, false, undefined, signal)
    );
    const requestsBefore = await deadline.within('abort baseline', signal =>
      fetchFakeRequests(config.fakeLlmUrl, signal)
    );
    const held = await deadline.within('abort send', signal =>
      sendMessage(
        config,
        {
          cloudAgentSessionId: siblingTwo.cloudAgentSessionId,
          prompt: fakeDirective(`slow:90:1000:16:${markers.abort}`),
          signal,
        },
        'unified'
      )
    );
    await waitForPacedProgress(
      config,
      stream,
      held.messageId,
      requestsBefore.chatCompletions,
      deadline,
      PACED_PROGRESS_BUDGET_MS,
      'abort turn progress'
    );
    await requireRunning(
      config,
      siblingTwo.cloudAgentSessionId,
      held.messageId,
      deadline,
      'abort turn'
    );
    await deadline.within('interrupt', signal =>
      interruptSession(config, siblingTwo.cloudAgentSessionId, signal)
    );
    const interrupted = await deadline.within('interrupt durable', signal =>
      awaitDurableTerminal(
        config,
        siblingTwo.cloudAgentSessionId,
        held.messageId,
        TURN_BUDGET_MS,
        signal
      )
    );
    if (interrupted !== 'interrupted') {
      throw new Error(`aborted turn durable status=${interrupted}; expected interrupted`);
    }
    stream.close();
    stream = undefined;
    for (const sibling of [root, siblingOne]) {
      const durable = await deadline.within('sibling transcript', signal =>
        getMessageResult(config, sibling.cloudAgentSessionId, sibling.messageId, signal)
      );
      if (durable.status !== 'completed') {
        throw new Error(`aborting one turn disturbed sibling ${sibling.cloudAgentSessionId}`);
      }
    }
    const runtimeAfterAbort = await readAllocation(deadline, sandbox, root, 'post-abort runtime');
    if (runtimeAfterAbort !== rootContainer) {
      throw new Error('aborting one turn replaced the shared workspace allocation');
    }
    evidence.push('turnAborted=true', 'siblingsIntact=true', 'abortKeptRuntime=true');

    // 5. Child deletion preserves the workspace; the final root is protected.
    const runtimeBeforeDelete = await readAllocation(deadline, sandbox, root, 'pre-delete runtime');
    await deadline.within('delete middle', signal =>
      deleteHostedWorkspaceSession(
        config,
        { workspaceId: workspaceId, sessionId: siblingOne.cloudAgentSessionId },
        signal
      )
    );
    const afterMiddle = await deadline.within('catalog after middle', signal =>
      getHostedWorkspace(config, workspaceId, signal)
    );
    const middleRemaining = new Set(
      afterMiddle?.sessions.map(session => session.cloudAgentSessionId) ?? []
    );
    if (
      afterMiddle?.deletionState !== 'active' ||
      middleRemaining.size !== 2 ||
      middleRemaining.has(siblingOne.cloudAgentSessionId)
    ) {
      throw new Error('deleting one non-final root changed the workspace lifecycle');
    }
    if (afterMiddle?.gitUrl !== catalogWithThree.gitUrl || afterMiddle?.profileId !== profileId) {
      throw new Error('deleting one non-final root changed workspace metadata');
    }
    const runtimeAfterMiddle = await readAllocation(deadline, sandbox, root, 'post-middle runtime');
    if (runtimeAfterMiddle !== runtimeBeforeDelete) {
      throw new Error('deleting one non-final root changed the surviving allocation');
    }
    await deadline.within('delete second sibling', signal =>
      deleteHostedWorkspaceSession(
        config,
        { workspaceId: workspaceId, sessionId: siblingTwo.cloudAgentSessionId },
        signal
      )
    );
    const afterChildDeletes = await deadline.within('status after child deletes', signal =>
      readStatus(signal)
    );
    if (
      afterChildDeletes.billing.intervalStartedAt !== warmStatus.billing.intervalStartedAt ||
      afterChildDeletes.billing.payer === null
    ) {
      throw new Error(
        'deleting non-final roots changed the workspace billing identity or interval'
      );
    }
    // `deletion.sessionCount` is the journal manifest size, which an active
    // workspace reports as zero until deletion starts.
    if (
      afterChildDeletes.deletion.started ||
      afterChildDeletes.deletion.phase !== 'not_started' ||
      afterChildDeletes.deletion.deletedSessionIds.length !== 0
    ) {
      throw new Error(
        `status after child deletes reports deletion=${afterChildDeletes.deletion.phase}`
      );
    }
    evidence.push('childDeletesKeptBillingInterval=true');

    const afterSecond = await deadline.within('catalog after second', signal =>
      getHostedWorkspace(config, workspaceId, signal)
    );
    if (
      afterSecond?.sessions.length !== 1 ||
      afterSecond.sessions[0]?.cloudAgentSessionId !== root.cloudAgentSessionId
    ) {
      throw new Error('workspace after the second child delete did not keep only the root');
    }
    await deadline.within('final root delete', signal =>
      expectFailure(
        deleteHostedWorkspaceSession(
          config,
          { workspaceId: workspaceId, sessionId: root.cloudAgentSessionId },
          signal
        ),
        'workspace_requires_root_session',
        'final root delete'
      )
    );
    const rootAfterRejection = await deadline.within('root after rejection', signal =>
      getSessionSnapshot(config, root.cloudAgentSessionId, signal)
    );
    if (rootAfterRejection.worktreeId !== workspaceA) {
      throw new Error('final-root rejection destroyed the last root');
    }
    evidence.push('catalog3to2to1=true', 'finalRootRejected=true');

    // 6. Passive reads must not wake the idle-stopped workspace.
    const idleDeadline = afterChildDeletes.compute.estimatedSleepAt;
    if (idleDeadline === null) throw new Error('post-activity status lost its idle-stop deadline');
    const baselineAt = Date.now();
    if (idleDeadline <= baselineAt) {
      throw new Error('post-activity idle-stop deadline expired before observation started');
    }
    if (idleDeadline > observationEndFor(baselineAt)) {
      throw new Error(
        `idle deadline ${idleDeadline} is beyond the ${IDLE_OBSERVATION_BUDGET_MS}ms observation budget`
      );
    }
    const presentBeforeIdle = await waitForPresentAllocation(
      deadline,
      sandbox,
      root,
      'sleep baseline',
      30_000
    );
    if (presentBeforeIdle === null) {
      throw new Error('workspace allocation was already absent before the idle window started');
    }
    let absentAt: number | null = null;
    const observationEnd = baselineAt + IDLE_OBSERVATION_BUDGET_MS;
    while (Date.now() < observationEnd) {
      const wait = Math.min(IDLE_POLL_INTERVAL_MS, observationEnd - Date.now());
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      if (Date.now() >= observationEnd) break;
      const observed = await readAllocation(deadline, sandbox, root, 'idle sample');
      if (observed === null) {
        absentAt = Date.now() - baselineAt;
        break;
      }
      if (observed !== presentBeforeIdle) {
        throw new Error(
          `allocation replaced while unattended: ${presentBeforeIdle} -> ${observed}`
        );
      }
    }
    if (absentAt === null) {
      throw new Error(
        `workspace allocation was still present after ${IDLE_OBSERVATION_BUDGET_MS}ms of idleness`
      );
    }
    const observedIdleDeadline = idleDeadline - baselineAt;
    if (absentAt + IDLE_SLEEP_GRACE_MS < observedIdleDeadline) {
      throw new Error(
        `workspace stopped ${observedIdleDeadline - absentAt}ms before the idle deadline reported by status`
      );
    }
    evidence.push(
      `statusIdleDeadlineAt=+${observedIdleDeadline}ms`,
      `stoppedAfterDeadline=${absentAt >= observedIdleDeadline}`
    );

    const knownContainerIds = await containerInspection.snapshotContainerIds();
    const statusBeforeReads = await deadline.within('sleeping status', signal =>
      readStatus(signal)
    );
    assertSleepingPassiveStatus(statusBeforeReads, 'sleeping status before passive reads');
    const intervalBeforeReads = statusBeforeReads.billing.intervalStartedAt;

    const catalogWhileSleeping = await deadline.within('sleeping catalog', signal =>
      listHostedWorkspaces(config, { limit: 50 }, signal)
    );
    if (!catalogWhileSleeping.items.some(item => item.workspaceId === workspaceA)) {
      throw new Error('passive catalog read did not return the sleeping workspace');
    }
    const getWhileSleeping = await deadline.within('sleeping get', signal =>
      getHostedWorkspace(config, workspaceId, signal)
    );
    if (getWhileSleeping?.sessions.length !== 1) {
      throw new Error('passive workspace get did not return the remaining root');
    }
    const snapshotWhileSleeping = await deadline.within('sleeping session read', signal =>
      getSessionSnapshot(config, root.cloudAgentSessionId, signal)
    );
    if (snapshotWhileSleeping.worktreeId !== workspaceA) {
      throw new Error('passive session read did not return the workspace identity');
    }
    const transcriptWhileSleeping = await deadline.within('sleeping transcript', signal =>
      getMessageResult(config, root.cloudAgentSessionId, root.messageId, signal)
    );
    if (transcriptWhileSleeping.status !== 'completed') {
      throw new Error('durable transcript was not readable while the workspace slept');
    }
    const statusAfterReads = await deadline.within('sleeping status after', signal =>
      readStatus(signal)
    );
    assertSleepingPassiveStatus(statusAfterReads, 'sleeping status after passive reads');
    if (statusAfterReads.billing.intervalStartedAt !== intervalBeforeReads) {
      throw new Error('a passive read changed the workspace billing interval');
    }
    const allocationAfterReads = await readAllocation(
      deadline,
      sandbox,
      root,
      'post-read allocation'
    );
    if (allocationAfterReads !== null) {
      throw new Error('a passive workspace read allocated a runtime');
    }
    const createdContainer = await deadline.within(
      'no-wake provider create',
      signal =>
        containerInspection.waitForOwnedContainer({
          cloudAgentSessionId: root.cloudAgentSessionId,
          kiloSessionId: root.kiloSessionId,
          knownIds: knownContainerIds,
          timeoutMs: NO_WAKE_WINDOW_MS,
          signal,
        }),
      NO_WAKE_WINDOW_MS + 5_000
    );
    if (createdContainer !== null) {
      throw new Error('a passive workspace read created a provider container');
    }
    evidence.push(
      `idleStopAtMs=${absentAt}`,
      'passiveReadsNoWake=true',
      'noBillingIntervalStart=true'
    );

    // 7. Ordinary input wakes the workspace through the existing lifecycle.
    const wake = await sendTurn(
      deadline,
      config,
      root.cloudAgentSessionId,
      fakeDirective(`echo:${markers.wake}`),
      'wake turn',
      TURN_BUDGET_MS
    );
    try {
      if (!hasPreparationForMessage(wake.stream.events, wake.messageId)) {
        throw new Error('wake turn did not report a preparing event');
      }
      const wokenAllocation = await waitForPresentAllocation(
        deadline,
        sandbox,
        root,
        'woken',
        TURN_BUDGET_MS
      );
      if (wokenAllocation === null) {
        throw new Error('ordinary input did not restore a workspace allocation');
      }
    } finally {
      wake.stream.close();
    }
    evidence.push('wakeOnInput=true');

    // 8. A second repository gets its own workspace, sandbox and catalog entry.
    const workspaceBAssigned = await deadline.within(
      'create second repo workspace',
      signal =>
        createHostedWorkspace(
          config,
          {
            profileId,
            prompt: fakeDirective(`echo:${markers.secondRepo}`),
            repository: { type: 'git', url: secondGitUrl },
          },
          signal
        ),
      BOOT_TURN_BUDGET_MS
    );
    workspaceB = workspaceBAssigned.workspaceId;
    const secondWorkspaceId = workspaceBAssigned.workspaceId;
    owned.register(workspaceBAssigned);
    if (workspaceB === workspaceA) {
      throw new Error('the second-repository workspace reused the first workspace identity');
    }
    await requireDurableCompletion(
      deadline,
      config,
      workspaceBAssigned,
      workspaceBAssigned.messageId,
      'second repo root'
    );
    const secondSnapshot = await deadline.within('second repo snapshot', signal =>
      getSessionSnapshot(config, workspaceBAssigned.cloudAgentSessionId, signal)
    );
    if (secondSnapshot.worktreeId !== workspaceB) {
      throw new Error('the second-repository root did not join its own workspace');
    }
    const secondContainer = await deadline.within(
      'second repo container',
      signal => requireContainer(sandbox, workspaceBAssigned, BOOT_TURN_BUDGET_MS, signal),
      BOOT_TURN_BUDGET_MS
    );
    if (secondContainer === null) {
      throw new Error('the second-repository workspace did not expose a physical allocation');
    }
    if (secondContainer === rootContainer) {
      throw new Error('the second repository reused the first workspace sandbox');
    }
    const catalogA = await deadline.within('catalog A', signal =>
      getHostedWorkspace(config, workspaceId, signal)
    );
    const catalogB = await deadline.within('catalog B', signal =>
      getHostedWorkspace(config, secondWorkspaceId, signal)
    );
    const repositoryA = catalogA?.gitUrl;
    const repositoryB = catalogB?.gitUrl;
    if (
      typeof repositoryA !== 'string' ||
      typeof repositoryB !== 'string' ||
      repositoryA === repositoryB
    ) {
      throw new Error('the two workspaces did not expose distinct repository identities');
    }
    const filteredA = await deadline.within('repo filter A', signal =>
      listHostedWorkspaces(config, { repositoryUrl: repositoryA, limit: 50 }, signal)
    );
    if (!filteredA.items.some(item => item.workspaceId === workspaceA)) {
      throw new Error('the repository filter did not return the first workspace');
    }
    if (filteredA.items.some(item => item.workspaceId === workspaceB)) {
      throw new Error('the repository filter leaked the second workspace');
    }
    evidence.push(
      `workspaceB=${workspaceB}`,
      `secondRepo=${repositoryB}`,
      `separateSandbox=${secondContainer !== rootContainer}`
    );

    // 9. Journaled whole-workspace deletion removes the final root and replays.
    const deletion = await deadline.within(
      'delete workspace',
      signal => deleteWorktree(config, { worktreeId: workspaceId }, signal),
      BOOT_TURN_BUDGET_MS
    );
    workspaceADeleted = true;
    if (deletion.success !== true || deletion.deletedSessionIds.length !== 1) {
      throw new Error(
        `workspace delete returned ${deletion.deletedSessionIds.length} roots; expected the final root`
      );
    }
    if (deletion.deletedSessionIds[0] !== root.kiloSessionId) {
      throw new Error('workspace delete did not report the final root session id');
    }
    const deletedStatus = await deadline.within('deleted status', signal => readStatus(signal));
    if (
      deletedStatus.deletionState !== 'deleted' ||
      !deletedStatus.deletion.completed ||
      deletedStatus.deletion.phase !== 'completed'
    ) {
      throw new Error(
        `workspace delete left state=${deletedStatus.deletionState} phase=${deletedStatus.deletion.phase}`
      );
    }
    if (
      deletedStatus.deletion.sessionCount !== deletion.deletedSessionIds.length ||
      deletedStatus.deletion.remainingRuntimeLocationCount !== 0 ||
      deletedStatus.deletion.completedRuntimeLocationCount !==
        deletedStatus.deletion.runtimeLocationCount
    ) {
      throw new Error(
        `deleted tombstone has sessions=${deletedStatus.deletion.sessionCount} locations ${deletedStatus.deletion.completedRuntimeLocationCount}/${deletedStatus.deletion.runtimeLocationCount} done and ${deletedStatus.deletion.remainingRuntimeLocationCount} remaining`
      );
    }
    if (!deletedStatus.deletion.deletedSessionIds.includes(root.kiloSessionId)) {
      throw new Error('deleted workspace status did not expose the deleted root session');
    }
    const replay = await deadline.within('delete replay', signal =>
      deleteWorktree(config, { worktreeId: workspaceId }, signal)
    );
    if (
      replay.success !== true ||
      replay.deletedSessionIds.length !== 1 ||
      replay.deletedSessionIds[0] !== deletion.deletedSessionIds[0]
    ) {
      throw new Error('repeating the workspace delete did not replay the completed tombstone');
    }
    await deadline.within('deleted transcript', signal =>
      expectFailure(
        getSessionSnapshot(config, root.cloudAgentSessionId, signal),
        'FORBIDDEN',
        'deleted session read'
      )
    );
    await deadline.within('deleted prompt', signal =>
      expectFailure(
        sendMessage(
          config,
          { cloudAgentSessionId: root.cloudAgentSessionId, prompt: 'echo:after-delete', signal },
          'unified'
        ),
        'FORBIDDEN',
        'deleted session prompt'
      )
    );
    await deadline.within('deleted answer', signal =>
      expectFailure(
        answerQuestion(config, root.cloudAgentSessionId, randomUUID(), [['answer']], signal),
        'FORBIDDEN',
        'deleted session answer'
      )
    );
    const listAfterDelete = await deadline.within('catalog after delete', signal =>
      listHostedWorkspaces(config, { limit: 50 }, signal)
    );
    if (listAfterDelete.items.some(item => item.workspaceId === workspaceA)) {
      throw new Error('the deleted workspace still appears in the active catalog');
    }
    const workspaceBAfterDelete = await deadline.within('B after A delete', signal =>
      getHostedWorkspaceStatus(config, { workspaceId: secondWorkspaceId }, signal)
    );
    if (workspaceBAfterDelete.deletionState !== 'active') {
      throw new Error('deleting the first workspace affected the second workspace');
    }
    evidence.push(
      `deletedRoots=${deletion.deletedSessionIds.length}`,
      'deletionJournalCompleted=true',
      'deleteReplay=true',
      'deletedSessionRejected=true',
      'workspaceBUnaffected=true'
    );

    // 10. Cleanup the second workspace through the same destructive operation.
    await deadline.within('delete workspace B', signal =>
      deleteWorktree(config, { worktreeId: secondWorkspaceId }, signal)
    );
    workspaceB = undefined;

    return {
      name: scenarioName,
      conversation,
      ok: true,
      message: evidence.join('; '),
      events: [],
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  } finally {
    stream?.close();
    if (!workspaceADeleted && workspaceA) {
      await deleteWorktree(
        config,
        { worktreeId: workspaceA },
        AbortSignal.timeout(CLEANUP_REQUEST_TIMEOUT_MS)
      ).catch(() => undefined);
    }
    if (workspaceB) {
      await deleteWorktree(
        config,
        { worktreeId: workspaceB },
        AbortSignal.timeout(CLEANUP_REQUEST_TIMEOUT_MS)
      ).catch(() => undefined);
    }
    await owned.cleanup(scenarioName);
  }
}

export const HOSTED_WORKSPACE_CONTRACT_SCENARIOS: Record<string, SharedScenario> = {
  'hosted-workspace-contract': {
    name: 'hosted-workspace-contract',
    requires: ['sessionSandbox', 'sandbox', 'database'],
    defaultApi: 'unified',
    defaultConversation: '_',
    defaultTimeoutMs: HOSTED_CONTRACT_TIMEOUT_MS,
    run: runHostedWorkspaceContract,
  },
};
