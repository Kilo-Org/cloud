/**
 * Physical-fault scenarios shared by the local Docker and HTTP profiles:
 * `external-kill`, `kill-mid-flight`, `wrapper-freeze-settled-reap` and
 * `wrapper-freeze-inflight-reap`.
 *
 * The induction is the identity-guarded `sandboxFaults` capability: a fault is
 * refused unless the observed container and wrapper process still match the
 * identity captured before the fault, so a replacement is never silently
 * rediscovered and killed/frozen.
 *
 * `external-kill` and `kill-mid-flight` assert the user-visible outcome: the
 * affected turn reaches a matching durable terminal and a follow-up on the SAME
 * workspace session completes on a distinct non-null allocation reference.
 *
 * The freeze scenarios additionally prove the mechanism with
 * identity-correlated `sandbox_control` evidence (the local `sandboxFaults`
 * capability reads the local worker log; the deployed profile provides no
 * `sandboxFaults`): the settled-reap `physical_committed running -> stopping`
 * cause and stopCause, the terminal `provider_stop`, the heartbeat-expiry
 * recovery outcome, no re-ready wrapper, and for the inflight variant the
 * `runtime_unhealthy` accepted-reconciliation plus the still-active route. A
 * missing cause fails; a run that merely lost the allocation and got a
 * replacement does not pass.
 *
 * No public surface can induce these faults, so every scenario that declares
 * `sandboxFaults` is `unsupported` deployed.
 */

import { randomUUID } from 'node:crypto';
import {
  fakeDirective,
  getMessageResult,
  getSessionSnapshot,
  messageIdFromEvent,
  openConnectedStream,
  prepareBrowserSession,
  releaseGate,
  waitForGateEngaged,
  type DriverConfig,
  type StreamConnection,
  type StreamEvent,
  type WorktreeSessionResult,
} from './client.js';
import {
  cleanupRemoteSession,
  collectChildMessageText,
  echoPayloadMatches,
  type SharedScenario,
} from './scenarios-shared.js';
import {
  bootToCompletion,
  createOwnedSessionRegistry,
  createScenarioDeadline,
  readAllocation,
  requireRunning,
  sendTurn,
  sessionSandboxObservation,
  startPacedHoldTurn,
  trackCreations,
  waitForPresentAllocation,
  type InFlightCreations,
  type ScenarioDeadline,
} from './scenarios-shared-runtime.js';
import { assertScenarioPreconditions } from './public-surface-support.js';
import { assertReapOutcome } from './sandbox-fault-evidence.js';
import { RECOVERY_SETTLED_REAP_REASON } from '../../src/sandbox-control/recovery-cleanup.js';
import type { LifecycleArgs, LifecycleResult } from './lifecycle.js';
import type {
  SandboxFaultObservation,
  SandboxFaultTarget,
  ScenarioEnvironment,
  SessionSandboxObservation,
} from './scenario-capabilities.js';

/** Whole-scenario budget for the fault scenarios. */
const FAULT_TIMEOUT_MS = 15 * 60_000;
const CONTAINER_BUDGET_MS = 240_000;
/** Per-turn budget once the environment is warm. */
const TURN_BUDGET_MS = 120_000;
/**
 * The post-fault message is the one that can await a replacement allocation.
 * The DO's prepare path can spend minutes before a replacement is ready, so it
 * gets a larger budget than a warm turn while staying under the scenario
 * deadline (mirrors the local `RECOVERY_BUDGET_MS`).
 */
const RECOVERY_BUDGET_MS = 8 * 60_000;
/** Bounded wait for a create that outlived the scenario deadline. */
const LATE_CREATE_SETTLE_MS = 30_000;
/** Bound for cleanup control calls, matching the other shared scenario files. */
const CLEANUP_TIMEOUT_MS = 15_000;
/** The paced hold `kill-mid-flight`'s successor and the inflight freeze use. */
const INFLIGHT_HOLD_DIRECTIVE = 'slow:120:1000:16';
const PACED_PROGRESS_BUDGET_MS = 90_000;
/** Bound for the `runtime_unhealthy` terminal after an inflight freeze. */
const UNHEALTHY_TERMINAL_BUDGET_MS = 8 * 60_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function prepareSession(
  creations: InFlightCreations<WorktreeSessionResult>,
  config: DriverConfig,
  prompt: string
): Promise<WorktreeSessionResult> {
  return creations.run('prepare session', signal =>
    prepareBrowserSession(config, { prompt, operationKey: randomUUID(), autoCommit: false }, signal)
  );
}

