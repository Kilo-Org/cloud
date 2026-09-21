/**
 * Shared load scenarios: `large-stream` and `concurrent-chats`.
 *
 * These reuse the shared runtime helpers (`createScenarioDeadline`,
 * `createOwnedSessionRegistry`, `trackCreations`, `waitForPresentAllocation`,
 * `sendTurn`, `waitForPacedProgress`, `requireRunning`) and never reproduce
 * `createScenarioResources` or shell out to Docker. Physical readiness is the
 * completion of a real boot turn plus an allocation reference observed through
 * the injected `sessionSandbox` capability.
 *
 * `large-stream` measures the staging path, not the assistant: a `file:seed`
 * write tool argument is the large payload, and the proof is the parsed
 * `file:read` echo body's UTF-8 byte count. If the write cannot be staged the
 * scenario reports `coverage=blocked` and fails, and it never substitutes large
 * assistant text.
 */

import { randomUUID } from 'node:crypto';
import {
  fakeDirective,
  fetchFakeScenarioStatus,
  getSessionSnapshot,
  isMessageCompleted,
  prepareBrowserSession,
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
  sendTurn,
  sessionSandboxObservation,
  startPacedHoldTurn,
  trackCreations,
  waitForPresentAllocation,
  type InFlightCreations,
} from './scenarios-shared-runtime.js';
import { assertReaderCannotDeriveNonce, parseFileReadEcho } from './scenario-assertions.js';
import { assertScenarioPreconditions } from './public-surface-support.js';
import type { LifecycleArgs, LifecycleResult } from './lifecycle.js';
import type { ScenarioEnvironment } from './scenario-capabilities.js';

const LARGE_STREAM_TIMEOUT_MS = 10 * 60_000;
const CONCURRENT_CHATS_TIMEOUT_MS = 15 * 60_000;

/** Seed fixture target: 64 KiB, above the read tool's 48 KiB floor. */
const LARGE_STREAM_SEED_BYTES = 64 * 1024;
/** The plan's floor for the parsed echo body, allowing for the read tool's cap. */
const LARGE_STREAM_MIN_ECHO_BYTES = 48 * 1024;
/** Budget for the seed/read turns once the sandbox is warm. */
const LARGE_STREAM_TURN_BUDGET_MS = 180_000;
const CONTAINER_BUDGET_MS = 240_000;
/** Per-turn budget once the environment is warm. */
const TURN_BUDGET_MS = 120_000;
/** The paced hold the plan prescribes for overlap. */
const CONCURRENT_HOLD_DIRECTIVE = 'slow:90:1000:16';
const CONCURRENT_PACED_BUDGET_MS = 90_000;
const CONCURRENT_SESSION_COUNT = 2;
/** Bounded wait for a create that outlived the scenario deadline. */
const LATE_CREATE_SETTLE_MS = 30_000;

/**
 * The `large-stream` seed/read pair. The path and op tags are derived from
 * `runId`, but the seed nonce (the fixture's first line, and the only part the
 * read echo can be compared against) is an independent UUID, so a reader that
 * only ever sees the path and its own tag cannot synthesize it.
 * `readerDerivedBody` is the value the pre-fix code derived from `runId`, kept
 * so the unit test can prove the assertion rejects it.
 */
export type LargeStreamSeedTurns = {
  seedPath: string;
  seedTag: string;
  readTag: string;
  seedNonce: string;
  seedDirective: string;
  readDirective: string;
  readerDerivedBody: string;
};

export function buildLargeStreamSeedTurns(runId: string): LargeStreamSeedTurns {
  const seedTag = `seed-${runId}`;
  const readTag = `read-${runId}`;
  const seedPath = `tool-stream-${runId}.txt`;
  const seedNonce = `nonce-${randomUUID()}`;
  return {
    seedPath,
    seedTag,
    readTag,
    seedNonce,
    seedDirective: `file:seed:${seedTag}:${seedPath}:${LARGE_STREAM_SEED_BYTES}:${seedNonce}`,
    readDirective: `file:read:${readTag}:${seedPath}`,
    readerDerivedBody: `nonce-${runId}`,
  };
}

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
 * `large-stream`: a `file:seed` write stages a ≥64 KiB fixture of 99-character
 * lines (so per-line handling cannot truncate a single long line), `file:read`
 * echoes it, and the parsed echo body's UTF-8 byte count is measured against the
 * 48 KiB floor; a paced follow-up completes. The proof is public on both
 * profiles and needs no checkout fixture: the write tool argument is generated
 * by the fake and executed by the real write tool. If the write cannot be
 * staged, this reports `coverage=blocked`; large assistant text is never a
 * substitute.
 */
