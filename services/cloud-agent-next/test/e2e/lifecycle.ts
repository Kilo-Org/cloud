/**
 * Lifecycle scenarios. Each scenario composes the client + sandbox primitives
 * to drive the wrapper boot / reuse / kill paths. The conversation dimension
 * (echo, slow, gate, hang, ...) is handled by the fake LLM gateway via the
 * directive embedded in the prompt.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  fetchFakeRequests,
  fetchFakeWaiters,
  getMessageResult,
  interruptSession,
  isMessageCompleted,
  messageIdFromEvent,
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
  listSandboxesForAgentSession,
  sandboxFamilyKey,
  readKiloCliLog,
  readWrapperLog,
  tailLines,
  waitForNewSandboxPresent,
  waitForSandboxFamilyGone,
  type SandboxContainer,
} from './sandbox-control.js';

const execFileAsync = promisify(execFile);

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
  /**
   * Overall per-scenario timeout. Conservative default for cold-boot paths.
   * 120s gives margin over the wrapper startup path (3 attempts × 30s
   * waitForPort) plus ensureSessionReady, which can collectively approach 90s
   * under Docker contention.
   */
  timeoutMs?: number;
};

function fakeDirective(conversation: ConversationScenario): string {
  return `__fake__:${conversation}`;
}

async function collectUntilTerminal(
  stream: ReturnType<typeof openStream>,
  messageId: string,
  timeoutMs: number
): Promise<{ terminal: StreamEvent | null; events: StreamEvent[] }> {
  const terminal = await stream.waitForTerminal(timeoutMs, messageId);
  return { terminal, events: [...stream.events] };
}

function hasPreparationForMessage(events: StreamEvent[], messageId: string): boolean {
  return events.some(
    event => event.streamEventType === 'preparing' && event.data.triggerMessageId === messageId
  );
}

async function openConnectedStream(config: DriverConfig, sessionId: string, replay = true) {
  const stream = openStream(config, sessionId, { replay });
  const connected = await stream.waitFor(event => event.streamEventType === 'connected', 10_000);
  if (!connected) {
    stream.close();
    throw new Error(`Stream did not connect for ${sessionId}`);
  }
  return stream;
}