/**
 * Capture the guarded fault target: require a present allocation first, then
 * bind the wrapper identity observed for it. A later mismatch fails the
 * induction closed instead of acting on a replacement.
 */
async function captureFaultTarget(
  deadline: ScenarioDeadline,
  sandbox: SessionSandboxObservation,
  faults: SandboxFaultObservation,
  session: WorktreeSessionResult,
  label: string
): Promise<{ allocation: string; target: SandboxFaultTarget }> {
  const allocation = await waitForPresentAllocation(
    deadline,
    sandbox,
    session,
    label,
    CONTAINER_BUDGET_MS
  );
  if (allocation === null) throw new Error(`${label} did not expose an allocation reference`);
  const identity = await faults.captureWrapperIdentity({
    cloudAgentSessionId: session.cloudAgentSessionId,
    kiloSessionId: session.kiloSessionId,
    expectedAllocationRef: allocation,
  });
  return {
    allocation,
    target: {
      cloudAgentSessionId: session.cloudAgentSessionId,
      kiloSessionId: session.kiloSessionId,
      expectedAllocationRef: allocation,
      expectedWrapperInstanceId: identity.instanceId,
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * The durable logical sandbox id stamped on every `sandbox_control` diagnostic.
 * It is stable across an allocation replacement, so it narrows the evidence to
 * this session but cannot by itself exclude the replacement: `collectReapEvidence`
 * additionally anchors on the reaped allocation's own identity from its settled
 * stop, so a replacement's records cannot satisfy the pass rule.
 */
async function readSessionSandboxId(
  deadline: ScenarioDeadline,
  config: DriverConfig,
  session: WorktreeSessionResult
): Promise<string> {
  const snapshot = await deadline.within('sandbox id', signal =>
    getSessionSnapshot(config, session.cloudAgentSessionId, signal)
  );
  if (!snapshot.sandboxId) throw new Error('session did not expose a durable sandboxId');
  return snapshot.sandboxId;
}

/**
 * Wait for the expected allocation to stop being reported. A single `null`
 * read can be a transient miss, so two consecutive `null` reads are required
 * before the absence is accepted; a non-null read resets the count.
 */
async function waitForAllocationAbsent(
  deadline: ScenarioDeadline,
  sandbox: SessionSandboxObservation,
  session: WorktreeSessionResult,
  label: string,
  budgetMs: number
): Promise<void> {
  const end = Date.now() + Math.min(budgetMs, deadline.remaining(label));
  let consecutiveAbsent = 0;
  while (Date.now() < end) {
    const observed = await readAllocation(deadline, sandbox, session, label);
    if (observed === null) {
      consecutiveAbsent += 1;
      if (consecutiveAbsent >= 2) return;
    } else {
      consecutiveAbsent = 0;
    }
    await sleep(2_000);
  }
  throw new Error(
    `${label}: the expected allocation was still reported after ${budgetMs}ms; the provider did not stop it`
  );
}

/** Wait until the session reports a present allocation different from `previous`. */
async function waitForDistinctAllocation(
  deadline: ScenarioDeadline,
  sandbox: SessionSandboxObservation,
  session: WorktreeSessionResult,
  previous: string,
  label: string,
  budgetMs: number
): Promise<string> {
  const end = Date.now() + Math.min(budgetMs, deadline.remaining(label));
  let observed: string | null = null;
  while (Date.now() < end) {
    observed = await readAllocation(deadline, sandbox, session, label);
    if (observed !== null && observed !== previous) return observed;
    await sleep(2_000);
  }
  throw new Error(
    `${label}: no allocation distinct from ${previous} appeared (last=${observed ?? 'none'})`
  );
}

/**
 * `external-kill`: after a completed turn, kill the identity-matched owned
 * container. The same `workspace_*` session must complete a follow-up on a
 * distinct allocation reference.
 */
async function runExternalKill(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = FAULT_TIMEOUT_MS } = args;
  const scenarioName = 'external-kill';
  const sandbox = sessionSandboxObservation(env);
  const faults = env.sandboxFaults;
  if (!faults) throw new Error('sandboxFaults capability is required');
  const owned = createOwnedSessionRegistry(config, cleanupRemoteSession);
  const scenarioConfig = owned.config;
  const deadline = createScenarioDeadline(startedAt, timeoutMs);
  const creations = trackCreations<WorktreeSessionResult>(deadline, owned, scenarioName);
  const runId = randomUUID().slice(0, 8);
  const events: StreamEvent[] = [];
  const streams: StreamConnection[] = [];
  let result: LifecycleResult;

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message,
    events,
    durationMs: Date.now() - startedAt,
  });

  try {
    assertScenarioPreconditions(scenarioConfig, args.api);
    const session = await prepareSession(
      creations,
      scenarioConfig,
      fakeDirective(`echo:boot-${runId}`)
    );
    owned.register(session);
    const boot = await bootToCompletion(deadline, scenarioConfig, session, 'boot');
    streams.push(boot.stream);
    events.push(...boot.stream.events);
    if (!echoPayloadMatches(boot.text, `boot-${runId}`)) {
      return fail(`boot turn did not echo boot-${runId}`);
    }

    const { allocation, target } = await captureFaultTarget(
      deadline,
      sandbox,
      faults,
      session,
      'boot'
    );
    const killed = await faults.killOwnedContainer(target);
    if (!killed.killed) throw new Error(`killOwnedContainer reported no kill: ${killed.detail}`);

    const recovery = await sendTurn(
      deadline,
      scenarioConfig,
      session.cloudAgentSessionId,
      fakeDirective(`echo:after-kill-${runId}`),
      'recovery turn',
      RECOVERY_BUDGET_MS
    );
    streams.push(recovery.stream);
    events.push(...recovery.stream.events);
    const recoveryText = collectChildMessageText(recovery.stream.events, recovery.messageId);
    if (!echoPayloadMatches(recoveryText, `after-kill-${runId}`)) {
      return fail(`recovery turn did not echo after-kill-${runId}`);
    }
    const replacement = await waitForDistinctAllocation(
      deadline,
      sandbox,
      session,
      allocation,
      'replacement',
      RECOVERY_BUDGET_MS
    );

    result = {
      name: scenarioName,
      conversation,
      ok: true,
      message:
        `session=${session.cloudAgentSessionId}; killed=${killed.observedRef}; ` +
        `recovery=${recovery.messageId}/completed; oldRef=${allocation}!=newRef=${replacement}`,
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    result = fail(errorMessage(error));
  } finally {
    for (const stream of streams) {
      try {
        stream.close();
      } catch {
        /* ignore */
      }
    }
    for (const late of await creations.settleAll(LATE_CREATE_SETTLE_MS)) {
      owned.register(late);
    }
    await owned.cleanup(scenarioName);
  }
  return result;
}

/**
 * `kill-mid-flight`: kill the identity-matched owned container while a parked
 * `gate:<tag>` turn is actively running. The message must reach a durable
 * failure, and a follow-up must complete on a distinct allocation reference.
 * The parked hold needs the local-only `gates` capability.
 */
async function runKillMidFlight(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = FAULT_TIMEOUT_MS } = args;
  const scenarioName = 'kill-mid-flight';
  const sandbox = sessionSandboxObservation(env);
  const faults = env.sandboxFaults;
  if (!faults) throw new Error('sandboxFaults capability is required');
  if (!env.gates) throw new Error('gates capability is required');
  const owned = createOwnedSessionRegistry(config, cleanupRemoteSession);
  const scenarioConfig = owned.config;
  const deadline = createScenarioDeadline(startedAt, timeoutMs);
  const creations = trackCreations<WorktreeSessionResult>(deadline, owned, scenarioName);
  const runId = randomUUID().slice(0, 8);
  const gateTag = `killmid-${runId}`;
  const events: StreamEvent[] = [];
  const streams: StreamConnection[] = [];
  let result: LifecycleResult;

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message,
    events,
    durationMs: Date.now() - startedAt,
  });

  try {
    assertScenarioPreconditions(scenarioConfig, args.api);
    const session = await prepareSession(
      creations,
      scenarioConfig,
      fakeDirective(`gate:${gateTag}`)
    );
    owned.register(session);
    const snapshot = await deadline.within('gate snapshot', signal =>
      getSessionSnapshot(scenarioConfig, session.cloudAgentSessionId, signal)
    );
    const messageId = snapshot.initialMessageId;
    if (!messageId) throw new Error('kill-mid-flight did not expose an initial message id');
    const stream = await deadline.within('gate stream', signal =>
      openConnectedStream(scenarioConfig, session.cloudAgentSessionId, true, undefined, signal)
    );
    streams.push(stream);

    if (
      !(await deadline.within('gate engaged', signal =>
        waitForGateEngaged(
          scenarioConfig,
          gateTag,
          deadline.remaining('gate engaged'),
          undefined,
          signal
        )
      ))
    ) {
      throw new Error(`gate ${gateTag} did not engage before fault injection`);
    }
    await requireRunning(scenarioConfig, session.cloudAgentSessionId, messageId, deadline, 'gate');
    const { allocation, target } = await captureFaultTarget(
      deadline,
      sandbox,
      faults,
      session,
      'gate'
    );

    const killed = await faults.killOwnedContainer(target);
    if (!killed.killed) throw new Error(`killOwnedContainer reported no kill: ${killed.detail}`);

    const terminal = await stream.waitForTerminal(
      Math.max(1, Math.min(TURN_BUDGET_MS, deadline.remaining('killed terminal'))),
      messageId
    );
    events.push(...stream.events);
    const affected = await deadline.within('killed durable', signal =>
      getMessageResult(scenarioConfig, session.cloudAgentSessionId, messageId, signal)
    );
    if (
      terminal?.streamEventType !== 'cloud.message.failed' ||
      (affected.status !== 'failed' && affected.status !== 'interrupted')
    ) {
      throw new Error(
        `killed message ${messageId} has no matching durable failure: ` +
          `terminal=${terminal?.streamEventType ?? 'none'}; durable=${affected.status}`
      );
    }

    const recovery = await sendTurn(
      deadline,
      scenarioConfig,
      session.cloudAgentSessionId,
      fakeDirective(`echo:after-kill-${runId}`),
      'recovery turn',
      RECOVERY_BUDGET_MS
    );
    streams.push(recovery.stream);
    events.push(...recovery.stream.events);
    const recoveryText = collectChildMessageText(recovery.stream.events, recovery.messageId);
    if (!echoPayloadMatches(recoveryText, `after-kill-${runId}`)) {
      return fail(`recovery turn did not echo after-kill-${runId}`);
    }
    const replacement = await waitForDistinctAllocation(
      deadline,
      sandbox,
      session,
      allocation,
      'replacement',
      RECOVERY_BUDGET_MS
    );

    result = {
      name: scenarioName,
      conversation,
      ok: true,
      message:
        `session=${session.cloudAgentSessionId}; killed=${killed.observedRef}; ` +
        `affected=${messageId}/${affected.status}; recovery=${recovery.messageId}/completed; ` +
        `oldRef=${allocation}!=newRef=${replacement}`,
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    result = fail(errorMessage(error));
  } finally {
    for (const stream of streams) {
      try {
        stream.close();
      } catch {
        /* ignore */
      }
    }
    // Always release the parked gate: an early throw before `killOwnedContainer`
    // would otherwise leave the fake's gate parked forever. A missing waiter
    // returns 404 and the catch swallows it, so no flag is needed. The call is
    // bounded so a wedged fake cannot outlive the scenario's own cleanup.
    await releaseGate(
      scenarioConfig.fakeLlmUrl,
      gateTag,
      AbortSignal.timeout(CLEANUP_TIMEOUT_MS)
    ).catch(() => {});
    for (const late of await creations.settleAll(LATE_CREATE_SETTLE_MS)) {
      owned.register(late);
    }
    await owned.cleanup(scenarioName);
  }
  return result;
}