async function runLargeStream(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = LARGE_STREAM_TIMEOUT_MS } = args;
  const scenarioName = 'large-stream';
  const sandbox = sessionSandboxObservation(env);
  const owned = createOwnedSessionRegistry(config, cleanupRemoteSession);
  const scenarioConfig = owned.config;
  const deadline = createScenarioDeadline(startedAt, timeoutMs);
  const creations = trackCreations<WorktreeSessionResult>(deadline, owned, scenarioName);
  const runId = randomUUID().slice(0, 8);
  const seedTurns = buildLargeStreamSeedTurns(runId);
  const { readTag, seedPath } = seedTurns;

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
      fakeDirective(seedTurns.seedDirective)
    );
    owned.register(session);
    // The seed boot is the staging path under test. If the large write tool
    // argument cannot be staged, this is an honest `coverage=blocked`, never a
    // weaker substitute using large assistant text.
    let boot: { messageId: string; stream: StreamConnection; text: string };
    try {
      boot = await bootToCompletion(deadline, scenarioConfig, session, 'boot');
    } catch (error) {
      return fail(`coverage=blocked; reason=seed staging failed: ${errorMessage(error)}`);
    }
    streams.push(boot.stream);
    events.push(...boot.stream.events);
    if (!boot.text.includes(`file-write:${seedPath}`)) {
      return fail(`coverage=blocked; reason=seed write not staged: ${JSON.stringify(boot.text)}`);
    }
    const allocation = await waitForPresentAllocation(
      deadline,
      sandbox,
      session,
      'boot',
      CONTAINER_BUDGET_MS
    );
    if (allocation === null) return fail('coverage=blocked; reason=no allocation after boot');

    // The seed read is the measurement. A missing or unstaged seed write fails
    // the read turn and is reported blocked, never substituted.
    let read: { messageId: string; stream: StreamConnection };
    try {
      read = await sendTurn(
        deadline,
        scenarioConfig,
        session.cloudAgentSessionId,
        fakeDirective(seedTurns.readDirective),
        'read turn',
        LARGE_STREAM_TURN_BUDGET_MS
      );
    } catch (error) {
      return fail(`coverage=blocked; reason=seed read failed: ${errorMessage(error)}`);
    }
    streams.push(read.stream);
    events.push(...read.stream.events);
    const readText = collectChildMessageText(read.stream.events, read.messageId);
    const body = parseFileReadEcho(readText, seedPath);
    const status = await deadline.within('read status', signal =>
      fetchFakeScenarioStatus(scenarioConfig.fakeLlmUrl, readTag, signal)
    );
    if (status.toolCalls.read !== 1 || status.toolResults.read !== 1) {
      return fail(
        `coverage=blocked; reason=read evidence missing: toolCalls.read=${status.toolCalls.read} toolResults.read=${status.toolResults.read}`
      );
    }
    if (body === null) {
      return fail(`coverage=blocked; reason=file:read did not echo ${seedPath}`);
    }
    assertReaderCannotDeriveNonce({
      body: body.split('\n')[0] ?? null,
      expectedNonce: seedTurns.seedNonce,
      readerVisible: seedTurns.readerDerivedBody,
      label: 'large-stream seed read',
    });
    const echoedBytes = Buffer.byteLength(body, 'utf8');
    if (echoedBytes < LARGE_STREAM_MIN_ECHO_BYTES) {
      return fail(`echoedBytes=${echoedBytes} is below the ${LARGE_STREAM_MIN_ECHO_BYTES} floor`);
    }

    const paced = await sendTurn(
      deadline,
      scenarioConfig,
      session.cloudAgentSessionId,
      fakeDirective('slow:20:50:32'),
      'paced follow-up',
      TURN_BUDGET_MS
    );
    streams.push(paced.stream);
    events.push(...paced.stream.events);

    result = {
      name: scenarioName,
      conversation,
      ok: true,
      message:
        `coverage=verified; echoedBytes=${echoedBytes} (floor=${LARGE_STREAM_MIN_ECHO_BYTES}); ` +
        `readToolCalls=1; readToolResults=1; allocation=${allocation}; ` +
        `pacedFollowUp=complete; path=${seedPath}`,
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

type HeldSession = {
  session: WorktreeSessionResult;
  boot: { messageId: string; stream: StreamConnection };
  hold?: { messageId: string; stream: StreamConnection };
};

/**
 * `concurrent-chats`: two independent sessions are booted to a ready container
 * first, then each is held by a paced `slow` turn. Both must be `running` at one
 * barrier instant, and each turn must complete (or, if a turn does not complete,
 * a same-chat follow-up must).
 */
async function runConcurrentChats(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = CONCURRENT_CHATS_TIMEOUT_MS } = args;
  const scenarioName = 'concurrent-chats';
  const sandbox = sessionSandboxObservation(env);
  const owned = createOwnedSessionRegistry(config, cleanupRemoteSession);
  const scenarioConfig = owned.config;
  const deadline = createScenarioDeadline(startedAt, timeoutMs);
  const creations = trackCreations<WorktreeSessionResult>(deadline, owned, scenarioName);
  const runId = randomUUID().slice(0, 8);
  const entries: HeldSession[] = [];
  const events: StreamEvent[] = [];
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

    // Boot both to a ready container before either hold, so the holds overlap.
    for (let index = 0; index < CONCURRENT_SESSION_COUNT; index++) {
      const label = `session ${index}`;
      const session = await prepareSession(
        creations,
        scenarioConfig,
        fakeDirective(`echo:boot-${index}-${runId}`)
      );
      owned.register(session);
      const boot = await bootToCompletion(deadline, scenarioConfig, session, `${label} boot`);
      events.push(...boot.stream.events);
      if (!echoPayloadMatches(boot.text, `boot-${index}-${runId}`)) {
        throw new Error(`${label} boot did not echo boot-${index}-${runId}`);
      }
      const allocation = await waitForPresentAllocation(
        deadline,
        sandbox,
        session,
        `${label} boot`,
        CONTAINER_BUDGET_MS
      );
      if (allocation === null) throw new Error(`${label} did not expose an allocation`);
      entries.push({ session, boot });
    }

    for (const entry of entries) {
      const label = `hold ${entry.session.cloudAgentSessionId.slice(0, 18)}`;
      const hold = await startPacedHoldTurn({
        deadline,
        config: scenarioConfig,
        cloudAgentSessionId: entry.session.cloudAgentSessionId,
        directive: CONCURRENT_HOLD_DIRECTIVE,
        label,
        budgetMs: CONCURRENT_PACED_BUDGET_MS,
      });
      entry.hold = { messageId: hold.messageId, stream: hold.stream };
    }

    const snapshots = await Promise.all(
      entries.map(entry =>
        deadline.within('barrier snapshot', signal =>
          getSessionSnapshot(scenarioConfig, entry.session.cloudAgentSessionId, signal)
        )
      )
    );
    const overlap = snapshots.map(snapshot => snapshot.execution?.status ?? 'none').join(',');
    if (!snapshots.every(snapshot => snapshot.execution?.status === 'running')) {
      throw new Error(`both sessions not running at the barrier instant; statuses=${overlap}`);
    }

    const outcomes: string[] = [];
    for (const entry of entries) {
      const hold = entry.hold;
      if (!hold) throw new Error('hold was not started');
      let completed = false;
      try {
        const terminal = await hold.stream.waitForTerminal(
          Math.max(1, Math.min(TURN_BUDGET_MS, deadline.remaining('hold terminal'))),
          hold.messageId
        );
        completed = isMessageCompleted(terminal, hold.messageId);
      } catch {
        completed = false;
      }
      if (completed) {
        events.push(...hold.stream.events);
        outcomes.push(`${entry.session.cloudAgentSessionId.slice(0, 18)}=completed`);
        continue;
      }
      // A same-chat follow-up is the plan's recovery route for a hold that did
      // not complete.
      const recovery = await sendTurn(
        deadline,
        scenarioConfig,
        entry.session.cloudAgentSessionId,
        fakeDirective(`echo:recover-${runId}`),
        'recovery turn',
        TURN_BUDGET_MS
      );
      events.push(...recovery.stream.events);
      outcomes.push(`${entry.session.cloudAgentSessionId.slice(0, 18)}=completed-after-recovery`);
    }

    result = {
      name: scenarioName,
      conversation,
      ok: true,
      message:
        `sessions=${entries.length}; overlap=barrier;statuses=${overlap}; ` +
        `outcomes=${outcomes.join(' | ')}`,
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    result = fail(errorMessage(error));
  } finally {
    for (const entry of entries) {
      if (entry.hold) events.push(...entry.hold.stream.events);
      for (const stream of [entry.boot.stream, entry.hold?.stream]) {
        try {
          stream?.close();
        } catch {
          /* ignore */
        }
      }
    }
    for (const late of await creations.settleAll(LATE_CREATE_SETTLE_MS)) {
      owned.register(late);
    }
    await owned.cleanup(scenarioName);
  }
  return result;
}

export const LOAD_SHARED_SCENARIOS: Record<string, SharedScenario> = {
  'large-stream': {
    name: 'large-stream',
    requires: ['sessionSandbox'],
    defaultApi: 'unified',
    defaultConversation: '_',
    defaultTimeoutMs: LARGE_STREAM_TIMEOUT_MS,
    requiresWorktreeCreation: true,
    run: runLargeStream,
  },
  'concurrent-chats': {
    name: 'concurrent-chats',
    requires: ['sessionSandbox'],
    defaultApi: 'unified',
    defaultConversation: '_',
    defaultTimeoutMs: CONCURRENT_CHATS_TIMEOUT_MS,
    requiresWorktreeCreation: true,
    run: runConcurrentChats,
  },
};