async function sandboxOwnsSession(containerId: string, sessionId: string): Promise<boolean> {
  const probe = `
    const fs = require('node:fs');
    const sessionId = process.argv.at(-1);
    if (!sessionId.startsWith('workspace_')) {
      const logs = fs.readdirSync('/tmp').filter(name => /^kilocode-wrapper-agent_.+\\.log$/.test(name));
      process.exit(logs.length > 0 && logs.every(name =>
        name.startsWith('kilocode-wrapper-' + sessionId + '-')
      ) ? 0 : 1);
    }
    const log = fs.readFileSync('/tmp/kilocode-control-wrapper.log', 'utf8');
    const directories = [...log.matchAll(/session\\.attach ready directory=([^\\n]+)/g)];
    process.exit(directories.length > 0 && directories.every(match =>
      match[1].trim().split('/').at(-1) === sessionId
    ) ? 0 : 1);
  `;
  try {
    await execFileAsync('docker', ['exec', containerId, 'bun', '-e', probe, sessionId], {
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function findOwnedSandboxes(sessionId: string, knownIds: Set<string>) {
  const candidates = sessionId.startsWith('workspace_')
    ? await listSandboxContainers()
    : await listSandboxesForAgentSession(sessionId);
  const matches: SandboxContainer[] = [];
  for (const container of candidates) {
    if (container.isProxy || knownIds.has(container.id)) continue;
    if (await sandboxOwnsSession(container.id, sessionId)) matches.push(container);
  }
  return matches;
}

async function waitForOwnedSandbox(
  sessionId: string,
  knownIds: Set<string>,
  timeoutMs: number
): Promise<SandboxContainer | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = await findOwnedSandboxes(sessionId, knownIds);
    if (matches.length > 1) {
      throw new Error(`Multiple containers match ${sessionId}; refusing ambiguous ownership`);
    }
    if (matches[0]) return matches[0];
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return null;
}

async function stopOwnedSandboxFamily(sandbox: SandboxContainer, sessionId: string) {
  const current = (await listSandboxContainers()).find(
    container => container.name === sandbox.name
  );
  if (current) {
    if (current.id !== sandbox.id)
      throw new Error(`Container identity changed for ${sandbox.name}`);
    const owned = await sandboxOwnsSession(current.id, sessionId);
    if (!owned) throw new Error(`Cannot prove exclusive ownership of ${sandbox.name}`);
  }
  const killed = await killSandboxFamily(sandbox);
  if (!(await waitForSandboxFamilyGone(sandbox, 30_000))) {
    throw new Error(`Owned sandbox family ${sandbox.name} is still running after cleanup`);
  }
  return killed;
}

async function sendRecoveryTurn(
  config: DriverConfig,
  sessionId: string,
  api: ApiVersion,
  timeoutMs: number
) {
  const stream = await openConnectedStream(config, sessionId, false);
  try {
    const sent = await sendMessage(
      config,
      { cloudAgentSessionId: sessionId, prompt: fakeDirective('echo:recovered') },
      api
    );
    const collected = await collectUntilTerminal(stream, sent.messageId, timeoutMs);
    const result = await getMessageResult(config, sessionId, sent.messageId);
    return { ...sent, ...collected, status: result.status };
  } finally {
    stream.close();
  }
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
  const { config, conversation, timeoutMs = 120_000, api = 'unified' } = args;
  try {
    const knownSandboxIds = await snapshotSandboxIds();
    const sessionResult = await startSession(config, { prompt: fakeDirective(conversation) }, api);
    const stream = await openConnectedStream(config, sessionResult.cloudAgentSessionId);
    const sandbox = await waitForOwnedSandbox(
      sessionResult.cloudAgentSessionId,
      knownSandboxIds,
      timeoutMs
    );
    if (!sandbox) {
      stream.close();
      return {
        name: 'cold',
        conversation,
        ok: false,
        message: `could not identify an exclusively owned sandbox within ${timeoutMs}ms`,
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    const { terminal, events } = await collectUntilTerminal(
      stream,
      sessionResult.messageId,
      timeoutMs
    );
    const stillConnected = stream.isOpen;
    stream.close();

    if (conversation === 'hang') {
      // Hang scenario: we expect NO terminal event. If we got one, fail.
      if (terminal || !stillConnected) {
        return {
          name: 'cold',
          conversation,
          ok: false,
          message: `hang scenario ended unexpectedly: ${terminal?.streamEventType ?? 'stream closed'}`,
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
      ok: isMessageCompleted(terminal, sessionResult.messageId),
      message: `session=${sessionResult.cloudAgentSessionId}, message=${sessionResult.messageId}, terminal=${terminal.streamEventType}`,
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
    const warmupStream = await openConnectedStream(config, session.cloudAgentSessionId);
    const warmupSandbox = await waitForOwnedSandbox(
      session.cloudAgentSessionId,
      knownSandboxIds,
      timeoutMs
    );
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
    const warmupTerminal = await warmupStream.waitForTerminal(timeoutMs, session.messageId);
    warmupStream.close();
    if (!isMessageCompleted(warmupTerminal, session.messageId)) {
      return {
        name: 'hot',
        conversation,
        ok: false,
        message: `warmup ${session.messageId}: expected successful message completion`,
        events: [...warmupStream.events],
        durationMs: Date.now() - start,
      };
    }

    // Send follow-up prompt. Should land on the same (hot) sandbox.
    const sandboxIdsBeforeFollowup = await snapshotSandboxIds();
    const followPrompt = fakeDirective(conversation);
    const stream = await openConnectedStream(config, session.cloudAgentSessionId, false);
    const sent = await sendMessage(
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

    const { terminal, events } = await collectUntilTerminal(stream, sent.messageId, timeoutMs);
    const stillConnected = stream.isOpen;
    stream.close();

    const sandboxesAfter = await listSandboxContainers();
    const noPrepare = !hasPreparationForMessage(events, sent.messageId);

    const sameContainers =
      sandboxesAfter.some(sandbox => sandbox.id === warmupSandbox.id) &&
      sandboxesAfter.every(sandbox => sandboxIdsBeforeFollowup.has(sandbox.id));

    const terminalName = terminal?.streamEventType ?? 'none';
    const ok =
      (conversation === 'hang'
        ? !terminal && stillConnected
        : isMessageCompleted(terminal, sent.messageId)) &&
      noPrepare &&
      sameContainers;
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
  const { config, conversation, timeoutMs = 120_000, api = 'unified' } = args;
  const coldDirective = conversation && conversation !== '_' ? conversation : 'echo:hi';
  const hotDirectives = ['echo:hot', 'slow:3:50', 'echo:followup'];
  const events: StreamEvent[] = [];

  try {
    const knownSandboxIds = await snapshotSandboxIds();
    const session = await startSession(config, { prompt: fakeDirective(coldDirective) }, api);
    const coldStream = await openConnectedStream(config, session.cloudAgentSessionId);
    const sandbox = await waitForOwnedSandbox(
      session.cloudAgentSessionId,
      knownSandboxIds,
      timeoutMs
    );
    if (!sandbox) {
      coldStream.close();
      return {
        name: 'cold-hot',
        conversation,
        ok: false,
        message: `cold turn: could not identify an exclusively owned sandbox within ${timeoutMs}ms`,
        events: [...coldStream.events],
        durationMs: Date.now() - start,
      };
    }

    const coldResult = await collectUntilTerminal(coldStream, session.messageId, timeoutMs);
    events.push(...coldResult.events);
    coldStream.close();
    if (!isMessageCompleted(coldResult.terminal, session.messageId)) {
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
      const stream = await openConnectedStream(config, session.cloudAgentSessionId, false);
      const sent = await sendMessage(
        config,
        { cloudAgentSessionId: session.cloudAgentSessionId, prompt: fakeDirective(directive) },
        api
      );

      const firstKilocodeStart = Date.now();
      const firstKilocode = await stream.waitFor(e => e.streamEventType === 'kilocode', 10_000);
      const firstKilocodeLatency = Date.now() - firstKilocodeStart;
      const hotResult = await collectUntilTerminal(stream, sent.messageId, timeoutMs);
      events.push(...hotResult.events);
      stream.close();

      const sandboxesAfter = await listSandboxContainers();
      const completed = isMessageCompleted(hotResult.terminal, sent.messageId);
      const noPrepare = !hasPreparationForMessage(hotResult.events, sent.messageId);
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
        `${directive}:${hotResult.terminal?.streamEventType ?? 'none'}/${firstKilocode ? `${firstKilocodeLatency}ms` : 'no-kilocode'}`
      );
    }

    return {
      name: 'cold-hot',
      conversation,
      ok: true,
      message: `session=${session.cloudAgentSessionId}; cold=${coldResult.terminal.streamEventType}; hot=${hotSummaries.join(', ')}`,
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

export async function lifecycleExternalKill(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 120_000, api = 'unified' } = args;
  const events: StreamEvent[] = [];
  const streams: ReturnType<typeof openStream>[] = [];
  const ownedFamilies = new Map<string, SandboxContainer>();
  let knownSandboxIds = new Set<string>();
  let sessionId: string | undefined;
  try {
    knownSandboxIds = await snapshotSandboxIds();
    const session = await startSession(config, { prompt: fakeDirective('echo:warmup') }, api);
    sessionId = session.cloudAgentSessionId;
    const firstStream = await openConnectedStream(config, sessionId);
    streams.push(firstStream);
    const firstSandbox = await waitForOwnedSandbox(sessionId, knownSandboxIds, timeoutMs);
    if (!firstSandbox) throw new Error('Could not identify an exclusively owned warmup sandbox');
    ownedFamilies.set(sandboxFamilyKey(firstSandbox), firstSandbox);
    const warmup = await collectUntilTerminal(firstStream, session.messageId, timeoutMs);
    events.push(...warmup.events);
    firstStream.close();
    if (!isMessageCompleted(warmup.terminal, session.messageId)) {
      throw new Error(`Warmup message ${session.messageId} did not complete successfully`);
    }

    const killed = await stopOwnedSandboxFamily(firstSandbox, sessionId);
    if (!killed.includes(firstSandbox.name))
      throw new Error('Fault did not kill the owned primary');
    const beforeRecovery = await snapshotSandboxIds();
    const stream = await openConnectedStream(config, sessionId, false);
    streams.push(stream);
    const affected = await sendMessage(
      config,
      { cloudAgentSessionId: sessionId, prompt: fakeDirective(conversation) },
      api
    );
    const affectedTurn = await collectUntilTerminal(stream, affected.messageId, timeoutMs);
    events.push(...affectedTurn.events);
    stream.close();
    const affectedResult = await getMessageResult(config, sessionId, affected.messageId);
    if (
      !affectedTurn.terminal ||
      affectedResult.status === 'queued' ||
      affectedResult.status === 'running' ||
      (affectedResult.status === 'completed') !==
        isMessageCompleted(affectedTurn.terminal, affected.messageId)
    ) {
      throw new Error(
        `Post-kill message ${affected.messageId} has no matching durable terminal outcome`
      );
    }

    const recovery = await sendRecoveryTurn(config, sessionId, api, timeoutMs);
    events.push(...recovery.events);
    if (
      !isMessageCompleted(recovery.terminal, recovery.messageId) ||
      recovery.status !== 'completed'
    ) {
      throw new Error(`Recovery message ${recovery.messageId} did not complete in ${sessionId}`);
    }
    const replacement = await waitForOwnedSandbox(sessionId, beforeRecovery, timeoutMs);
    if (!replacement) throw new Error('Could not identify the owned replacement sandbox');
    ownedFamilies.set(sandboxFamilyKey(replacement), replacement);
    if (
      replacement.id === firstSandbox.id ||
      (sessionId.startsWith('workspace_') &&
        sandboxFamilyKey(replacement) === sandboxFamilyKey(firstSandbox))
    ) {
      throw new Error('Recovery reused the retired physical sandbox');
    }
    return {
      name: 'external-kill',
      conversation,
      ok: true,
      message: `session=${sessionId}; affected=${affected.messageId}/${affectedResult.status}; recovery=${recovery.messageId}/completed; retired family stopped`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      name: 'external-kill',
      conversation,
      ok: false,
      message: `threw: ${err instanceof Error ? err.message : String(err)}`,
      events,
      durationMs: Date.now() - start,
    };
  } finally {
    for (const stream of streams) stream.close();
    if (sessionId) {
      await interruptSession(config, sessionId).catch(() => {});
      for (const sandbox of await findOwnedSandboxes(sessionId, knownSandboxIds)) {
        ownedFamilies.set(sandboxFamilyKey(sandbox), sandbox);
      }
      for (const sandbox of ownedFamilies.values())
        await stopOwnedSandboxFamily(sandbox, sessionId);
    }
  }
}

export async function lifecycleKillMidFlight(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 120_000, api = 'unified' } = args;
  const gateTag = `killmid-${crypto.randomUUID()}`;
  const events: StreamEvent[] = [];
  const ownedFamilies = new Map<string, SandboxContainer>();
  let knownSandboxIds = new Set<string>();
  let sessionId: string | undefined;
  let stream: ReturnType<typeof openStream> | undefined;
  try {
    knownSandboxIds = await snapshotSandboxIds();
    const session = await startSession(config, { prompt: fakeDirective(`gate:${gateTag}`) }, api);
    sessionId = session.cloudAgentSessionId;
    stream = await openConnectedStream(config, sessionId);
    const sandbox = await waitForOwnedSandbox(sessionId, knownSandboxIds, timeoutMs);
    if (!sandbox) throw new Error('Could not identify an exclusively owned active sandbox');
    ownedFamilies.set(sandboxFamilyKey(sandbox), sandbox);
    if (!(await waitForGateEngaged(config, gateTag, timeoutMs))) {
      throw new Error(`Gate ${gateTag} did not engage before fault injection`);
    }
    const accepted = await stream.waitFor(
      event =>
        event.streamEventType === 'cloud.message.sent' &&
        messageIdFromEvent(event) === session.messageId,
      timeoutMs
    );
    const active = await getMessageResult(config, sessionId, session.messageId);
    if (!accepted || active.status !== 'running')
      throw new Error(`Message ${session.messageId} is not running`);

    const killed = await stopOwnedSandboxFamily(sandbox, sessionId);
    if (!killed.includes(sandbox.name)) throw new Error('Fault did not kill the owned primary');
    const terminal = await stream.waitForTerminal(timeoutMs, session.messageId);
    events.push(...stream.events);
    stream.close();
    const affected = await getMessageResult(config, sessionId, session.messageId);
    if (
      terminal?.streamEventType !== 'cloud.message.failed' ||
      (affected.status !== 'failed' && affected.status !== 'interrupted')
    ) {
      throw new Error(`Killed message ${session.messageId} has no matching durable failure`);
    }

    const beforeRecovery = await snapshotSandboxIds();
    const recovery = await sendRecoveryTurn(config, sessionId, api, timeoutMs);
    events.push(...recovery.events);
    if (
      !isMessageCompleted(recovery.terminal, recovery.messageId) ||
      recovery.status !== 'completed'
    ) {
      throw new Error(`Recovery message ${recovery.messageId} did not complete in ${sessionId}`);
    }
    const replacement = await waitForOwnedSandbox(sessionId, beforeRecovery, timeoutMs);
    if (!replacement) throw new Error('Could not identify the owned replacement sandbox');
    ownedFamilies.set(sandboxFamilyKey(replacement), replacement);
    if (
      replacement.id === sandbox.id ||
      (sessionId.startsWith('workspace_') &&
        sandboxFamilyKey(replacement) === sandboxFamilyKey(sandbox))
    ) {
      throw new Error('Recovery reused the retired physical sandbox');
    }
    return {
      name: 'kill-mid-flight',
      conversation,
      ok: true,
      message: `session=${sessionId}; affected=${session.messageId}/${affected.status}; recovery=${recovery.messageId}/completed; retired family stopped`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      name: 'kill-mid-flight',
      conversation,
      ok: false,
      message: `threw: ${err instanceof Error ? err.message : String(err)}`,
      events: events.length ? events : [...(stream?.events ?? [])],
      durationMs: Date.now() - start,
    };
  } finally {
    stream?.close();
    await releaseGate(config.fakeLlmUrl, gateTag).catch(() => {});
    if (sessionId) {
      await interruptSession(config, sessionId).catch(() => {});
      for (const sandbox of await findOwnedSandboxes(sessionId, knownSandboxIds)) {
        ownedFamilies.set(sandboxFamilyKey(sandbox), sandbox);
      }
      for (const sandbox of ownedFamilies.values())
        await stopOwnedSandboxFamily(sandbox, sessionId);
    }
  }
}

// ---------------------------------------------------------------------------
// Queue-focused scenarios
// ---------------------------------------------------------------------------

type QueuedOrCompleted = 'queued' | 'completed' | 'failed';

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

function successfulMessageOrder(events: StreamEvent[], messageIds: string[]): boolean {
  const terminal = events.filter(event => {
    const messageId = messageIdFromEvent(event);
    return (
      messageId !== undefined &&
      messageIds.includes(messageId) &&
      (messagePhase(event) === 'completed' || messagePhase(event) === 'failed')
    );
  });
  return (
    terminal.length === messageIds.length &&
    terminal.every((event, index) => isMessageCompleted(event, messageIds[index]))
  );
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
  const gateTag = `${conversation || 'gate1'}-${crypto.randomUUID()}`;
  let cleanupSessionId: string | undefined;
  let terminalized = false;
  try {
    const knownSandboxIds = await snapshotSandboxIds();
    const gate = await startSession(config, { prompt: fakeDirective(`gate:${gateTag}`) }, api);
    cleanupSessionId = gate.cloudAgentSessionId;
    const stream = await openConnectedStream(config, gate.cloudAgentSessionId);
    const sandbox = await waitForOwnedSandbox(gate.cloudAgentSessionId, knownSandboxIds, timeoutMs);
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

    const engaged = await waitForGateEngaged(config, gateTag, 120_000);
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
      stream.close();
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: `third message ${third.messageId} did not terminate within ${timeoutMs}ms; owned container=${sandbox.id}`,
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    const events = [...stream.events];
    stream.close();

    const expectedOrder = [gate.messageId, second.messageId, third.messageId];
    const fifoOk = successfulMessageOrder(events, expectedOrder);
    terminalized = fifoOk;

    return {
      name: scenarioName,
      conversation,
      ok: fifoOk,
      message: fifoOk
        ? `session=${gate.cloudAgentSessionId}; successful FIFO: ${expectedOrder.join(' -> ')}`
        : `expected successful FIFO completion for ${expectedOrder.join(' -> ')}`,
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
      stream.close();
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: `third message ${third.messageId} did not terminate within ${timeoutMs}ms (first=${first.messageId} second=${second.messageId})`,
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    const events = [...stream.events];
    stream.close();

    const expectedOrder = [first.messageId, second.messageId, third.messageId];
    const fifoOk = successfulMessageOrder(events, expectedOrder);

    return {
      name: scenarioName,
      conversation,
      ok: fifoOk,
      message: fifoOk
        ? `session=${first.cloudAgentSessionId}; successful FIFO: ${expectedOrder.join(' -> ')}`
        : `expected successful FIFO completion for ${expectedOrder.join(' -> ')}`,
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

    const engaged = await waitForGateEngaged(config, gateTag, 120_000);
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

    const engaged = await waitForGateEngaged(config, gateTag, 120_000);
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

    const terminal = await stream.waitForTerminal(timeoutMs, session.messageId);
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

    const terminal = await stream.waitForTerminal(timeoutMs, session.messageId);
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

    const ok = isMessageCompleted(terminal, session.messageId);

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

    const terminal = await stream.waitForTerminal(timeoutMs, session.messageId);
    const events = [...stream.events];
    stream.close();

    const deltaCount = events.filter(
      e =>
        e.streamEventType === 'kilocode' &&
        (e.data as { type?: string } | undefined)?.type === 'message.part.delta'
    ).length;
    const completed = isMessageCompleted(terminal, session.messageId);

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

    const engaged = await waitForGateEngaged(config, gateTag, 120_000);
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

    const terminal = await stream.waitForTerminal(timeoutMs, session.messageId);
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
    const ok =
      isMessageCompleted(terminal, session.messageId) &&
      waiterCount === 0 &&
      snapshot.liveResponses === 0;

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
  const { config, conversation, timeoutMs = 120_000, api = 'unified' } = args;
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

    const terminal = await stream.waitForTerminal(timeoutMs, session.messageId);
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
    const ok = isMessageCompleted(terminal, session.messageId) && statusOk && messageIdOk && textOk;

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

    const engaged = await waitForGateEngaged(config, gateTag, 120_000);
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
  const { config, timeoutMs = 120_000, api = 'unified' } = args;
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

    const engaged = await waitForGateEngaged(config, gateTag, 120_000);
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

    const terminal = await stream.waitForTerminal(timeoutMs, session.messageId);
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