/**
 * `wrapper-freeze-settled-reap`: after a completed turn, freeze only the
 * identity-matched control-wrapper process. Recovery exhausts against the
 * frozen runtime and the provider stops the expected allocation; a follow-up
 * on the same session completes on a distinct replacement. `settledReap=true`
 * names the mechanism; the assertions are the stopped allocation and the
 * distinct replacement.
 */
async function runWrapperFreezeSettledReap(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = FAULT_TIMEOUT_MS } = args;
  const scenarioName = 'wrapper-freeze-settled-reap';
  const sandbox = sessionSandboxObservation(env);
  const faults = env.sandboxFaults;
  if (!faults) throw new Error('sandboxFaults capability is required');
  const owned = createOwnedSessionRegistry(config, cleanupRemoteSession);
  const scenarioConfig = owned.config;
  const deadline = createScenarioDeadline(startedAt, timeoutMs);
  const creations = trackCreations<WorktreeSessionResult>(deadline, owned, scenarioName);
  const runId = randomUUID().slice(0, 8);
  const events: StreamEvent[] = [];
  const streams: StreamConnection[] = [];
  let frozenTarget: SandboxFaultTarget | undefined;
  let result: LifecycleResult;

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message,
    events,
    durationMs: Date.now() - startedAt,
  });

  try {
    assertScenarioPreconditions(scenarioConfig, args.api);
    const session = await prepareSession(
      creations,
      scenarioConfig,
      fakeDirective(`echo:boot-${runId}`)
    );
    owned.register(session);
    const boot = await bootToCompletion(deadline, scenarioConfig, session, 'boot');
    streams.push(boot.stream);
    events.push(...boot.stream.events);
    if (!echoPayloadMatches(boot.text, `boot-${runId}`)) {
      return fail(`boot turn did not echo boot-${runId}`);
    }

    const { allocation, target } = await captureFaultTarget(
      deadline,
      sandbox,
      faults,
      session,
      'boot'
    );
    const sandboxId = await readSessionSandboxId(deadline, scenarioConfig, session);
    const evidenceCursor = await faults.captureEvidenceCursor();
    const frozen = await faults.freezeWrapperProcess(target);
    frozenTarget = target;
    if (!frozen.frozen)
      throw new Error(`freezeWrapperProcess reported no freeze: ${frozen.detail}`);

    await waitForAllocationAbsent(deadline, sandbox, session, 'settled reap', RECOVERY_BUDGET_MS);

    const recovery = await sendTurn(
      deadline,
      scenarioConfig,
      session.cloudAgentSessionId,
      fakeDirective(`echo:after-freeze-${runId}`),
      'replacement turn',
      RECOVERY_BUDGET_MS
    );
    streams.push(recovery.stream);
    events.push(...recovery.stream.events);
    const recoveryText = collectChildMessageText(recovery.stream.events, recovery.messageId);
    if (!echoPayloadMatches(recoveryText, `after-freeze-${runId}`)) {
      return fail(`replacement turn did not echo after-freeze-${runId}`);
    }
    const replacement = await waitForDistinctAllocation(
      deadline,
      sandbox,
      session,
      allocation,
      'replacement',
      RECOVERY_BUDGET_MS
    );
    const reapEvidence = await deadline.within('settled reap evidence', signal =>
      faults.observeReapEvidence({
        reapedAllocationRef: allocation,
        sandboxId,
        fromByte: evidenceCursor,
        waitMs: Math.max(
          1,
          Math.min(RECOVERY_BUDGET_MS, deadline.remaining('settled reap evidence'))
        ),
        inflight: false,
        signal,
      })
    );
    assertReapOutcome({
      evidence: reapEvidence,
      reapedAllocationRef: allocation,
      replacementAllocationRef: replacement,
      settledReapReason: RECOVERY_SETTLED_REAP_REASON,
      inflight: false,
    });

    result = {
      name: scenarioName,
      conversation,
      ok: true,
      message:
        `session=${session.cloudAgentSessionId}; frozenPid=${frozen.pid}; settledReap=true; ` +
        `cause=${reapEvidence.physicalStopCause ?? 'none'}; providerStop=${reapEvidence.providerStopObserved}; ` +
        `heartbeatExpiry=${reapEvidence.heartbeatExpiryDeadline}; ` +
        `reapedRefAbsent=true; replacement=${recovery.messageId}/completed; ` +
        `oldRef=${allocation}!=newRef=${replacement}`,
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    result = fail(errorMessage(error));
  } finally {
    if (frozenTarget) {
      try {
        await faults.unfreezeWrapperProcess(frozenTarget);
      } catch (error) {
        // The reaped container may already be gone; a failed unfreeze must not
        // replace the scenario result.
        console.warn(`wrapper-freeze-settled-reap unfreeze skipped: ${errorMessage(error)}`);
      }
    }
    for (const stream of streams) {
      try {
        stream.close();
      } catch {
        /* ignore */
      }
    }
    for (const late of await creations.settleAll(LATE_CREATE_SETTLE_MS)) {
      owned.register(late);
    }
    await owned.cleanup(scenarioName);
  }
  return result;
}

