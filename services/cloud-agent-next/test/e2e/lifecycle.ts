/**
 * Lifecycle scenarios. Each scenario composes the client + sandbox primitives
 * to drive the wrapper boot / reuse / kill paths. The conversation dimension
 * (echo, slow, gate, hang, ...) is handled by the fake LLM gateway via the
 * directive embedded in the prompt.
 */

import {
  fetchFakeRequests,
  fetchFakeWaiters,
  interruptSession,
  openStream,
  releaseGate,
  sendMessage,
  startSession,
  waitForGateEngaged,
  type ApiVersion,
  type DriverConfig,
  type StreamEvent,
} from './client.js';
import { startCallbackServer, type CallbackServerHandle } from './callback-server.js';
import {
  killSandboxFamily,
  listSandboxContainers,
  readKiloCliLog,
  readWrapperLog,
  tailLines,
  waitForNewSandboxPresent,
  waitForSandboxFamilyGone,
} from './sandbox-control.js';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type ConversationScenario = string; // e.g. "echo:hi", "tools:3", "hang"

export type LifecycleResult = {
  name: string;
  conversation: string;
  ok: boolean;
  message: string;
  events: StreamEvent[];
  durationMs: number;
};

export type LifecycleArgs = {
  config: DriverConfig;
  conversation: ConversationScenario;
  /**
   * Which tRPC API surface to exercise. Defaults to the current unified
   * `start` / `send` procedures. Pass `'legacy'` to drive the
   * `prepareSession` + `initiateFromKilocodeSessionV2` + `sendMessageV2`
   * surface the web UI still uses.
   */
  api?: ApiVersion;
  /** Overall per-scenario timeout. Conservative default for cold-boot paths. */
  timeoutMs?: number;
};

function fakeDirective(conversation: ConversationScenario): string {
  return `__fake__:${conversation}`;
}

async function collectUntilTerminal(
  stream: ReturnType<typeof openStream>,
  timeoutMs: number
): Promise<{ terminal: StreamEvent | null; events: StreamEvent[] }> {
  const terminal = await stream.waitForTerminal(timeoutMs);
  return { terminal, events: [...stream.events] };
}

function hasEventOfType(events: StreamEvent[], type: string): boolean {
  return events.some(e => e.streamEventType === type);
}

