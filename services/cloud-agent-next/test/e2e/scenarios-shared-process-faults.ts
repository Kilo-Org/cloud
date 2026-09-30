/**
 * New-plane process faults — plan B11 (spec §11 scenarios 12, 13, 19).
 *
 * The container-level fault scenarios (`external-kill`, `wrapper-freeze-*`)
 * also run on the new plane. These three exercise process death and hangs:
 *
 * - `kilo-kill-recovery`: `SIGKILL` the `kilo serve` process after the turn made
 *   tool progress. The accepted message must fail with `agent_restarted`
 *   (a made-progress turn is failed, not resubmitted), and a follow-up must
 *   complete in the same container.
 * - `wrapper-kill-recovery`: `SIGKILL` the new-plane control wrapper. The
 *   supervisor restarts it, the accepted message must fail with
 *   `agent_restarted`, the old Kilo processes must be gone, and a follow-up
 *   must complete in the same container.
 * - `kilo-hang-recovery`: `SIGSTOP` Kilo while the fake LLM holds the first
 *   token. The wrapper must restart Kilo with a new pid and the replayed turn
 *   must complete with the user message present exactly once in Kilo history.
 *
 * Each declares `controlPlaneV2`, `controlPlaneRuntime`, and `sandboxFaults`, so
 * it is `unsupported` until `E2E_CONTROL_PLANE_V2=1` and requires a local Docker
 * container that actually runs the new-plane wrapper: `controlPlaneRuntime`
 * proves the wrapper is present, so an opted-in run against a still-legacy plane
 * fails loudly instead of false-passing.
 */

import { randomUUID } from 'node:crypto';
import {
  failureReasonFromEvent,
  fakeDirective,
  fetchFakeScenarioStatus,
  isMessageCompleted,
  openConnectedStream,
  releaseGate,
  waitForGateEngaged,
  type StreamConnection,
  type StreamEvent,
  type WorktreeSessionResult,
} from './client.js';
import { cleanupRemoteSession, type SharedScenario } from './scenarios-shared.js';
import {
  awaitDurableTerminal,
  bootToCompletion,
  createOwnedSessionRegistry,
  createScenarioDeadline,
  sendTurn,
  startPacedHoldTurn,
  trackCreations,
  waitForPresentAllocation,
  type ScenarioDeadline,
} from './scenarios-shared-runtime.js';
import { captureControlPlaneFaultTarget, prepareSession } from './scenarios-shared-faults.js';
import { assertScenarioPreconditions } from './public-surface-support.js';
import type { LifecycleArgs, LifecycleResult } from './lifecycle.js';
import type { SandboxFaultTarget, ScenarioEnvironment } from './scenario-capabilities.js';

const PROCESS_FAULT_TIMEOUT_MS = 20 * 60_000;
/** The paced tool-progress hold is up to 60s; the fault must land inside it. */
const PACED_PROGRESS_BUDGET_MS = 90_000;
const TURN_BUDGET_MS = 120_000;
const RECOVERY_BUDGET_MS = 8 * 60_000;
/** The wrapper's SSE-silence restart must complete inside this window. */
const HANG_RECOVERY_BUDGET_MS = 5 * 60_000;
const HANG_PARK_BUDGET_MS = 60_000;
const GATE_ENGAGE_BUDGET_MS = 60_000;
const LATE_SETTLE_MS = 30_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireFaults(
  env: ScenarioEnvironment
): NonNullable<ScenarioEnvironment['sandboxFaults']> {
  if (!env.sandboxFaults) throw new Error('sandboxFaults capability is required');
  return env.sandboxFaults;
}

function requireControlPlaneRuntime(
  env: ScenarioEnvironment
): NonNullable<ScenarioEnvironment['controlPlaneRuntime']> {
  if (!env.controlPlaneRuntime) throw new Error('controlPlaneRuntime capability is required');
  return env.controlPlaneRuntime;
}

function requireSandbox(
  env: ScenarioEnvironment
): NonNullable<ScenarioEnvironment['sessionSandbox']> {
  if (!env.sessionSandbox) throw new Error('sessionSandbox capability is required');
  return env.sessionSandbox;
}