/**
 * `wrapper-freeze-inflight-reap`: freeze only the identity-matched
 * control-wrapper process while a paced turn is held. The exact message must
 * terminalise `runtime_unhealthy`; recovery exhausts and reaps the expected
 * allocation, and a follow-up on the same session completes on a distinct
 * replacement.
 */
async function runWrapperFreezeInflightReap(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = FAULT_TIMEOUT_MS } = args;
  const scenarioName = 'wrapper-freeze-inflight-reap';
  const sandbox = sessionSandboxObservation(env);
  const faults = env.sandboxFaults;
  if (!faults) throw new Error('sandboxFaults capability is required');
  const owned = createOwnedSessionRegistry(config, cleanupRemoteSession);
  const scenarioConfig = owned.config;
  const deadline = createScenarioDeadline(startedAt, timeoutMs);
  const creations = trackCreations<WorktreeSessionResult>(deadline, owned, scenarioName);
  const runId = randomUUID().slice(0, 8);
  const events: StreamEvent[] = [];
  const streams: StreamConnection[] = [];
  let frozenTarget: SandboxFaultTarget | undefined;
  let result: LifecycleResult;

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message,
    events,
    durationMs: Date.now() - startedAt,
  });

  try {
    assertScenarioPreconditions(scenarioConfig, args.api);
    const session = await prepareSession(
      creations,
      scenarioConfig,
      fakeDirective(`echo:boot-${runId}`)
    );
    owned.register(session);
    const boot = await bootToCompletion(deadline, scenarioConfig, session, 'boot');
    streams.push(boot.stream);
    events.push(...boot.stream.events);
    if (!echoPayloadMatches(boot.text, `boot-${runId}`)) {
      return fail(`boot turn did not echo boot-${runId}`);
    }

    const { allocation, target } = await captureFaultTarget(
      deadline,
      sandbox,
      faults,
      session,
      'boot'
    );
    const sandboxId = await readSessionSandboxId(deadline, scenarioConfig, session);
    const evidenceCursor = await faults.captureEvidenceCursor();

    // Hold the turn with a paced stream before the freeze, so the freeze lands
    // on an accepted, running message.
    const hold = await startPacedHoldTurn({
      deadline,
      config: scenarioConfig,
      cloudAgentSessionId: session.cloudAgentSessionId,
      directive: INFLIGHT_HOLD_DIRECTIVE,
      label: 'inflight hold',
      budgetMs: PACED_PROGRESS_BUDGET_MS,
    });
    const holdStream = hold.stream;
    streams.push(holdStream);
    const held = { messageId: hold.messageId };

    const frozen = await faults.freezeWrapperProcess(target);
    frozenTarget = target;
    if (!frozen.frozen)
      throw new Error(`freezeWrapperProcess reported no freeze: ${frozen.detail}`);

    const failedEvent = await holdStream.waitFor(
      event =>
        event.streamEventType === 'cloud.message.failed' &&
        messageIdFromEvent(event) === held.messageId,
      Math.min(UNHEALTHY_TERMINAL_BUDGET_MS, deadline.remaining('inflight terminal'))
    );
    events.push(...holdStream.events);
    if (!failedEvent) {
      const durable = await deadline.within('inflight durable', signal =>
        getMessageResult(scenarioConfig, session.cloudAgentSessionId, held.messageId, signal)
      );
      throw new Error(
        `held message ${held.messageId} did not terminalise after the freeze (durable=${durable.status})`
      );
    }
    const data = failedEvent.data as { reason?: string; payload?: { reason?: string } } | undefined;
    const reason = data?.reason ?? data?.payload?.reason;
    if (reason !== 'runtime_unhealthy') {
      throw new Error(
        `held message ${held.messageId} terminal reason=${reason ?? 'none'}; expected runtime_unhealthy`
      );
    }

    await waitForAllocationAbsent(deadline, sandbox, session, 'inflight reap', RECOVERY_BUDGET_MS);

    const recovery = await sendTurn(
      deadline,
      scenarioConfig,
      session.cloudAgentSessionId,
      fakeDirective(`echo:after-freeze-${runId}`),
      'replacement turn',
      RECOVERY_BUDGET_MS
    );
    streams.push(recovery.stream);
    events.push(...recovery.stream.events);
    const recoveryText = collectChildMessageText(recovery.stream.events, recovery.messageId);
    if (!echoPayloadMatches(recoveryText, `after-freeze-${runId}`)) {
      return fail(`replacement turn did not echo after-freeze-${runId}`);
    }
    const replacement = await waitForDistinctAllocation(
      deadline,
      sandbox,
      session,
      allocation,
      'replacement',
      RECOVERY_BUDGET_MS
    );
    const reapEvidence = await deadline.within('inflight reap evidence', signal =>
      faults.observeReapEvidence({
        reapedAllocationRef: allocation,
        sandboxId,
        fromByte: evidenceCursor,
        waitMs: Math.max(
          1,
          Math.min(RECOVERY_BUDGET_MS, deadline.remaining('inflight reap evidence'))
        ),
        inflight: true,
        messageId: held.messageId,
        signal,
      })
    );
    assertReapOutcome({
      evidence: reapEvidence,
      reapedAllocationRef: allocation,
      replacementAllocationRef: replacement,
      settledReapReason: RECOVERY_SETTLED_REAP_REASON,
      inflight: true,
    });

    result = {
      name: scenarioName,
      conversation,
      ok: true,
      message:
        `session=${session.cloudAgentSessionId}; frozenPid=${frozen.pid}; ` +
        `held=${held.messageId}; runtimeUnhealthy=true; settledReap=true; ` +
        `cause=${reapEvidence.physicalStopCause ?? 'none'}; providerStop=${reapEvidence.providerStopObserved}; ` +
        `routeStaleActive=${reapEvidence.routeStaleActive}; reapedRefAbsent=true; ` +
        `replacement=${recovery.messageId}/completed; oldRef=${allocation}!=newRef=${replacement}`,
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    result = fail(errorMessage(error));
  } finally {
    if (frozenTarget) {
      try {
        await faults.unfreezeWrapperProcess(frozenTarget);
      } catch (error) {
        console.warn(`wrapper-freeze-inflight-reap unfreeze skipped: ${errorMessage(error)}`);
      }
    }
    for (const stream of streams) {
      try {
        stream.close();
      } catch {
        /* ignore */
      }
    }
    for (const late of await creations.settleAll(LATE_CREATE_SETTLE_MS)) {
      owned.register(late);
    }
    await owned.cleanup(scenarioName);
  }
  return result;
}

