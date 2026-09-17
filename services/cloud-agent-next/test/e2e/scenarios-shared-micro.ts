/**
 * Cold / hot / follow-up admissions shared by the local Docker and HTTP
 * profiles: `cold`, `hot`, `followup`.
 *
 * They run against the Worker over tRPC + WebSocket only. Physical container
 * identity comes from the injected `sessionSandbox` capability, so the same
 * definition works under local Docker and over the e2e HTTP surface; nothing
 * here reads Docker or session-ownership rows directly.
 *
 * The container observation is deliberately coarser than the original
 * Docker-only `waitForOwnedSandbox`/`listSandboxContainers` checks: local
 * Docker passes an empty exclusion set, and the HTTP profile reads the
 * persisted provider reference rather than a live runtime observation. When the
 * Docker `sandbox` capability is absent the inventory half of the warm-reuse
 * check is unchecked, not silently proved; `hot`/`followup` report it in the
 * message. See `scenario-capabilities.ts` for the exact contract.
 *
 * These conversations are admitted for `echo:`/`slow:` prompts only. The `hang`
 * variant is deliberately excluded — it never produces a terminal, so a
 * completed-terminal assertion cannot pass it. This is a deliberate reduction
 * of the Docker profile's manual `hot hang` run, consistent with the plan.
 */

import {
  collectUntilTerminal,
  fakeDirective,
  hasPreparationForMessage,
  interruptSession,
  isMessageCompleted,
  openConnectedStream,
  sendMessage,
  startSession,
  type StartSessionResult,
  type StreamConnection,
  type StreamEvent,
} from './client.js';
import type { LifecycleArgs, LifecycleResult } from './lifecycle.js';
import type { ScenarioEnvironment, SessionSandboxObservation } from './scenario-capabilities.js';
import type { SharedScenario } from './scenarios-shared.js';

/** Cold-boot budget over a real first container start. */
const COLD_TIMEOUT_MS = 120_000;
/** Warm-turn budget once the container exists. */
const HOT_TIMEOUT_MS = 60_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sessionSandboxObservation(env: ScenarioEnvironment): SessionSandboxObservation {
  if (!env.sessionSandbox) throw new Error('sessionSandbox capability is required');
  return env.sessionSandbox;
}

/**
 * Wait for the physical container behind `session`. `sessionSandbox` is
 * guaranteed by the scenario's declared capability when it runs through the
 * shared gate; the guard keeps a direct call honest.
 */
async function requireContainer(
  sandbox: SessionSandboxObservation,
  session: { cloudAgentSessionId: string; kiloSessionId: string },
  timeoutMs: number
): Promise<string | null> {
  return sandbox.waitForContainer({
    cloudAgentSessionId: session.cloudAgentSessionId,
    kiloSessionId: session.kiloSessionId,
    timeoutMs,
  });
}

/**
 * `cold <directive>` (default `echo:hi`): one cold turn on a fresh session.
 * Asserts the turn reaches a terminal for its own message and that the turn
 * completed; the physical container identity observed through `sessionSandbox`
 * is reported as evidence.
 */
async function runCold(args: LifecycleArgs, env: ScenarioEnvironment): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = COLD_TIMEOUT_MS, api = 'unified' } = args;
  const sandbox = sessionSandboxObservation(env);
  const events: StreamEvent[] = [];
  let session: StartSessionResult | undefined;
  let stream: StreamConnection | undefined;

  const fail = (message: string): LifecycleResult => ({
    name: 'cold',
    conversation,
    ok: false,
    message,
    events: [...events],
    durationMs: Date.now() - startedAt,
  });

  try {
    session = await startSession(config, { prompt: fakeDirective(conversation) }, api);
    stream = await openConnectedStream(config, session.cloudAgentSessionId);

    const container = await requireContainer(sandbox, session, timeoutMs);
    if (container === null) {
      events.push(...stream.events);
      return fail(`could not identify an exclusively owned sandbox within ${timeoutMs}ms`);
    }

    const { terminal, events: collected } = await collectUntilTerminal(
      stream,
      session.messageId,
      timeoutMs
    );
    events.push(...collected);
    stream.close();
    stream = undefined;

    if (!terminal) {
      return fail(`no terminal event within ${timeoutMs}ms`);
    }
    return {
      name: 'cold',
      conversation,
      ok: isMessageCompleted(terminal, session.messageId),
      message:
        `session=${session.cloudAgentSessionId}, message=${session.messageId}, ` +
        `terminal=${terminal.streamEventType}, container=${container}`,
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (stream) events.push(...stream.events);
    return fail(`threw: ${errorMessage(error)}`);
  } finally {
    try {
      stream?.close();
    } catch {
      // A close failure must not replace the scenario result.
    }
    if (session) await interruptSession(config, session.cloudAgentSessionId).catch(() => {});
  }
}