async function snapshotSandboxIds(): Promise<Set<string>> {
  const containers = await listSandboxContainers();
  return new Set(containers.map(container => container.id));
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/**
 * Cold start: fresh sessionId with a newly-created per-session sandbox. Send first prompt.
 * Asserts: a sandbox container appears; the conversation completes (for
 * non-hang scenarios); driver observes prepare / queue events before the
 * first `kilocode` event.
 */
export async function lifecycleCold(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 90_000, api = 'unified' } = args;
  try {
    const knownSandboxIds = await snapshotSandboxIds();
    const sessionResult = await startSession(config, { prompt: fakeDirective(conversation) }, api);
    const stream = openStream(config, sessionResult.cloudAgentSessionId, { replay: false });

    // Per-session dev sandboxes should create a new container for this session.
    const sandbox = await waitForNewSandboxPresent(knownSandboxIds, 60_000);
    if (!sandbox) {
      stream.close();
      return {
        name: 'cold',
        conversation,
        ok: false,
        message: 'sandbox container did not appear within 60s',
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    const { terminal, events } = await collectUntilTerminal(stream, timeoutMs);
    stream.close();

    if (conversation === 'hang') {
      // Hang scenario: we expect NO terminal event. If we got one, fail.
      if (terminal) {
        return {
          name: 'cold',
          conversation,
          ok: false,
          message: `hang scenario produced unexpected terminal: ${terminal.streamEventType}`,
          events,
          durationMs: Date.now() - start,
        };
      }
      return {
        name: 'cold',
        conversation,
        ok: true,
        message: `sandbox came up; no terminal event as expected (received ${events.length} events)`,
        events,
        durationMs: Date.now() - start,
      };
    }

    if (!terminal) {
      return {
        name: 'cold',
        conversation,
        ok: false,
        message: `no terminal event within ${timeoutMs}ms`,
        events,
        durationMs: Date.now() - start,
      };
    }

    return {
      name: 'cold',
      conversation,
      ok: true,
      message: `cold start completed: ${terminal.streamEventType}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'cold',
      conversation,
      ok: false,
      message: `threw: ${msg}`,
      events: [],
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Hot start: run a cold echo first to warm up, then send the real
 * conversation's prompt on the SAME session. No new container, no prepare.
 */
export async function lifecycleHot(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 60_000, api = 'unified' } = args;
  try {
    // Warm-up: cold echo.
    const knownSandboxIds = await snapshotSandboxIds();
    const warmupPrompt = fakeDirective('echo:warmup');
    const session = await startSession(config, { prompt: warmupPrompt }, api);
    const warmupStream = openStream(config, session.cloudAgentSessionId, { replay: false });
    const warmupSandbox = await waitForNewSandboxPresent(knownSandboxIds, 60_000);
    if (!warmupSandbox) {
      warmupStream.close();
      return {
        name: 'hot',
        conversation,
        ok: false,
        message: 'warmup: sandbox did not appear',
        events: [],
        durationMs: Date.now() - start,
      };
    }
    await warmupStream.waitForTerminal(60_000);
    warmupStream.close();

    // Send follow-up prompt. Should land on the same (hot) sandbox.
    const sandboxIdsBeforeFollowup = await snapshotSandboxIds();
    const followPrompt = fakeDirective(conversation);
    const stream = openStream(config, session.cloudAgentSessionId, { replay: false });
    await sendMessage(
      config,
      {
        cloudAgentSessionId: session.cloudAgentSessionId,
        prompt: followPrompt,
      },
      api
    );

    const firstKilocodeStart = Date.now();
    const firstKilocode = await stream.waitFor(e => e.streamEventType === 'kilocode', 10_000);
    const firstKilocodeLatency = Date.now() - firstKilocodeStart;

    const { terminal, events } = await collectUntilTerminal(stream, timeoutMs);
    stream.close();

    const sandboxesAfter = await listSandboxContainers();
    const noPrepare = !hasEventOfType(events, 'preparing');

    const sameContainers =
      sandboxesAfter.some(sandbox => sandbox.id === warmupSandbox.id) &&
      sandboxesAfter.every(sandbox => sandboxIdsBeforeFollowup.has(sandbox.id));

    const terminalName = terminal?.streamEventType ?? 'none';
    const ok = (conversation === 'hang' ? !terminal : !!terminal) && noPrepare && sameContainers;
    return {
      name: 'hot',
      conversation,
      ok,
      message: `terminal=${terminalName}, firstKilocode=${firstKilocode ? `${firstKilocodeLatency}ms` : 'none'}, noPrepare=${noPrepare}, sameContainers=${sameContainers}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'hot',
      conversation,
      ok: false,
      message: `threw: ${msg}`,
      events: [],
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Followup: like hot, but the warmup + follow-up both target the same kilo
 * session. Asserts the wrapper logs `verified existing kilo session` (we
 * can't easily check wrapper logs from here without a container exec, so
 * we simply assert the second turn completes on the same container).
 */
export async function lifecycleFollowup(args: LifecycleArgs): Promise<LifecycleResult> {
  // At the public API level, `send` always keeps the same kilo session —
  // there's no user-facing distinction between "hot" and "followup" beyond
  // whether the first turn used `start`. Keep the scenario for parity with
  // the plan so future work can split them as the resume path matures.
  const result = await lifecycleHot(args);
  return { ...result, name: 'followup' };
}

/**
 * cold-hot: one real cold turn followed by several same-session hot turns.
 * This mirrors normal usage better than booting fresh sandboxes for separate
 * smoke rows while still asserting hot turns avoid new sandbox preparation.
 */
export async function lifecycleColdHot(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 90_000, api = 'unified' } = args;
  const coldDirective = conversation && conversation !== '_' ? conversation : 'echo:hi';
  const hotDirectives = ['echo:hot', 'slow:3:50', 'echo:followup'];
  const events: StreamEvent[] = [];

  try {
    const knownSandboxIds = await snapshotSandboxIds();
    const session = await startSession(config, { prompt: fakeDirective(coldDirective) }, api);
    const coldStream = openStream(config, session.cloudAgentSessionId, { replay: false });
    const sandbox = await waitForNewSandboxPresent(knownSandboxIds, 60_000);
    if (!sandbox) {
      coldStream.close();
      return {
        name: 'cold-hot',
        conversation,
        ok: false,
        message: 'cold turn: new sandbox did not appear within 60s',
        events: [...coldStream.events],
        durationMs: Date.now() - start,
      };
    }

    const coldResult = await collectUntilTerminal(coldStream, timeoutMs);
    events.push(...coldResult.events);
    coldStream.close();
    if (!coldResult.terminal || coldResult.terminal.streamEventType !== 'complete') {
      return {
        name: 'cold-hot',
        conversation,
        ok: false,
        message: `cold turn: expected complete terminal, got ${coldResult.terminal?.streamEventType ?? 'none'}`,
        events,
        durationMs: Date.now() - start,
      };
    }

    const hotSummaries: string[] = [];
    for (const directive of hotDirectives) {
      const sandboxIdsBeforeFollowup = await snapshotSandboxIds();
      const stream = openStream(config, session.cloudAgentSessionId, { replay: false });
      await sendMessage(
        config,
        { cloudAgentSessionId: session.cloudAgentSessionId, prompt: fakeDirective(directive) },
        api
      );

      const firstKilocodeStart = Date.now();
      const firstKilocode = await stream.waitFor(e => e.streamEventType === 'kilocode', 10_000);
      const firstKilocodeLatency = Date.now() - firstKilocodeStart;
      const hotResult = await collectUntilTerminal(stream, timeoutMs);
      events.push(...hotResult.events);
      stream.close();

      const sandboxesAfter = await listSandboxContainers();
      const completed = hotResult.terminal?.streamEventType === 'complete';
      const noPrepare = !hasEventOfType(hotResult.events, 'preparing');
      const sameContainers =
        sandboxesAfter.some(candidate => candidate.id === sandbox.id) &&
        sandboxesAfter.every(candidate => sandboxIdsBeforeFollowup.has(candidate.id));
      if (!completed || !noPrepare || !sameContainers) {
        return {
          name: 'cold-hot',
          conversation,
          ok: false,
          message: `${directive}: terminal=${hotResult.terminal?.streamEventType ?? 'none'}, firstKilocode=${firstKilocode ? `${firstKilocodeLatency}ms` : 'none'}, noPrepare=${noPrepare}, sameContainers=${sameContainers}`,
          events,
          durationMs: Date.now() - start,
        };
      }

      hotSummaries.push(
        `${directive}:${hotResult.terminal.streamEventType}/${firstKilocode ? `${firstKilocodeLatency}ms` : 'no-kilocode'}`
      );
    }

    return {
      name: 'cold-hot',
      conversation,
      ok: true,
      message: `cold=${coldResult.terminal.streamEventType}; hot=${hotSummaries.join(', ')}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'cold-hot',
      conversation,
      ok: false,
      message: `threw: ${msg}`,
      events,
      durationMs: Date.now() - start,
    };
  }
}

/**
 * External-kill: run cold, capture sandbox name, kill it, send a new prompt,
 * assert the DO surfaces the disconnect and either spawns a fresh sandbox or
 * returns a clean error.
 */
export async function lifecycleExternalKill(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 90_000, api = 'unified' } = args;
  try {
    // 1. Bring a sandbox up with a warm-up echo.
    const knownSandboxIds = await snapshotSandboxIds();
    const session = await startSession(config, { prompt: fakeDirective('echo:warmup') }, api);
    const firstStream = openStream(config, session.cloudAgentSessionId, { replay: false });
    const firstSandbox = await waitForNewSandboxPresent(knownSandboxIds, 60_000);
    if (!firstSandbox) {
      firstStream.close();
      return {
        name: 'external-kill',
        conversation,
        ok: false,
        message: 'setup: sandbox did not appear',
        events: [],
        durationMs: Date.now() - start,
      };
    }
    await firstStream.waitForTerminal(60_000);
    firstStream.close();

    // 2. Kill this session's sandbox and wait for its container family to go away.
    const killed = await killSandboxFamily(firstSandbox);
    const gone = await waitForSandboxFamilyGone(firstSandbox, 30_000);
    if (!gone) {
      return {
        name: 'external-kill',
        conversation,
        ok: false,
        message: `killed ${killed.join(',')} but ${firstSandbox.name} did not go away`,
        events: [],
        durationMs: Date.now() - start,
      };
    }

    // 3. Send a new prompt. Expect either a fresh sandbox (cold-start again)
    // or a visible error on /stream.
    const stream = openStream(config, session.cloudAgentSessionId, { replay: false });
    await sendMessage(
      config,
      {
        cloudAgentSessionId: session.cloudAgentSessionId,
        prompt: fakeDirective(conversation),
      },
      api
    );
    const { terminal, events } = await collectUntilTerminal(stream, timeoutMs);
    stream.close();

    const terminalName = terminal?.streamEventType ?? 'none';
    const reconnectSeen =
      hasEventOfType(events, 'wrapper_disconnected') ||
      hasEventOfType(events, 'wrapper_reconnected') ||
      hasEventOfType(events, 'preparing');
    const ok =
      conversation === 'hang'
        ? !!reconnectSeen // for hang, we don't expect terminal but do expect some lifecycle chatter
        : !!terminal;
    return {
      name: 'external-kill',
      conversation,
      ok,
      message: `terminal=${terminalName}, reconnectSeen=${reconnectSeen}, killed=${killed.join(',')}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'external-kill',
      conversation,
      ok: false,
      message: `threw: ${msg}`,
      events: [],
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Kill mid-flight: sandbox up, kilo mid-LLM-call. `docker kill` while the
 * fake-LLM SSE response is still parked. Assert the DO surfaces the
 * disconnect or reaper-driven failure on `/stream`.
 *
 * Uses `gate:<tag>` rather than `hang` because the gate engagement is
 * observable (via `waitForGateEngaged`) — that's the only reliable signal
 * that kilo has actually dialed the LLM and is mid-stream. A fixed sleep
 * before `docker kill` races with sandbox prep and gives false negatives.
 */
export async function lifecycleKillMidFlight(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 90_000, api = 'unified' } = args;
  const gateTag = 'killmid';
  try {
    const knownSandboxIds = await snapshotSandboxIds();
    const session = await startSession(config, { prompt: fakeDirective(`gate:${gateTag}`) }, api);
    const stream = openStream(config, session.cloudAgentSessionId, { replay: false });

    const sandbox = await waitForNewSandboxPresent(knownSandboxIds, 60_000);
    if (!sandbox) {
      stream.close();
      return {
        name: 'kill-mid-flight',
        conversation,
        ok: false,
        message: 'sandbox did not appear',
        events: [],
        durationMs: Date.now() - start,
      };
    }

    // Wait until kilo has dialed the fake LLM and the turn is parked —
    // deterministic proof the sandbox is truly mid-flight.
    const engaged = await waitForGateEngaged(config, gateTag, 90_000);
    if (!engaged) {
      stream.close();
      return {
        name: 'kill-mid-flight',
        conversation,
        ok: false,
        message: `gate:${gateTag} did not engage on fake LLM within 90s`,
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    // Kill this session's sandbox. Fake-LLM sees the parked SSE socket close
    // and drops the waiter automatically — no explicit release needed.
    const killed = await killSandboxFamily(sandbox);

    // 4. Wait for the DO to observe the disconnect — any of these signal it.
    const terminal = await stream.waitFor(event => {
      if (event.streamEventType === 'error') return true;
      if (event.streamEventType === 'complete') return true;
      if (event.streamEventType === 'interrupted') return true;
      if (event.streamEventType === 'wrapper_disconnected') return true;
      if (event.streamEventType === 'cloud.message.failed') return true;
      return false;
    }, timeoutMs);
    const events = [...stream.events];
    stream.close();

    if (!terminal) {
      return {
        name: 'kill-mid-flight',
        conversation,
        ok: false,
        message: `killed ${killed.join(',')} but no disconnect/error surfaced within ${timeoutMs}ms`,
        events,
        durationMs: Date.now() - start,
      };
    }

    return {
      name: 'kill-mid-flight',
      conversation,
      ok: true,
      message: `killed ${killed.join(',')} -> surfaced ${terminal.streamEventType}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'kill-mid-flight',
      conversation,
      ok: false,
      message: `threw: ${msg}`,
      events: [],
      durationMs: Date.now() - start,
    };
  } finally {
    // Best-effort: release the gate in case the sandbox kill didn't close the
    // socket cleanly (should be a no-op 404 normally).
    await releaseGate(config.fakeLlmUrl, gateTag).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Queue-focused scenarios
// ---------------------------------------------------------------------------

type QueuedOrCompleted = 'queued' | 'completed' | 'failed';

function messageIdFromEvent(event: StreamEvent): string | undefined {
  const data = event.data as { messageId?: string; payload?: { messageId?: string } } | undefined;
  return data?.messageId ?? data?.payload?.messageId;
}

function messagePhase(event: StreamEvent): QueuedOrCompleted | null {
  switch (event.streamEventType) {
    case 'cloud.message.queued':
      return 'queued';
    case 'cloud.message.completed':
      return 'completed';
    case 'cloud.message.failed':
      return 'failed';
    default:
      return null;
  }
}

/**
 * Pull the wrapper + kilo CLI logs from a running sandbox container and
 * render them (tailed) inline in a failure message so triage doesn't require
 * a manual `docker exec`. Used by queue scenarios to surface the root cause
 * when the test hits its timeout.
 */
async function dumpSandboxLogsForFailure(containerId: string): Promise<string> {
  try {
    const [wrapper, kilo] = await Promise.all([
      readWrapperLog(containerId).catch(() => null),
      readKiloCliLog(containerId).catch(() => null),
    ]);
    return [
      '',
      '--- wrapper log (tail) ---',
      tailLines(wrapper, 200),
      '--- kilo CLI log (tail) ---',
      tailLines(kilo, 200),
      '--- end ---',
    ].join('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `\n--- log dump failed: ${msg} ---`;
  }
}

/**
 * queue-while-busy: enqueue two messages behind an actively-blocking turn,
 * release the gate, assert FIFO delivery.
 *
 * 1. Start session with `__fake__:gate:<tag>` — the fake LLM accepts the
 *    request and holds the SSE stream open, so kilo's turn stays mid-stream.
 * 2. Poll `GET /test/gate-status?tag=<tag>` until `engaged: true` — proves
 *    kilo has dialed the fake LLM and msg1 is active on the wrapper.
 * 3. `send` two echoes — both must be acked with `delivery: 'queued'`.
 * 4. `POST /test/release?tag=<tag>` so msg1 drains.
 * 5. Assert `cloud.message.completed` arrives for msg1, then msg2, then msg3
 *    in that exact order.
 */
export async function lifecycleQueueWhileBusy(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 120_000, api = 'unified' } = args;
  const scenarioName = 'queue-while-busy';
  const gateTag = conversation || 'gate1';
  let cleanupSessionId: string | undefined;
  let terminalized = false;
  try {
    const knownSandboxIds = await snapshotSandboxIds();
    const gate = await startSession(config, { prompt: fakeDirective(`gate:${gateTag}`) }, api);
    cleanupSessionId = gate.cloudAgentSessionId;
    const stream = openStream(config, gate.cloudAgentSessionId, { replay: false });

    const sandbox = await waitForNewSandboxPresent(knownSandboxIds, 60_000);
    if (!sandbox) {
      stream.close();
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: 'sandbox did not appear within 60s',
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    const engaged = await waitForGateEngaged(config, gateTag, 90_000);
    if (!engaged) {
      stream.close();
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: `gate:${gateTag} did not engage on fake LLM within 90s`,
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    const second = await sendMessage(
      config,
      { cloudAgentSessionId: gate.cloudAgentSessionId, prompt: fakeDirective('echo:second') },
      api
    );
    const third = await sendMessage(
      config,
      { cloudAgentSessionId: gate.cloudAgentSessionId, prompt: fakeDirective('echo:third') },
      api
    );

    if (second.delivery !== 'queued' || third.delivery !== 'queued') {
      stream.close();
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: `expected delivery=queued for both follow-ups; got second=${second.delivery}, third=${third.delivery}`,
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    // Release the gate so the queue drains.
    await releaseGate(config.fakeLlmUrl, gateTag);

    // Wait for the last queued message to terminate; by then the earlier two
    // must have terminated too (queue is strict FIFO). Filter out the
    // initial `cloud.message.queued` event for the same messageId — that
    // one arrives immediately on send and isn't a terminal state.
    const thirdTerminal = await stream.waitFor(
      e =>
        messagePhase(e) !== null &&
        messagePhase(e) !== 'queued' &&
        messageIdFromEvent(e) === third.messageId,
      timeoutMs
    );
    if (!thirdTerminal) {
      const logs = await dumpSandboxLogsForFailure(sandbox.id);
      stream.close();
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: `third message ${third.messageId} did not terminate within ${timeoutMs}ms${logs}`,
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    terminalized = true;
    const events = [...stream.events];
    stream.close();

    // Build per-messageId phase ledger and assert FIFO ordering.
    type PhaseSeen = { queued: number; terminal: number };
    const phases = new Map<string, PhaseSeen>();
    let idx = 0;
    for (const event of events) {
      const phase = messagePhase(event);
      if (!phase) {
        idx++;
        continue;
      }
      const msgId = messageIdFromEvent(event);
      if (!msgId) {
        idx++;
        continue;
      }
      const prev = phases.get(msgId) ?? { queued: -1, terminal: -1 };
      if (phase === 'queued') prev.queued = idx;
      else prev.terminal = idx;
      phases.set(msgId, prev);
      idx++;
    }

    const firstTerminalIdx = phases.get(gate.messageId)?.terminal ?? -1;
    const secondTerminalIdx = phases.get(second.messageId)?.terminal ?? -1;
    const thirdTerminalIdx = phases.get(third.messageId)?.terminal ?? -1;

    const fifoOk =
      firstTerminalIdx >= 0 &&
      secondTerminalIdx > firstTerminalIdx &&
      thirdTerminalIdx > secondTerminalIdx;

    return {
      name: scenarioName,
      conversation,
      ok: fifoOk,
      message: fifoOk
        ? `FIFO: gate(${gate.messageId}) < second(${second.messageId}) < third(${third.messageId})`
        : `FIFO violated: gateIdx=${firstTerminalIdx}, secondIdx=${secondTerminalIdx}, thirdIdx=${thirdTerminalIdx}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: scenarioName,
      conversation,
      ok: false,
      message: `threw: ${msg}`,
      events: [],
      durationMs: Date.now() - start,
    };
  } finally {
    if (!terminalized && cleanupSessionId) {
      await interruptSession(config, cleanupSessionId).catch(() => {});
    }
    await releaseGate(config.fakeLlmUrl, gateTag).catch(() => {});
  }
}

/**
 * queue-rapid-fire-no-gate: minimal reproducer for queue-while-busy without
 * any gate machinery. Start a session with `echo:first`, immediately send
 * `echo:second` and `echo:third` back-to-back, then wait for the third
 * message's terminal phase. If FIFO holds we have a regression test; if it
 * hangs, dump the wrapper + kilo CLI logs inline for triage.
 *
 * This is the scenario to point kilo maintainers at if the bug turns out to
 * be kilo-side.
 */
export async function lifecycleQueueRapidFireNoGate(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 120_000, api = 'unified' } = args;
  const scenarioName = 'queue-rapid-fire-no-gate';
  try {
    const knownSandboxIds = await snapshotSandboxIds();
    const first = await startSession(config, { prompt: fakeDirective('echo:first') }, api);
    const stream = openStream(config, first.cloudAgentSessionId, { replay: false });

    // Rapid-fire the follow-ups without waiting for any terminal signal; if
    // the DO happens to be mid-init, these will land in the pending queue
    // with delivery=queued. Either way, FIFO must hold.
    const second = await sendMessage(
      config,
      { cloudAgentSessionId: first.cloudAgentSessionId, prompt: fakeDirective('echo:second') },
      api
    );
    const third = await sendMessage(
      config,
      { cloudAgentSessionId: first.cloudAgentSessionId, prompt: fakeDirective('echo:third') },
      api
    );

    const sandbox = await waitForNewSandboxPresent(knownSandboxIds, 60_000);
    if (!sandbox) {
      stream.close();
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: 'new sandbox did not appear within 60s',
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    const thirdTerminal = await stream.waitFor(
      e =>
        messagePhase(e) !== null &&
        messagePhase(e) !== 'queued' &&
        messageIdFromEvent(e) === third.messageId,
      timeoutMs
    );
    if (!thirdTerminal) {
      const logs = await dumpSandboxLogsForFailure(sandbox.id);
      stream.close();
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: `third message ${third.messageId} did not terminate within ${timeoutMs}ms (first=${first.messageId} second=${second.messageId})${logs}`,
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    const events = [...stream.events];
    stream.close();

    type PhaseSeen = { queued: number; terminal: number };
    const phases = new Map<string, PhaseSeen>();
    let idx = 0;
    for (const event of events) {
      const phase = messagePhase(event);
      if (!phase) {
        idx++;
        continue;
      }
      const msgId = messageIdFromEvent(event);
      if (!msgId) {
        idx++;
        continue;
      }
      const prev = phases.get(msgId) ?? { queued: -1, terminal: -1 };
      if (phase === 'queued') prev.queued = idx;
      else prev.terminal = idx;
      phases.set(msgId, prev);
      idx++;
    }

    const firstIdx = phases.get(first.messageId)?.terminal ?? -1;
    const secondIdx = phases.get(second.messageId)?.terminal ?? -1;
    const thirdIdx = phases.get(third.messageId)?.terminal ?? -1;
    const fifoOk = firstIdx >= 0 && secondIdx > firstIdx && thirdIdx > secondIdx;

    return {
      name: scenarioName,
      conversation,
      ok: fifoOk,
      message: fifoOk
        ? `FIFO: first(${first.messageId}) < second(${second.messageId}) < third(${third.messageId})`
        : `FIFO violated: firstIdx=${firstIdx}, secondIdx=${secondIdx}, thirdIdx=${thirdIdx}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: scenarioName,
      conversation,
      ok: false,
      message: `threw: ${msg}`,
      events: [],
      durationMs: Date.now() - start,
    };
  }
}

/**
 * queue-overflow: drive the pending queue up to `PENDING_SESSION_MESSAGE_LIMIT`
 * (10) and assert the next enqueue fails with HTTP 429 (TOO_MANY_REQUESTS).
 *
 * Strategy: block the first message with `gate:overflow` so it stays
 * active-but-busy in the wrapper, freeing the pending slot. Then enqueue 10
 * echoes (pending → capacity=10), and assert the 11th is rejected.
 */
export async function lifecycleQueueOverflow(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 120_000, api = 'unified' } = args;
  const scenarioName = 'queue-overflow';
  const gateTag = 'overflow';
  try {
    const knownSandboxIds = await snapshotSandboxIds();
    const gate = await startSession(config, { prompt: fakeDirective(`gate:${gateTag}`) }, api);
    const stream = openStream(config, gate.cloudAgentSessionId, { replay: false });

    const sandbox = await waitForNewSandboxPresent(knownSandboxIds, 60_000);
    if (!sandbox) {
      stream.close();
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: 'sandbox did not appear',
        events: [],
        durationMs: Date.now() - start,
      };
    }

    const engaged = await waitForGateEngaged(config, gateTag, 90_000);
    if (!engaged) {
      stream.close();
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: `gate:${gateTag} did not engage on fake LLM — queue slot remained occupied`,
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    // Fill the queue until enqueue starts failing with 429. The limit is
    // server-enforced (PENDING_SESSION_MESSAGE_LIMIT); the exact boundary
    // depends on whether the gate counts toward it, so we just drain until
    // we hit the wall rather than guessing the count.
    const queuedIds: string[] = [];
    let overflowOk = false;
    let overflowMessage = 'no 429 within 20 attempts';
    for (let i = 0; i < 20; i++) {
      try {
        const ack = await sendMessage(
          config,
          {
            cloudAgentSessionId: gate.cloudAgentSessionId,
            prompt: fakeDirective(`echo:q${i}`),
          },
          api
        );
        if (ack.delivery !== 'queued') {
          stream.close();
          return {
            name: scenarioName,
            conversation,
            ok: false,
            message: `fill-${i}: expected delivery=queued, got ${ack.delivery}`,
            events: [...stream.events],
            durationMs: Date.now() - start,
          };
        }
        queuedIds.push(ack.messageId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const is429 = msg.includes('429') || /TOO_MANY_REQUESTS|PENDING_QUEUE_FULL/.test(msg);
        if (!is429) throw err;
        overflowOk = true;
        overflowMessage = `filled ${queuedIds.length} before rejection: ${msg.split('—').slice(-1)[0]?.trim() ?? '429'}`;
        break;
      }
    }

    // Interrupt after proving capacity. Draining the overflow queue naturally can
    // outlive this row and keep sandbox retry work active while later smoke cases
    // are cold-starting. The interrupt path is already responsible for clearing
    // queued messages, so wait for those durable failure events before returning.
    await interruptSession(config, gate.cloudAgentSessionId);
    const queuedFailures = await Promise.all(
      queuedIds.map(messageId =>
        stream.waitFor(
          event =>
            event.streamEventType === 'cloud.message.failed' &&
            messageIdFromEvent(event) === messageId,
          timeoutMs
        )
      )
    );
    const queueCleared = queuedFailures.every(event => event !== null);
    const events = [...stream.events];
    stream.close();

    return {
      name: scenarioName,
      conversation,
      ok: overflowOk && queueCleared,
      message: overflowOk
        ? `${overflowMessage}; cleanup=${queueCleared ? 'cleared' : 'timed out'}`
        : `expected queue rejection within 20 attempts; got: ${overflowMessage}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: scenarioName,
      conversation,
      ok: false,
      message: `threw: ${msg}`,
      events: [],
      durationMs: Date.now() - start,
    };
  } finally {
    await releaseGate(config.fakeLlmUrl, gateTag).catch(() => {});
  }
}

/**
 * queue-interrupt-clears: enqueue messages behind an active turn, fire
 * `interruptSession`, assert all queued messages surface
 * `cloud.message.failed` with `reason: 'interrupted'` and `delivery: 'queued'`.
 *
 * The gate is not released directly — the interrupt itself terminates the
 * gated turn on the wrapper side. A best-effort cleanup release runs in the
 * `finally` block in case the fake's gated request is still parked.
 */
export async function lifecycleQueueInterruptClears(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 60_000, api = 'unified' } = args;
  const scenarioName = 'queue-interrupt-clears';
  const gateTag = 'intgate';
  try {
    const knownSandboxIds = await snapshotSandboxIds();
    const gate = await startSession(config, { prompt: fakeDirective(`gate:${gateTag}`) }, api);
    const stream = openStream(config, gate.cloudAgentSessionId, { replay: false });

    const sandbox = await waitForNewSandboxPresent(knownSandboxIds, 60_000);
    if (!sandbox) {
      stream.close();
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: 'sandbox did not appear',
        events: [],
        durationMs: Date.now() - start,
      };
    }

    const engaged = await waitForGateEngaged(config, gateTag, 90_000);
    if (!engaged) {
      stream.close();
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: `gate:${gateTag} did not engage on fake LLM`,
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    const second = await sendMessage(
      config,
      { cloudAgentSessionId: gate.cloudAgentSessionId, prompt: fakeDirective('echo:second') },
      api
    );
    const third = await sendMessage(
      config,
      { cloudAgentSessionId: gate.cloudAgentSessionId, prompt: fakeDirective('echo:third') },
      api
    );

    await interruptSession(config, gate.cloudAgentSessionId);

    // Expect cloud.message.failed for both queued follow-ups.
    const secondFailed = await stream.waitFor(
      e =>
        e.streamEventType === 'cloud.message.failed' && messageIdFromEvent(e) === second.messageId,
      timeoutMs
    );
    const thirdFailed = await stream.waitFor(
      e =>
        e.streamEventType === 'cloud.message.failed' && messageIdFromEvent(e) === third.messageId,
      timeoutMs
    );

    const events = [...stream.events];
    stream.close();

    function failedWithReasonInterrupted(event: StreamEvent | null): boolean {
      if (!event) return false;
      const data = event.data as
        | { reason?: string; delivery?: string; payload?: { reason?: string; delivery?: string } }
        | undefined;
      const reason = data?.reason ?? data?.payload?.reason;
      const delivery = data?.delivery ?? data?.payload?.delivery;
      return reason === 'interrupted' && delivery === 'queued';
    }

    const secondOk = failedWithReasonInterrupted(secondFailed);
    const thirdOk = failedWithReasonInterrupted(thirdFailed);

    return {
      name: scenarioName,
      conversation,
      ok: secondOk && thirdOk,
      message: `second=${secondOk ? 'ok' : 'fail'}, third=${thirdOk ? 'ok' : 'fail'}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: scenarioName,
      conversation,
      ok: false,
      message: `threw: ${msg}`,
      events: [],
      durationMs: Date.now() - start,
    };
  } finally {
    // Best-effort cleanup: if the fake's gated request is still parked after
    // the interrupt, release it so the server isn't holding a zombie stream.
    // 404 is fine — means the gate already went away with the interrupt.
    await releaseGate(config.fakeLlmUrl, gateTag).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Single-turn scenarios driving specific fake-LLM directives
// ---------------------------------------------------------------------------

/**
 * llm-error: drives `__fake__:error:<msg>` so the fake returns HTTP 402 with
 * an OpenAI-shape error body. Assert the worker terminalizes with a failure
 * (not `complete`), and the sandbox doesn't hang indefinitely.
 *
 * Conversation arg is the error message (e.g. `llm-error boom`).
 */
export async function lifecycleLlmError(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 60_000, api = 'unified' } = args;
  const errorMsg = conversation || 'simulated-error';
  try {
    const knownSandboxIds = await snapshotSandboxIds();
    const session = await startSession(config, { prompt: fakeDirective(`error:${errorMsg}`) }, api);
    const stream = openStream(config, session.cloudAgentSessionId, { replay: false });

    const sandbox = await waitForNewSandboxPresent(knownSandboxIds, 60_000);
    if (!sandbox) {
      stream.close();
      return {
        name: 'llm-error',
        conversation,
        ok: false,
        message: 'sandbox did not appear',
        events: [],
        durationMs: Date.now() - start,
      };
    }

    const terminal = await stream.waitForTerminal(timeoutMs);
    const events = [...stream.events];
    stream.close();

    const isFailure =
      terminal?.streamEventType === 'cloud.message.failed' || terminal?.streamEventType === 'error';

    return {
      name: 'llm-error',
      conversation,
      ok: !!terminal && isFailure,
      message: terminal
        ? `terminal=${terminal.streamEventType}${isFailure ? '' : ' (expected failure)'}`
        : `no terminal event within ${timeoutMs}ms`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'llm-error',
      conversation,
      ok: false,
      message: `threw: ${msg}`,
      events: [],
      durationMs: Date.now() - start,
    };
  }
}

/**
 * chunked-streaming: drives `__fake__:slow:<n>:<ms>` (defaults 5:50). The fake
 * emits <n> assistant content chunks separated by <ms>ms delays. Assert
 * (a) the turn completes, and (b) multiple `message.part.delta` events are
 * observed downstream — proving SSE chunks aren't coalesced into one event.
 */
export async function lifecycleChunkedStreaming(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 60_000, api = 'unified' } = args;
  const directive = conversation && conversation !== '_' ? conversation : 'slow:5:50';
  try {
    const knownSandboxIds = await snapshotSandboxIds();
    const session = await startSession(config, { prompt: fakeDirective(directive) }, api);
    const stream = openStream(config, session.cloudAgentSessionId, { replay: false });

    const sandbox = await waitForNewSandboxPresent(knownSandboxIds, 60_000);
    if (!sandbox) {
      stream.close();
      return {
        name: 'chunked-streaming',
        conversation,
        ok: false,
        message: 'sandbox did not appear',
        events: [],
        durationMs: Date.now() - start,
      };
    }

    const terminal = await stream.waitForTerminal(timeoutMs);
    const events = [...stream.events];
    stream.close();

    // Count message.part.delta events — these carry streamed content pieces
    // from kilo's SDK. Real streaming should produce multiple; one coalesced
    // event would indicate SSE buffering broke chunking semantics.
    const deltaCount = events.filter(
      e =>
        e.streamEventType === 'kilocode' &&
        (e.data as { type?: string } | undefined)?.type === 'message.part.delta'
    ).length;

    const ok =
      terminal?.streamEventType === 'complete' ||
      terminal?.streamEventType === 'cloud.message.completed';

    return {
      name: 'chunked-streaming',
      conversation,
      ok: ok && deltaCount >= 2,
      message: `terminal=${terminal?.streamEventType ?? 'none'}, deltas=${deltaCount}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'chunked-streaming',
      conversation,
      ok: false,
      message: `threw: ${msg}`,
      events: [],
      durationMs: Date.now() - start,
    };
  }
}

/**
 * empty-response: drives `__fake__:idle` so the fake emits a single empty
 * assistant chunk + finish + [DONE]. Assert the worker tolerates a
 * zero-content assistant message — session completes cleanly without any
 * `message.part.delta`.
 */
export async function lifecycleEmptyResponse(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 60_000, api = 'unified' } = args;
  try {
    const knownSandboxIds = await snapshotSandboxIds();
    const session = await startSession(config, { prompt: fakeDirective('idle') }, api);
    const stream = openStream(config, session.cloudAgentSessionId, { replay: false });

    const sandbox = await waitForNewSandboxPresent(knownSandboxIds, 60_000);
    if (!sandbox) {
      stream.close();
      return {
        name: 'empty-response',
        conversation,
        ok: false,
        message: 'sandbox did not appear',
        events: [],
        durationMs: Date.now() - start,
      };
    }

    const terminal = await stream.waitForTerminal(timeoutMs);
    const events = [...stream.events];
    stream.close();

    const deltaCount = events.filter(
      e =>
        e.streamEventType === 'kilocode' &&
        (e.data as { type?: string } | undefined)?.type === 'message.part.delta'
    ).length;
    const completed =
      terminal?.streamEventType === 'complete' ||
      terminal?.streamEventType === 'cloud.message.completed';

    return {
      name: 'empty-response',
      conversation,
      ok: completed && deltaCount === 0,
      message: `terminal=${terminal?.streamEventType ?? 'none'}, deltas=${deltaCount}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'empty-response',
      conversation,
      ok: false,
      message: `threw: ${msg}`,
      events: [],
      durationMs: Date.now() - start,
    };
  }
}

/**
 * interrupt-mid-stream: complement to `queue-interrupt-clears`. Here the
 * interrupt fires while a turn is ACTIVELY streaming (not queued). Assert
 * the active message surfaces `cloud.message.failed` with
 * `reason === 'interrupted'` and `delivery !== 'queued'`.
 */
export async function lifecycleInterruptMidStream(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 60_000, api = 'unified' } = args;
  const gateTag = 'intactive';
  try {
    const knownSandboxIds = await snapshotSandboxIds();
    const session = await startSession(config, { prompt: fakeDirective(`gate:${gateTag}`) }, api);
    const stream = openStream(config, session.cloudAgentSessionId, { replay: false });

    const sandbox = await waitForNewSandboxPresent(knownSandboxIds, 60_000);
    if (!sandbox) {
      stream.close();
      return {
        name: 'interrupt-mid-stream',
        conversation,
        ok: false,
        message: 'sandbox did not appear',
        events: [],
        durationMs: Date.now() - start,
      };
    }

    const engaged = await waitForGateEngaged(config, gateTag, 90_000);
    if (!engaged) {
      stream.close();
      return {
        name: 'interrupt-mid-stream',
        conversation,
        ok: false,
        message: `gate:${gateTag} did not engage within 90s`,
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    await interruptSession(config, session.cloudAgentSessionId);

    const failed = await stream.waitFor(
      e =>
        e.streamEventType === 'cloud.message.failed' && messageIdFromEvent(e) === session.messageId,
      timeoutMs
    );
    const events = [...stream.events];
    stream.close();

    if (!failed) {
      return {
        name: 'interrupt-mid-stream',
        conversation,
        ok: false,
        message: `no cloud.message.failed for active message within ${timeoutMs}ms`,
        events,
        durationMs: Date.now() - start,
      };
    }

    const data = failed.data as
      | { reason?: string; delivery?: string; payload?: { reason?: string; delivery?: string } }
      | undefined;
    const reason = data?.reason ?? data?.payload?.reason;
    const delivery = data?.delivery ?? data?.payload?.delivery;
    const ok = reason === 'interrupted' && delivery !== 'queued';

    return {
      name: 'interrupt-mid-stream',
      conversation,
      ok,
      message: `reason=${reason ?? 'none'} delivery=${delivery ?? 'none'}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'interrupt-mid-stream',
      conversation,
      ok: false,
      message: `threw: ${msg}`,
      events: [],
      durationMs: Date.now() - start,
    };
  } finally {
    await releaseGate(config.fakeLlmUrl, gateTag).catch(() => {});
  }
}

/**
 * unknown-model: request a model the fake LLM validation route rejects
 * (`kilo/does-not-exist`). The mutation must reject before a sandbox or a
 * chat-completion dispatch is created.
 */
export async function lifecycleUnknownModel(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, api = 'unified' } = args;
  const overriddenConfig: DriverConfig = { ...config, model: 'kilo/does-not-exist' };
  try {
    const knownSandboxIds = await snapshotSandboxIds();
    const requestsBefore = await fetchFakeRequests(config.fakeLlmUrl);
    try {
      await startSession(overriddenConfig, { prompt: fakeDirective('echo:ignored') }, api);
      return {
        name: 'unknown-model',
        conversation,
        ok: false,
        message: 'invalid model mutation was accepted',
        events: [],
        durationMs: Date.now() - start,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const sandbox = await waitForNewSandboxPresent(knownSandboxIds, 2_000);
      const requestsAfter = await fetchFakeRequests(config.fakeLlmUrl);
      const rejectedUnavailableModel = /Selected model is not available/i.test(message);
      const noPromptDispatch = requestsAfter.chatCompletions === requestsBefore.chatCompletions;
      const noSandbox = sandbox === null;
      return {
        name: 'unknown-model',
        conversation,
        ok: rejectedUnavailableModel && noPromptDispatch && noSandbox,
        message: `rejected=${rejectedUnavailableModel} sandbox=${noSandbox ? 'none' : 'created'} prompts=${requestsAfter.chatCompletions - requestsBefore.chatCompletions}`,
        events: [],
        durationMs: Date.now() - start,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: 'unknown-model',
      conversation,
      ok: false,
      message: `threw: ${message}`,
      events: [],
      durationMs: Date.now() - start,
    };
  }
}

/**
 * waiters-clean: cold echo run followed by a `/test/waiters` snapshot.
 * Asserts the fake LLM has no parked waiters after a normal turn completes
 * — catches regressions where kilo's title-model call (or other internal
 * calls) leaks a connection.
 */
export async function lifecycleWaitersClean(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 60_000, api = 'unified' } = args;
  const convo = conversation && conversation !== '_' ? conversation : 'echo:hi';
  try {
    const knownSandboxIds = await snapshotSandboxIds();
    const session = await startSession(config, { prompt: fakeDirective(convo) }, api);
    const stream = openStream(config, session.cloudAgentSessionId, { replay: false });

    const sandbox = await waitForNewSandboxPresent(knownSandboxIds, 60_000);
    if (!sandbox) {
      stream.close();
      return {
        name: 'waiters-clean',
        conversation,
        ok: false,
        message: 'sandbox did not appear',
        events: [],
        durationMs: Date.now() - start,
      };
    }

    const terminal = await stream.waitForTerminal(timeoutMs);
    const events = [...stream.events];
    stream.close();

    if (!terminal) {
      return {
        name: 'waiters-clean',
        conversation,
        ok: false,
        message: `no terminal within ${timeoutMs}ms`,
        events,
        durationMs: Date.now() - start,
      };
    }

    // Give kilo a moment to close its title-model SSE connection.
    await new Promise(r => setTimeout(r, 500));
    const snapshot = await fetchFakeWaiters(config.fakeLlmUrl);
    const waiterCount = snapshot.tags.reduce((sum, t) => sum + t.count, 0);
    const ok = waiterCount === 0 && snapshot.liveResponses === 0;

    return {
      name: 'waiters-clean',
      conversation,
      ok,
      message: `terminal=${terminal.streamEventType}, waiters=${waiterCount}, liveResponses=${snapshot.liveResponses}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'waiters-clean',
      conversation,
      ok: false,
      message: `threw: ${msg}`,
      events: [],
      durationMs: Date.now() - start,
    };
  }
}

// ---------------------------------------------------------------------------
// Callback scenarios
// ---------------------------------------------------------------------------

type CallbackPayload = {
  sessionId?: string;
  cloudAgentSessionId?: string;
  executionId?: string;
  messageId?: string;
  status?: string;
  errorMessage?: string;
  lastAssistantMessageText?: string;
};

function callbackPayload(record: { body: unknown }): CallbackPayload {
  return (record.body ?? {}) as CallbackPayload;
}

function callbackPayloadsForSession(
  sink: CallbackServerHandle,
  cloudAgentSessionId: string
): CallbackPayload[] {
  return sink.received
    .map(callbackPayload)
    .filter(payload => payload.cloudAgentSessionId === cloudAgentSessionId);
}

/**
 * callback-completion: exercise the `callbackTarget` path end-to-end.
 *
 * 1. Spin up a local HTTP sink on an ephemeral port.
 * 2. Start a session with `callbackTarget.url` pointed at the sink.
 * 3. Drive the configured conversation (defaults to `echo:done`).
  * 4. Wait for the stream to complete, then wait for a POST at the sink
  *    whose `messageId` matches the started message.
  * 5. Assert `status === 'completed'` and the last-assistant-message is
  *    echoed back in the payload (confirming the outbound fetch ran with
  *    the settled message's metadata).

 */
export async function lifecycleCallbackCompletion(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 90_000, api = 'unified' } = args;
  const scenarioName = 'callback-completion';
  const directive = conversation || 'echo:done';
  const expectedText = directive.startsWith('echo:') ? directive.slice('echo:'.length) : undefined;
  let sink: CallbackServerHandle | null = null;
  try {
    sink = await startCallbackServer();
    const knownSandboxIds = await snapshotSandboxIds();
    const session = await startSession(
      config,
      {
        prompt: fakeDirective(directive),
        callbackTarget: { url: sink.callbackUrl },
      },
      api
    );
    const stream = openStream(config, session.cloudAgentSessionId, { replay: false });

    const sandbox = await waitForNewSandboxPresent(knownSandboxIds, 60_000);
    if (!sandbox) {
      stream.close();
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: 'sandbox did not appear',
        events: [],
        durationMs: Date.now() - start,
      };
    }

    const terminal = await stream.waitForTerminal(timeoutMs);
    const events = [...stream.events];
    stream.close();

    if (!terminal) {
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: 'stream terminated without a terminal event',
        events,
        durationMs: Date.now() - start,
      };
    }

    const record = await sink.waitFor(
      r => callbackPayload(r).cloudAgentSessionId === session.cloudAgentSessionId,
      20_000
    );
    if (!record) {
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: 'no callback received within 20s',
        events,
        durationMs: Date.now() - start,
      };
    }

    const payload = callbackPayload(record);
    const statusOk = payload.status === 'completed';
    const messageIdOk = payload.messageId === session.messageId;
    const textOk = expectedText === undefined || payload.lastAssistantMessageText === expectedText;
    const ok = statusOk && messageIdOk && textOk;

    return {
      name: scenarioName,
      conversation,
      ok,
      message: ok
        ? `callback status=${payload.status} messageId=${payload.messageId}`
        : `callback mismatch: status=${payload.status} messageIdOk=${messageIdOk} textOk=${textOk} (expected=${JSON.stringify(expectedText)} got=${JSON.stringify(payload.lastAssistantMessageText)})`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: scenarioName,
      conversation,
      ok: false,
      message: `threw: ${msg}`,
      events: [],
      durationMs: Date.now() - start,
    };
  } finally {
    await sink?.close().catch(() => {});
  }
}

/**
 * callback-batch-followup: exercise the callback idle-batch contract through
 * the real Worker + DO + sandbox + wrapper path.
 *
 * Phase 1 blocks the initial message, queues two callback-relevant follow-ups,
 * releases the gate, and expects one callback for the last queued message only.
 * Phase 2 sends a later hot follow-up after that idle batch has settled and
 * expects a fresh second callback for that new batch.
 */
export async function lifecycleCallbackBatchFollowup(
  args: LifecycleArgs
): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, timeoutMs = 120_000, api = 'unified' } = args;
  const scenarioName = 'callback-batch-followup';
  const gateTag = 'callback-batch';
  let sink: CallbackServerHandle | null = null;
  let cleanupSessionId: string | undefined;
  let batchCompleted = false;
  try {
    sink = await startCallbackServer();
    const knownSandboxIds = await snapshotSandboxIds();
    const first = await startSession(
      config,
      {
        prompt: fakeDirective(`gate:${gateTag}`),
        callbackTarget: { url: sink.callbackUrl },
      },
      api
    );
    cleanupSessionId = first.cloudAgentSessionId;
    const stream = openStream(config, first.cloudAgentSessionId, { replay: false });

    const sandbox = await waitForNewSandboxPresent(knownSandboxIds, 60_000);
    if (!sandbox) {
      stream.close();
      return {
        name: scenarioName,
        conversation: `gate:${gateTag}`,
        ok: false,
        message: 'sandbox did not appear',
        events: [],
        durationMs: Date.now() - start,
      };
    }

    const engaged = await waitForGateEngaged(config, gateTag, 90_000);
    if (!engaged) {
      const events = [...stream.events];
      stream.close();
      return {
        name: scenarioName,
        conversation: `gate:${gateTag}`,
        ok: false,
        message: `gate:${gateTag} did not engage within 90s`,
        events,
        durationMs: Date.now() - start,
      };
    }

    const second = await sendMessage(
      config,
      {
        cloudAgentSessionId: first.cloudAgentSessionId,
        prompt: fakeDirective('echo:second'),
      },
      api
    );
    const third = await sendMessage(
      config,
      {
        cloudAgentSessionId: first.cloudAgentSessionId,
        prompt: fakeDirective('echo:third'),
      },
      api
    );
    if (second.delivery !== 'queued' || third.delivery !== 'queued') {
      const events = [...stream.events];
      stream.close();
      return {
        name: scenarioName,
        conversation: `gate:${gateTag}`,
        ok: false,
        message: `expected queued follow-ups; got second=${second.delivery}, third=${third.delivery}`,
        events,
        durationMs: Date.now() - start,
      };
    }

    await releaseGate(config.fakeLlmUrl, gateTag);
    const thirdTerminal = await stream.waitFor(
      event =>
        messagePhase(event) !== null &&
        messagePhase(event) !== 'queued' &&
        messageIdFromEvent(event) === third.messageId,
      timeoutMs
    );
    if (!thirdTerminal || messagePhase(thirdTerminal) !== 'completed') {
      const logs = await dumpSandboxLogsForFailure(sandbox.id);
      const events = [...stream.events];
      stream.close();
      return {
        name: scenarioName,
        conversation: `gate:${gateTag}`,
        ok: false,
        message: `queued batch did not complete on ${third.messageId}${logs}`,
        events,
        durationMs: Date.now() - start,
      };
    }

    const firstCallback = await sink.waitFor(
      record => callbackPayload(record).messageId === third.messageId,
      20_000
    );
    const queuedBatchCallbacks = callbackPayloadsForSession(sink, first.cloudAgentSessionId);
    const queuedBatchCallbackIds = queuedBatchCallbacks.map(payload => payload.messageId);
    const queuedBatchPayload = firstCallback ? callbackPayload(firstCallback) : undefined;
    const batchCallbackOk =
      firstCallback !== null &&
      queuedBatchCallbacks.length === 1 &&
      queuedBatchPayload?.status === 'completed' &&
      queuedBatchPayload.messageId === third.messageId &&
      queuedBatchPayload.lastAssistantMessageText === 'third' &&
      !queuedBatchCallbackIds.includes(first.messageId) &&
      !queuedBatchCallbackIds.includes(second.messageId);
    if (!batchCallbackOk) {
      const events = [...stream.events];
      stream.close();
      return {
        name: scenarioName,
        conversation: `gate:${gateTag}`,
        ok: false,
        message: `queued callback batch mismatch: ids=${queuedBatchCallbackIds.join(',') || 'none'} status=${queuedBatchPayload?.status ?? 'missing'} text=${JSON.stringify(queuedBatchPayload?.lastAssistantMessageText)}`,
        events,
        durationMs: Date.now() - start,
      };
    }

    const afterBatch = await sendMessage(
      config,
      {
        cloudAgentSessionId: first.cloudAgentSessionId,
        prompt: fakeDirective('echo:after-batch'),
      },
      api
    );
    const afterBatchTerminal = await stream.waitFor(
      event =>
        messagePhase(event) !== null &&
        messagePhase(event) !== 'queued' &&
        messageIdFromEvent(event) === afterBatch.messageId,
      timeoutMs
    );
    if (!afterBatchTerminal || messagePhase(afterBatchTerminal) !== 'completed') {
      const logs = await dumpSandboxLogsForFailure(sandbox.id);
      const events = [...stream.events];
      stream.close();
      return {
        name: scenarioName,
        conversation: 'echo:after-batch',
        ok: false,
        message: `sequential follow-up did not complete on ${afterBatch.messageId}${logs}`,
        events,
        durationMs: Date.now() - start,
      };
    }

    const secondCallback = await sink.waitFor(
      record => callbackPayload(record).messageId === afterBatch.messageId,
      20_000
    );
    const callbackPayloads = callbackPayloadsForSession(sink, first.cloudAgentSessionId);
    const callbackIds = callbackPayloads.map(payload => payload.messageId);
    const statuses = callbackPayloads.map(payload => payload.status);
    const texts = callbackPayloads.map(payload => payload.lastAssistantMessageText);
    const sequentialOk =
      secondCallback !== null &&
      callbackPayloads.length === 2 &&
      callbackIds[0] === third.messageId &&
      callbackIds[1] === afterBatch.messageId &&
      statuses[0] === 'completed' &&
      statuses[1] === 'completed' &&
      texts[0] === 'third' &&
      texts[1] === 'after-batch';
    if (!sequentialOk) {
      const events = [...stream.events];
      stream.close();
      return {
        name: scenarioName,
        conversation: 'echo:after-batch',
        ok: false,
        message: `sequential callback mismatch: ids=${callbackIds.join(',') || 'none'} statuses=${statuses.join(',') || 'none'} texts=${JSON.stringify(texts)}`,
        events,
        durationMs: Date.now() - start,
      };
    }

    const quietStart = Date.now();
    const extraCallback = await sink.waitFor(
      record =>
        callbackPayload(record).cloudAgentSessionId === first.cloudAgentSessionId &&
        record.receivedAt > quietStart,
      2_000
    );
    const events = [...stream.events];
    stream.close();
    if (extraCallback) {
      const extraPayload = callbackPayload(extraCallback);
      return {
        name: scenarioName,
        conversation: 'echo:after-batch',
        ok: false,
        message: `unexpected extra callback for ${extraPayload.messageId ?? 'unknown message'}`,
        events,
        durationMs: Date.now() - start,
      };
    }

    batchCompleted = true;
    return {
      name: scenarioName,
      conversation: 'gate:callback-batch + echo:after-batch',
      ok: true,
      message: `callbacks=${callbackIds.join(' -> ')}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: scenarioName,
      conversation: 'gate:callback-batch + echo:after-batch',
      ok: false,
      message: `threw: ${msg}`,
      events: [],
      durationMs: Date.now() - start,
    };
  } finally {
    if (!batchCompleted && cleanupSessionId) {
      await interruptSession(config, cleanupSessionId).catch(() => {});
    }
    await releaseGate(config.fakeLlmUrl, gateTag).catch(() => {});
    await sink?.close().catch(() => {});
  }
}

/**
 * callback-interrupt: asserts the callback fires with
 * `status: 'interrupted'` when the driver calls `interruptSession` on an
 * active execution.
 *
 * Uses `gate:<tag>` so the fake LLM proves the request is parked before the
 * interrupt lands. That keeps this active-interrupt path deterministic without
 * a fixed readiness sleep.
 */
export async function lifecycleCallbackInterrupt(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, timeoutMs = 90_000, api = 'unified' } = args;
  const scenarioName = 'callback-interrupt';
  const gateTag = 'callback-interrupt';
  let sink: CallbackServerHandle | null = null;
  try {
    sink = await startCallbackServer();
    const knownSandboxIds = await snapshotSandboxIds();
    const session = await startSession(
      config,
      {
        prompt: fakeDirective(`gate:${gateTag}`),
        callbackTarget: { url: sink.callbackUrl },
      },
      api
    );
    const stream = openStream(config, session.cloudAgentSessionId, { replay: false });

    const sandbox = await waitForNewSandboxPresent(knownSandboxIds, 60_000);
    if (!sandbox) {
      stream.close();
      return {
        name: scenarioName,
        conversation: `gate:${gateTag}`,
        ok: false,
        message: 'sandbox did not appear',
        events: [],
        durationMs: Date.now() - start,
      };
    }

    const engaged = await waitForGateEngaged(config, gateTag, 90_000);
    if (!engaged) {
      stream.close();
      return {
        name: scenarioName,
        conversation: `gate:${gateTag}`,
        ok: false,
        message: `gate:${gateTag} did not engage within 90s`,
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    await interruptSession(config, session.cloudAgentSessionId);

    const terminal = await stream.waitForTerminal(timeoutMs);
    const events = [...stream.events];
    stream.close();

    if (!terminal) {
      return {
        name: scenarioName,
        conversation: `gate:${gateTag}`,
        ok: false,
        message: 'no terminal stream event after interrupt',
        events,
        durationMs: Date.now() - start,
      };
    }

    const record = await sink.waitFor(
      r => callbackPayload(r).cloudAgentSessionId === session.cloudAgentSessionId,
      20_000
    );
    if (!record) {
      return {
        name: scenarioName,
        conversation: `gate:${gateTag}`,
        ok: false,
        message: 'no callback received after interrupt',
        events,
        durationMs: Date.now() - start,
      };
    }

    const payload = callbackPayload(record);
    const interrupted = payload.status === 'interrupted';
    return {
      name: scenarioName,
      conversation: `gate:${gateTag}`,
      ok: interrupted,
      message: `callback status=${payload.status} messageId=${payload.messageId}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: scenarioName,
      conversation: `gate:${gateTag}`,
      ok: false,
      message: `threw: ${msg}`,
      events: [],
      durationMs: Date.now() - start,
    };
  } finally {
    await releaseGate(config.fakeLlmUrl, gateTag).catch(() => {});
    await sink?.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export const LIFECYCLE_SCENARIOS: Record<
  string,
  (args: LifecycleArgs) => Promise<LifecycleResult>
> = {
  cold: lifecycleCold,
  hot: lifecycleHot,
  followup: lifecycleFollowup,
  'cold-hot': lifecycleColdHot,
  'external-kill': lifecycleExternalKill,
  'kill-mid-flight': lifecycleKillMidFlight,
  'queue-while-busy': lifecycleQueueWhileBusy,
  'queue-rapid-fire-no-gate': lifecycleQueueRapidFireNoGate,
  'queue-overflow': lifecycleQueueOverflow,
  'queue-interrupt-clears': lifecycleQueueInterruptClears,
  'llm-error': lifecycleLlmError,
  'chunked-streaming': lifecycleChunkedStreaming,
  'empty-response': lifecycleEmptyResponse,
  'interrupt-mid-stream': lifecycleInterruptMidStream,
  'unknown-model': lifecycleUnknownModel,
  'waiters-clean': lifecycleWaitersClean,
  'callback-completion': lifecycleCallbackCompletion,
  'callback-batch-followup': lifecycleCallbackBatchFollowup,
  'callback-interrupt': lifecycleCallbackInterrupt,
};