export const FAULT_SHARED_SCENARIOS: Record<string, SharedScenario> = {
  'external-kill': {
    name: 'external-kill',
    requires: ['sessionSandbox', 'sandboxFaults'],
    defaultApi: 'unified',
    defaultConversation: '_',
    defaultTimeoutMs: FAULT_TIMEOUT_MS,
    requiresWorktreeCreation: true,
    run: runExternalKill,
  },
  'kill-mid-flight': {
    name: 'kill-mid-flight',
    requires: ['sessionSandbox', 'sandboxFaults', 'gates'],
    defaultApi: 'unified',
    defaultConversation: '_',
    defaultTimeoutMs: FAULT_TIMEOUT_MS,
    requiresWorktreeCreation: true,
    run: runKillMidFlight,
  },
  'wrapper-freeze-settled-reap': {
    name: 'wrapper-freeze-settled-reap',
    requires: ['sessionSandbox', 'sandboxFaults'],
    defaultApi: 'unified',
    defaultConversation: '_',
    defaultTimeoutMs: FAULT_TIMEOUT_MS,
    requiresWorktreeCreation: true,
    run: runWrapperFreezeSettledReap,
  },
  'wrapper-freeze-inflight-reap': {
    name: 'wrapper-freeze-inflight-reap',
    requires: ['sessionSandbox', 'sandboxFaults'],
    defaultApi: 'unified',
    defaultConversation: '_',
    defaultTimeoutMs: FAULT_TIMEOUT_MS,
    requiresWorktreeCreation: true,
    run: runWrapperFreezeInflightReap,
  },
};