/**
 * `hot <directive>`: run a cold `echo:warmup` first, then send the real prompt
 * on the SAME session. No preparation event may carry the hot message, and the
 * physical container observed through `sessionSandbox` must be unchanged. When
 * the Docker `sandbox` capability is present, the follow-up must also leave the
 * warm container present and create no extra container; without it that half is
 * reported as unchecked.
 */
async function runHot(args: LifecycleArgs, env: ScenarioEnvironment): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = HOT_TIMEOUT_MS, api = 'unified' } = args;
  const sessionSandbox = sessionSandboxObservation(env);
  const inventory = env.sandbox;
  const scenarioName = 'hot';
  const events: StreamEvent[] = [];
  let session: StartSessionResult | undefined;
  let stream: StreamConnection | undefined;

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message,
    events: [...events],
    durationMs: Date.now() - startedAt,
  });

  try {
    // Warm-up: cold echo.
    session = await startSession(config, { prompt: fakeDirective('echo:warmup') }, api);
    const warmupStream = await openConnectedStream(config, session.cloudAgentSessionId);
    const warmupContainer = await requireContainer(sessionSandbox, session, timeoutMs);
    if (warmupContainer === null) {
      warmupStream.close();
      return fail('warmup: sandbox did not appear');
    }
    const warmupTerminal = await warmupStream.waitForTerminal(timeoutMs, session.messageId);
    events.push(...warmupStream.events);
    warmupStream.close();
    if (!isMessageCompleted(warmupTerminal, session.messageId)) {
      return fail(`warmup ${session.messageId}: expected successful message completion`);
    }

    // Send the follow-up prompt. It must land on the same warm container and
    // create no extra one.
    const containersBeforeFollowup = inventory ? await inventory.snapshotContainerIds() : undefined;
    stream = await openConnectedStream(config, session.cloudAgentSessionId, false);
    const sent = await sendMessage(
      config,
      { cloudAgentSessionId: session.cloudAgentSessionId, prompt: fakeDirective(conversation) },
      api
    );

    const firstKilocodeStart = Date.now();
    const firstKilocode = await stream.waitFor(e => e.streamEventType === 'kilocode', 10_000);
    const firstKilocodeLatency = Date.now() - firstKilocodeStart;

    const { terminal, events: collected } = await collectUntilTerminal(
      stream,
      sent.messageId,
      timeoutMs
    );
    events.push(...collected);
    stream.close();
    stream = undefined;

    const noPrepare = !hasPreparationForMessage(events, sent.messageId);
    const after = await sessionSandbox.currentContainer({
      cloudAgentSessionId: session.cloudAgentSessionId,
      kiloSessionId: session.kiloSessionId,
    });
    const sameContainer = after === warmupContainer;
    const containersAfter = inventory ? await inventory.snapshotContainerIds() : undefined;
    const sameContainers =
      containersBeforeFollowup === undefined ||
      containersAfter === undefined ||
      (containersAfter.has(warmupContainer) &&
        [...containersAfter].every(id => containersBeforeFollowup.has(id)));
    const inventoryMarker = inventory
      ? `sameContainers=${sameContainers}; before=${[...(containersBeforeFollowup ?? [])].join(',')}; after=${[...(containersAfter ?? [])].join(',')}`
      : 'containerInventory=unchecked(no-sandbox-capability)';

    const terminalName = terminal?.streamEventType ?? 'none';
    const turnOk = isMessageCompleted(terminal, sent.messageId);
    const ok = turnOk && noPrepare && sameContainer && sameContainers;
    return {
      name: scenarioName,
      conversation,
      ok,
      message:
        `terminal=${terminalName}, firstKilocode=${firstKilocode ? `${firstKilocodeLatency}ms` : 'none'}, ` +
        `noPrepare=${noPrepare}, sameContainer=${sameContainer}, ${inventoryMarker}`,
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (stream) events.push(...stream.events);
    return fail(`threw: ${errorMessage(error)}`);
  } finally {
    try {
      stream?.close();
    } catch {
      // A close failure must not replace the scenario result.
    }
    if (session) await interruptSession(config, session.cloudAgentSessionId).catch(() => {});
  }
}

/**
 * `followup`: the same run as `hot`. At the public API level `send` always
 * keeps the same Kilo session; the name is kept distinct so a future
 * resume-path split can separate them.
 */
async function runFollowup(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const result = await runHot(args, env);
  return { ...result, name: 'followup' };
}

export const MICRO_SHARED_SCENARIOS: Record<string, SharedScenario> = {
  cold: {
    name: 'cold',
    requires: ['sessionSandbox'],
    defaultConversation: 'echo:hi',
    defaultTimeoutMs: COLD_TIMEOUT_MS,
    run: runCold,
  },
  hot: {
    name: 'hot',
    requires: ['sessionSandbox'],
    defaultConversation: 'echo:hi',
    defaultTimeoutMs: HOT_TIMEOUT_MS,
    run: runHot,
  },
  followup: {
    name: 'followup',
    requires: ['sessionSandbox'],
    defaultConversation: 'echo:continue',
    defaultTimeoutMs: HOT_TIMEOUT_MS,
    run: runFollowup,
  },
};