async function assertUnchangedAllocation(
  deadline: ScenarioDeadline,
  sandbox: NonNullable<ScenarioEnvironment['sessionSandbox']>,
  session: WorktreeSessionResult,
  expectedAllocation: string,
  label: string
): Promise<void> {
  const observed = await waitForPresentAllocation(
    deadline,
    sandbox,
    session,
    label,
    RECOVERY_BUDGET_MS
  );
  if (observed === null) throw new Error(`${label}: no allocation after recovery`);
  if (observed !== expectedAllocation) {
    throw new Error(`${label}: allocation changed ${expectedAllocation} -> ${observed}`);
  }
}

/**
 * Kill the Kilo server or the control wrapper mid-turn, after the turn made
 * tool progress. A made-progress turn is failed with `agent_restarted` (not
 * resubmitted), so the harness asserts the exact reason and a follow-up turn.
 */
async function runProcessKill(
  args: LifecycleArgs,
  env: ScenarioEnvironment,
  kind: 'kilo-kill-recovery' | 'wrapper-kill-recovery'
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = PROCESS_FAULT_TIMEOUT_MS } = args;
  const sandbox = requireSandbox(env);
  const faults = requireFaults(env);
  const controlPlaneRuntime = requireControlPlaneRuntime(env);
  const owned = createOwnedSessionRegistry(config, cleanupRemoteSession);
  const scenarioConfig = owned.config;
  const runId = randomUUID().slice(0, 8);
  const gateTag = `kill-${kind}-${runId}`;
  const deadline = createScenarioDeadline(startedAt, timeoutMs);
  const creations = trackCreations<WorktreeSessionResult>(deadline, owned, kind);
  const events: StreamEvent[] = [];
  const streams: StreamConnection[] = [];
  let result: LifecycleResult;

  const fail = (message: string): LifecycleResult => ({
    name: kind,
    conversation,
    ok: false,
    message,
    events: [...events],
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
    const boot = await bootToCompletion(deadline, scenarioConfig, session, 'boot', text =>
      text.includes(`boot-${runId}`)
    );
    streams.push(boot.stream);
    events.push(...boot.stream.events);

    const { allocation, target } = await captureControlPlaneFaultTarget(
      deadline,
      sandbox,
      controlPlaneRuntime,
      session,
      'boot'
    );
    const kiloIdentity =
      kind === 'wrapper-kill-recovery' ? await faults.captureKiloServerIdentity(target) : undefined;

    // Tool progress before the kill: a no-progress busy turn is resubmitted and
    // completes, which would make this a false failure. `write-then-gate` runs a
    // real write tool call, then parks until released.
    const held = await startPacedHoldTurn({
      deadline,
      config: scenarioConfig,
      cloudAgentSessionId: session.cloudAgentSessionId,
      directive: `write-then-gate:${gateTag}:${gateTag}.txt:contents-${runId}`,
      label: 'held turn',
      budgetMs: PACED_PROGRESS_BUDGET_MS,
    });
    streams.push(held.stream);
    events.push(...held.stream.events);
    // The kill is only meaningful once the write tool round trip completed:
    // a no-progress turn is resubmitted by a correct plane and would fail this
    // scenario falsely. `waitForGateEngaged` returns false on timeout and does
    // not throw, so its boolean must be checked.
    if (!(await waitForGateEngaged(scenarioConfig, gateTag, GATE_ENGAGE_BUDGET_MS))) {
      throw new Error('write tool round trip did not complete before the kill');
    }

    const killed =
      kind === 'kilo-kill-recovery'
        ? await faults.killKiloServerProcess(target)
        : await faults.killWrapperProcess(target);
    if (!killed.killed) throw new Error(`${kind} reported no kill: ${killed.detail}`);

    const terminal = await held.stream.waitForTerminal(
      Math.max(1, Math.min(TURN_BUDGET_MS, deadline.remaining('held terminal'))),
      held.messageId
    );
    if (terminal === null)
      throw new Error(`held turn ${held.messageId} produced no terminal event`);
    const reason = failureReasonFromEvent(terminal);
    if (reason !== 'agent_restarted') {
      throw new Error(
        `held turn ${held.messageId} reason=${reason ?? 'none'}, expected agent_restarted`
      );
    }
    const heldStatus = await awaitDurableTerminal(
      scenarioConfig,
      session.cloudAgentSessionId,
      held.messageId,
      deadline.remaining('held durable')
    );
    if (heldStatus !== 'failed') {
      throw new Error(`held turn durable status=${heldStatus}, expected failed`);
    }

    if (kiloIdentity) {
      const stillThere = await faults.kiloServerProcessExists(target, kiloIdentity.pid);
      if (stillThere) {
        throw new Error(
          `wrapper kill left the old Kilo pid ${kiloIdentity.pid} running in ${allocation}`
        );
      }
    }

    const recovery = await sendTurn(
      deadline,
      scenarioConfig,
      session.cloudAgentSessionId,
      fakeDirective(`echo:after-${kind}-${runId}`),
      'recovery turn',
      RECOVERY_BUDGET_MS
    );
    streams.push(recovery.stream);
    events.push(...recovery.stream.events);
    await assertUnchangedAllocation(deadline, sandbox, session, allocation, 'recovery allocation');

    result = {
      name: kind,
      conversation,
      ok: true,
      message:
        `session=${session.cloudAgentSessionId}; killedPid=${killed.pid}; ` +
        `held=${held.messageId}/${reason}; recovery=${recovery.messageId}/completed; ` +
        `allocation=${allocation}`,
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    result = fail(errorMessage(error));
  } finally {
    await releaseGate(scenarioConfig.fakeLlmUrl, gateTag).catch(() => undefined);
    for (const stream of streams) {
      try {
        stream.close();
      } catch {
        /* ignore */
      }
    }
    for (const late of await creations.settleAll(LATE_SETTLE_MS)) {
      owned.register(late);
    }
    await owned.cleanup(kind);
  }
  return result;
}

async function waitForFakeTagRequests(
  fakeLlmUrl: string,
  tag: string,
  min: number,
  deadline: ScenarioDeadline
): Promise<void> {
  const end = Date.now() + Math.min(HANG_PARK_BUDGET_MS, deadline.remaining('hang park'));
  while (Date.now() < end) {
    const status = await fetchFakeScenarioStatus(fakeLlmUrl, tag);
    if (status.requests >= min) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`fake scenario ${tag} never reached ${min} request(s)`);
}

/**
 * Kilo hang: the fake emits one token then parks; Kilo is frozen with SIGSTOP.
 * The wrapper's silence detection must restart Kilo (a new pid) and replay the
 * turn, which the fake completes on the second request for the tag. The user
 * message must appear once in Kilo history (the B8 duplicate-parts behaviour
 * would append a second text part).
 */
async function runKiloHang(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = PROCESS_FAULT_TIMEOUT_MS } = args;
  const sandbox = requireSandbox(env);
  const faults = requireFaults(env);
  const controlPlaneRuntime = requireControlPlaneRuntime(env);
  const owned = createOwnedSessionRegistry(config, cleanupRemoteSession);
  const scenarioConfig = owned.config;
  const runId = randomUUID().slice(0, 8);
  const tag = `hang-${runId}`;
  const deadline = createScenarioDeadline(startedAt, timeoutMs);
  const creations = trackCreations<WorktreeSessionResult>(deadline, owned, 'kilo-hang-recovery');
  const events: StreamEvent[] = [];
  const streams: StreamConnection[] = [];
  let frozenTarget: SandboxFaultTarget | undefined;
  let result: LifecycleResult;

  const fail = (message: string): LifecycleResult => ({
    name: 'kilo-hang-recovery',
    conversation,
    ok: false,
    message,
    events: [...events],
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
    const boot = await bootToCompletion(deadline, scenarioConfig, session, 'boot', text =>
      text.includes(`boot-${runId}`)
    );
    streams.push(boot.stream);
    events.push(...boot.stream.events);

    const { allocation, target } = await captureControlPlaneFaultTarget(
      deadline,
      sandbox,
      controlPlaneRuntime,
      session,
      'boot'
    );
    const kiloBefore = await faults.captureKiloServerIdentity(target);

    const stream = await deadline.within('hang stream', signal =>
      openConnectedStream(scenarioConfig, session.cloudAgentSessionId, false, undefined, signal)
    );
    streams.push(stream);
    const sent = await startPacedHoldTurn({
      deadline,
      config: scenarioConfig,
      cloudAgentSessionId: session.cloudAgentSessionId,
      directive: `first-token:${tag}:${tag}-complete`,
      label: 'hang turn',
      budgetMs: PACED_PROGRESS_BUDGET_MS,
      stream,
    });
    await waitForFakeTagRequests(scenarioConfig.fakeLlmUrl, tag, 1, deadline);

    const froze = await faults.freezeKiloServerProcess(target);
    if (!froze.frozen)
      throw new Error(`freezeKiloServerProcess reported no freeze: ${froze.detail}`);
    frozenTarget = target;

    const terminal = await stream.waitForTerminal(
      Math.max(1, Math.min(HANG_RECOVERY_BUDGET_MS, deadline.remaining('hang terminal'))),
      sent.messageId
    );
    if (!isMessageCompleted(terminal, sent.messageId)) {
      throw new Error(`hang turn ${sent.messageId} did not complete after Kilo restart`);
    }
    const status = await awaitDurableTerminal(
      scenarioConfig,
      session.cloudAgentSessionId,
      sent.messageId,
      Math.max(1, Math.min(HANG_RECOVERY_BUDGET_MS, deadline.remaining('hang durable')))
    );
    if (status !== 'completed') throw new Error(`hang turn durable status=${status}`);

    const kiloAfter = await faults.captureKiloServerIdentity(target);
    if (kiloAfter.pid === kiloBefore.pid) {
      throw new Error(
        `Kilo pid ${kiloBefore.pid} did not change after the hang restart (expected a new process)`
      );
    }
    const parts = await controlPlaneRuntime.userMessageParts(target, sent.messageId);
    if (!parts.found) {
      throw new Error(`user message ${sent.messageId} was not found in Kilo history`);
    }
    if (parts.textParts !== 1) {
      throw new Error(
        `user message ${sent.messageId} has ${parts.textParts} text parts, expected exactly 1`
      );
    }
    await assertUnchangedAllocation(deadline, sandbox, session, allocation, 'hang allocation');

    result = {
      name: 'kilo-hang-recovery',
      conversation,
      ok: true,
      message:
        `session=${session.cloudAgentSessionId}; frozePid=${froze.pid}; ` +
        `restartedPid=${kiloAfter.pid}; hangTurn=${sent.messageId}/completed; ` +
        `userTextParts=${parts.textParts}; allocation=${allocation}`,
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    result = fail(errorMessage(error));
  } finally {
    // The restarted Kilo has a new pid, so the retained handle is normally
    // stale; CONT is best-effort and its failure is recorded, never raised.
    if (frozenTarget) {
      await faults.unfreezeKiloServerProcess(frozenTarget).catch(() => undefined);
    }
    for (const stream of streams) {
      try {
        stream.close();
      } catch {
        /* ignore */
      }
    }
    for (const late of await creations.settleAll(LATE_SETTLE_MS)) {
      owned.register(late);
    }
    await owned.cleanup('kilo-hang-recovery');
  }
  return result;
}

export const PROCESS_FAULT_SHARED_SCENARIOS: Record<string, SharedScenario> = {
  'kilo-kill-recovery': {
    name: 'kilo-kill-recovery',
    requires: ['sessionSandbox', 'sandboxFaults', 'controlPlaneRuntime', 'controlPlaneV2'],
    defaultApi: 'unified',
    defaultConversation: '_',
    defaultTimeoutMs: PROCESS_FAULT_TIMEOUT_MS,
    run: (args, env) => runProcessKill(args, env, 'kilo-kill-recovery'),
  },
  'wrapper-kill-recovery': {
    name: 'wrapper-kill-recovery',
    requires: ['sessionSandbox', 'sandboxFaults', 'controlPlaneRuntime', 'controlPlaneV2'],
    defaultApi: 'unified',
    defaultConversation: '_',
    defaultTimeoutMs: PROCESS_FAULT_TIMEOUT_MS,
    run: (args, env) => runProcessKill(args, env, 'wrapper-kill-recovery'),
  },
  'kilo-hang-recovery': {
    name: 'kilo-hang-recovery',
    requires: ['sessionSandbox', 'sandboxFaults', 'controlPlaneRuntime', 'controlPlaneV2'],
    defaultApi: 'unified',
    defaultConversation: '_',
    defaultTimeoutMs: PROCESS_FAULT_TIMEOUT_MS,
    run: runKiloHang,
  },
};
