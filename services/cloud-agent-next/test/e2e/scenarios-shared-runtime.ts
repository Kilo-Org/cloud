/**
 * Shared scenario mechanics: the scenario deadline, the container-observation
 * seam and the send/terminal/durable turn lifecycle.
 *
 * This module imports `client.ts`, `scenario-capabilities.ts` types and the
 * correlated-progress predicates from `scenarios-shared.ts`, and it performs no
 * Docker, filesystem, process, log or database I/O.
 *
 * `within` rejects the await when its budget expires and aborts the signal it
 * passes to the operation. It cancels an operation only where that operation
 * forwards the signal to its transport. The tRPC reads (`getMessageResult`),
 * `sendMessage` and `openConnectedStream` do; the injected `sessionSandbox`
 * capability and the stream waits (`waitForTerminal`) do not, so for those
 * `within` only rejects the await and the operation still runs to its own
 * timeout.
 */

import {
  fakeDirective,
  fetchFakeRequests,
  getMessageResult,
  getSessionSnapshot,
  isMessageCompleted,
  openConnectedStream,
  sendMessage,
  type ApiVersion,
  type DriverConfig,
  type StreamConnection,
  type StreamEvent,
} from './client.js';
import type { ScenarioEnvironment, SessionSandboxObservation } from './scenario-capabilities.js';
import {
  collectChildMessageText,
  correlatedProgressSummary,
  hasCorrelatedStreamProgress,
} from './scenarios-shared.js';

/**
 * Bound for the durable-status poll. A single read can race the DO's terminal
 * write, so the poll is allowed a short window; the cap keeps it from stretching
 * a scenario's own budget.
 */
const DURABLE_BUDGET_MS = 15_000;

/**
 * Slack over the capability's own timeout for the enclosing deadline backstop.
 * The capability's `timeoutMs` is what returns `null`; without slack the
 * backstop timer can fire first and report a scenario-deadline error instead of
 * the caller's "no reference" hard failure.
 */
const ALLOCATION_WAIT_SLACK_MS = 1_000;

/**
 * Attempt cap for recovering an observed post-open stream drop while booting.
 * The boot budget is the other bound; the cap keeps a session whose socket
 * drops repeatedly from reconnecting without limit.
 */
const MAX_BOOT_RECONNECTS = 5;

export type ScenarioDeadline = {
  /** Absolute epoch milliseconds at which the scenario budget expires. */
  deadlineAt: number;
  /** Remaining budget; throws once the deadline has passed. */
  remaining(label: string): number;
  /**
   * Run one operation under the remaining budget. `budgetMs`, when given, is a
   * stricter cap on this operation (not a behaviour switch); it never extends
   * the scenario deadline.
   */
  within<T>(
    label: string,
    operation: (signal: AbortSignal) => Promise<T>,
    budgetMs?: number
  ): Promise<T>;
};

/**
 * Create the one deadline for a scenario run. `within` recomputes the remaining
 * budget at call time, so a budget captured before one step is never reused for
 * a later step.
 */
export function createScenarioDeadline(startedAt: number, timeoutMs: number): ScenarioDeadline {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`invalid scenario timeout: ${timeoutMs}`);
  }
  const deadlineAt = startedAt + timeoutMs;

  const remaining = (label: string): number => {
    const left = deadlineAt - Date.now();
    if (left <= 0) throw new Error(`scenario deadline exceeded before ${label}`);
    return left;
  };

  const within: ScenarioDeadline['within'] = async (label, operation, budgetMs) => {
    const left = remaining(label);
    const budget = budgetMs === undefined ? left : Math.min(left, budgetMs);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error(`scenario deadline exceeded during ${label}`));
        reject(new Error(`scenario deadline exceeded during ${label}`));
      }, budget);
    });
    try {
      return await Promise.race([operation(controller.signal), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  return { deadlineAt, remaining, within };
}

export type OwnedSession = { cloudAgentSessionId: string; kiloSessionId?: string };

/**
 * Bind the session id as soon as the start reports it. The legacy two-step
 * `prepareSession` path reports the prepared id through `config.onSessionCreated`
 * before initiation, so a failure between prepare and initiation still reaches
 * the caller's failure-path cleanup instead of leaking the prepared session. A
 * unified start reports it on success. Forwards to any runner-supplied hook so
 * ownership tracking is kept.
 */
export function trackStartedSession(
  config: DriverConfig,
  onTracked: (sessionId: string) => void
): DriverConfig {
  return {
    ...config,
    onSessionCreated: sessionId => {
      onTracked(sessionId);
      config.onSessionCreated?.(sessionId);
    },
  };
}

/** The scenario's cleanup path: interrupt + delete, bounded and never throwing. */
export type SessionCleanup = (
  config: DriverConfig,
  sessionId: string,
  label: string,
  kiloSessionId?: string
) => Promise<void>;

export type OwnedSessionRegistry = {
  /**
   * The composed config for create calls. Its `onSessionCreated` records the id
   * before delegating to any pre-existing handler, so a create that registers a
   * session and then throws still leaves the id owned by this scenario.
   *
   * `startSession` invokes that hook, and so do `prepareBrowserSession` and
   * `createWorktreeChat` on success. An id from either create helper is
   * therefore owned even if a later assertion throws; the caller still calls
   * `register()` to attach the `kiloSessionId` (a repeat registration only fills
   * an undefined `kiloSessionId`).
   */
  config: DriverConfig;
  /**
   * Record a create result's ids. A first registration stores them; a repeat
   * only fills in a `kiloSessionId` that is still `undefined` (the id
   * `onSessionCreated` recorded during start), and never replaces one that is
   * already defined.
   */
  register(session: OwnedSession): void;
  /**
   * Every owned session, newest first, so a dependent session is cleaned up
   * before the session it was created from.
   */
  entries(): Array<{ sessionId: string; kiloSessionId: string | undefined }>;
  /** Clean every owned session once, newest first. Never throws. */
  cleanup(label: string): Promise<void>;
  /** Clean one late create's session once, through the same never-twice set. */
  cleanupLate(session: OwnedSession, label: string): Promise<void>;
};

/**
 * One owner for "which sessions must be cleaned up, in what order, and at most
 * once". Creation order is registration order; `entries()` reverses it so a
 * sibling is released before its root. The final pass (`cleanup`) and the
 * late-create handler (`cleanupLate`) share one `cleaned` set, so an id cleaned
 * by either is never cleaned again: a create that settles after the final pass
 * is still released, and an id returned by two creates is deleted once.
 */
export function createOwnedSessionRegistry(
  config: DriverConfig,
  cleanup: SessionCleanup
): OwnedSessionRegistry {
  const owned = new Map<string, string | undefined>();
  const cleaned = new Set<string>();
  const listEntries = (): Array<{ sessionId: string; kiloSessionId: string | undefined }> =>
    [...owned.entries()]
      .reverse()
      .map(([sessionId, kiloSessionId]) => ({ sessionId, kiloSessionId }));

  const cleanOnce = async (
    sessionId: string,
    kiloSessionId: string | undefined,
    label: string
  ): Promise<void> => {
    if (cleaned.has(sessionId)) return;
    // Add before awaiting, so two concurrent paths for one id cannot both clean.
    cleaned.add(sessionId);
    try {
      await cleanup(config, sessionId, label, kiloSessionId);
    } catch {
      // The injected cleanup is already bounded and never throws; this keeps a
      // future cleaner from surfacing as an unhandled rejection.
    }
  };

  const composed: DriverConfig = {
    ...config,
    onSessionCreated: id => {
      if (!owned.has(id)) owned.set(id, undefined);
      config.onSessionCreated?.(id);
    },
  };
  return {
    config: composed,
    register: session => {
      // `get` returns `undefined` both for an absent id and for the placeholder
      // `onSessionCreated` writes during start, so this upgrades that placeholder
      // to the real `kiloSessionId` without clobbering an already-known one.
      if (owned.get(session.cloudAgentSessionId) === undefined) {
        owned.set(session.cloudAgentSessionId, session.kiloSessionId);
      }
    },
    entries: listEntries,
    cleanup: async label => {
      for (const entry of listEntries()) {
        await cleanOnce(entry.sessionId, entry.kiloSessionId, label);
      }
    },
    cleanupLate: (session, label) =>
      cleanOnce(session.cloudAgentSessionId, session.kiloSessionId, label),
  };
}

export type InFlightCreations<T> = {
  /**
   * Track a create promise that already exists. Use this when the create does
   * not accept a cancellation signal, so the promise is tracked even if the
   * deadline race never starts it.
   */
  track(promise: Promise<T>): Promise<T>;
  /**
   * Run a create under the scenario deadline with the deadline signal. The
   * promise is tracked as soon as it is created.
   */
  run(label: string, operation: (signal: AbortSignal) => Promise<T>, budgetMs?: number): Promise<T>;
  /**
   * Await every still-pending create for at most `timeoutMs`, ignoring
   * rejections, and return the ones that resolved. The caller registers their
   * ids before its cleanup pass. A create still pending at the timeout keeps a
   * late handler: when it later resolves, its id is released through the
   * registry's `cleanupLate`; if it later rejects, the registry's deduplicated
   * cleanup releases any id it registered before rejecting. Both paths are
   * bounded and never throw, so a create that outlives the grace cannot leak.
   */
  settleAll(timeoutMs: number): Promise<T[]>;
};

/**
 * Track the creates a scenario starts, so a create that outlives the scenario
 * deadline is still settled and cleaned up rather than left running. A create is
 * never awaited past `settleAll`'s grace; instead the registry releases its id
 * when it eventually settles, so the scenario's own result is unaffected.
 */
export function trackCreations<T extends OwnedSession>(
  deadline: ScenarioDeadline,
  owned: OwnedSessionRegistry,
  scenarioLabel: string
): InFlightCreations<T> {
  const inFlight = new Set<Promise<T>>();
  const remember = (promise: Promise<T>): Promise<T> => {
    inFlight.add(promise);
    const forget = (): void => {
      inFlight.delete(promise);
    };
    void promise.then(forget, forget);
    return promise;
  };
  const attachLate = (promise: Promise<T>): void => {
    void promise.then(
      value => {
        void owned.cleanupLate(value, scenarioLabel).catch(() => {
          // `cleanupLate` never throws; keep a late release from becoming an
          // unhandled rejection that could mask the scenario's own result.
        });
      },
      () => {
        // `client.ts` invokes the composed `onSessionCreated` before its
        // wrong-plane assertion, so a create can register an id and then reject.
        // Release everything registered but not yet cleaned; no registration
        // means the deduplicated cleanup has nothing to do.
        void owned.cleanup(scenarioLabel).catch(() => {
          /* ignore */
        });
      }
    );
  };
  return {
    track: remember,
    run: (label, operation, budgetMs) =>
      deadline.within(label, signal => remember(operation(signal)), budgetMs),
    settleAll: async timeoutMs => {
      const settled: T[] = [];
      for (const promise of [...inFlight]) {
        const outcome = await settleWithin(promise, timeoutMs);
        if (outcome.ok) settled.push(outcome.value);
        else attachLate(promise);
        inFlight.delete(promise);
      }
      return settled;
    },
  };
}

/** Await a promise's settlement for at most `timeoutMs`; never throws. */
async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('settle timeout')), Math.max(1, timeoutMs));
  });
  try {
    return { ok: true, value: await Promise.race([promise, timeout]) };
  } catch {
    return { ok: false };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Resolve the `sessionSandbox` capability, or fail clearly when it is absent. */
export function sessionSandboxObservation(env: ScenarioEnvironment): SessionSandboxObservation {
  if (!env.sessionSandbox) throw new Error('sessionSandbox capability is required');
  return env.sessionSandbox;
}

/**
 * Wait for the physical container behind `session`. An absent capability
 * (`undefined`) yields `null`, so a caller that observes identity only where the
 * capability exists stays honest; a present capability is delegated to as-is.
 */
export async function requireContainer(
  sandbox: SessionSandboxObservation | undefined,
  session: { cloudAgentSessionId: string; kiloSessionId: string },
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string | null> {
  if (sandbox === undefined) return null;
  return sandbox.waitForContainer({
    cloudAgentSessionId: session.cloudAgentSessionId,
    kiloSessionId: session.kiloSessionId,
    timeoutMs,
    signal,
  });
}

/**
 * Fold one stream's buffered events into the scenario's diagnostic list exactly
 * once, then close it. Returns `undefined` so the caller can clear its hold with
 * `stream = foldStream(events, stream)`: a failure path that reads the caller's
 * stream variable then adds only streams that were opened but not yet folded,
 * never a stream already folded. Closing before clearing mirrors `runColdHot`;
 * `close()` is idempotent, so a caller's `finally` sweep stays valid.
 */
export function foldStream(events: StreamEvent[], stream: StreamConnection | undefined): undefined {
  if (!stream) return undefined;
  events.push(...stream.events);
  stream.close();
  return undefined;
}

/**
 * Read the session's current allocation reference under the scenario deadline.
 * The `sessionSandbox` capability is not signal-aware, so `within` bounds the
 * await only; `null` means the surface reported no reference, never a release.
 * Use this only where a `null` result is itself the observation (the unattended
 * idle sampling); callers that need a present reference must use
 * `waitForPresentAllocation`, which tolerates a transient miss.
 */
export async function readAllocation(
  deadline: ScenarioDeadline,
  sandbox: SessionSandboxObservation,
  session: { cloudAgentSessionId: string; kiloSessionId: string },
  label: string
): Promise<string | null> {
  return deadline.within(`${label} allocation`, signal =>
    sandbox.currentContainer({
      cloudAgentSessionId: session.cloudAgentSessionId,
      kiloSessionId: session.kiloSessionId,
      signal,
    })
  );
}

/**
 * Acquire a present allocation reference through the capability's bounded wait
 * (`waitForContainer`), under the scenario deadline. Unlike `readAllocation`,
 * `null` is not an observation here: the caller requires a present reference,
 * and a transient miss is retried within `budgetMs` instead of failing the
 * scenario immediately. `null` is returned only when the budget expires without
 * a reference; the caller hard-fails on it.
 */
export async function waitForPresentAllocation(
  deadline: ScenarioDeadline,
  sandbox: SessionSandboxObservation,
  session: { cloudAgentSessionId: string; kiloSessionId: string },
  label: string,
  budgetMs: number
): Promise<string | null> {
  const tag = `${label} allocation`;
  const budget = Math.max(1, Math.min(budgetMs, deadline.remaining(tag)));
  return deadline.within(
    tag,
    signal =>
      sandbox.waitForContainer({
        cloudAgentSessionId: session.cloudAgentSessionId,
        kiloSessionId: session.kiloSessionId,
        timeoutMs: budget,
        signal,
      }),
    budget + ALLOCATION_WAIT_SLACK_MS
  );
}

/**
 * Poll the durable message status until it is terminal or the budget elapses.
 * The wait is capped at `DURABLE_BUDGET_MS` even when the caller's budget is
 * larger, because this is a completion confirmation rather than a turn wait.
 */
export async function awaitDurableTerminal(
  config: DriverConfig,
  sessionId: string,
  messageId: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  const deadline = Date.now() + Math.max(1, Math.min(DURABLE_BUDGET_MS, timeoutMs));
  let status = 'unknown';
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason ?? new Error('durable read aborted');
    status = (await getMessageResult(config, sessionId, messageId, signal)).status;
    if (status === 'completed' || status === 'failed' || status === 'interrupted') return status;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return status;
}

/**
 * Send one prompt on an existing session and require a terminal stream event
 * plus a durable `completed`. `turnBudgetMs`, when given, is one absolute
 * cumulative budget shared by every phase of this turn: the turn deadline is
 * fixed at entry and each phase takes `min(scenarioRemaining, turnDeadlineAt -
 * now)`, so no phase can spend the full budget again. Once that deadline has
 * passed the next phase throws instead of receiving a fresh allowance; the
 * stream is closed on every failure path, and the caller owns it on success.
 * With no argument every phase is bounded by the scenario deadline alone.
 *
 * It deliberately does not assert the ordered lifecycle: a caller that needs
 * that wraps `sendTurn` and closes the returned stream when its own assertion
 * throws.
 */
export async function sendTurn(
  deadline: ScenarioDeadline,
  config: DriverConfig,
  sessionId: string,
  prompt: string,
  label: string,
  turnBudgetMs?: number
): Promise<{ messageId: string; terminal: StreamEvent; stream: StreamConnection }> {
  const turnDeadlineAt = turnBudgetMs === undefined ? null : Date.now() + turnBudgetMs;
  const phaseBudget = (phase: string): number => {
    const scenarioLeft = deadline.remaining(`${label} ${phase}`);
    if (turnDeadlineAt === null) return scenarioLeft;
    const turnLeft = turnDeadlineAt - Date.now();
    if (turnLeft <= 0) {
      throw new Error(`${label}: turn budget ${turnBudgetMs ?? 0}ms exhausted before ${phase}`);
    }
    return Math.min(scenarioLeft, turnLeft);
  };
  const stream = await deadline.within(
    `${label} stream`,
    signal => openConnectedStream(config, sessionId, false, undefined, signal),
    phaseBudget('stream')
  );
  try {
    const sent = await deadline.within(
      `${label} send`,
      signal => sendMessage(config, { cloudAgentSessionId: sessionId, prompt, signal }, 'unified'),
      phaseBudget('send')
    );
    const terminal = await stream.waitForTerminal(phaseBudget('terminal'), sent.messageId);
    if (!terminal) {
      throw new Error(`${label} did not reach a terminal stream event`);
    }
    const status = await deadline.within(
      `${label} durable status`,
      signal =>
        awaitDurableTerminal(config, sessionId, sent.messageId, phaseBudget('durable'), signal),
      phaseBudget('durable')
    );
    if (status !== 'completed') {
      throw new Error(
        `${label} durable status=${status} (stream=${terminal.streamEventType} for ${sent.messageId})`
      );
    }
    return { messageId: sent.messageId, terminal, stream };
  } catch (error) {
    stream.close();
    throw error;
  }
}

/**
 * Boot a prepared session to a completed initial turn and return its stream,
 * message id and child text. A completed real turn is the readiness proof. The
 * stream is acquired here and closed on every failure path; the caller owns it
 * on success.
 */
export async function bootToCompletion(
  deadline: ScenarioDeadline,
  config: DriverConfig,
  session: OwnedSession,
  label: string,
  budgetMs = 240_000
): Promise<{ messageId: string; stream: StreamConnection; text: string }> {
  const snapshot = await deadline.within(`${label} snapshot`, signal =>
    getSessionSnapshot(config, session.cloudAgentSessionId, signal)
  );
  const messageId = snapshot.initialMessageId;
  if (!messageId) throw new Error(`${label} did not expose an initial message id`);
  const stream = await deadline.within(`${label} stream`, signal =>
    openConnectedStream(config, session.cloudAgentSessionId, true, undefined, signal)
  );
  try {
    const terminal = await stream.waitForTerminal(
      Math.max(1, Math.min(budgetMs, deadline.remaining(`${label} terminal`))),
      messageId
    );
    if (!isMessageCompleted(terminal, messageId)) {
      throw new Error(`${label} boot turn ${messageId} did not complete`);
    }
    const status = await deadline.within(`${label} durable`, signal =>
      awaitDurableTerminal(
        config,
        session.cloudAgentSessionId,
        messageId,
        deadline.remaining(`${label} durable`),
        signal
      )
    );
    if (status !== 'completed') throw new Error(`${label} boot durable status=${status}`);
    return { messageId, stream, text: collectChildMessageText(stream.events, messageId) };
  } catch (error) {
    // This stream was acquired here, so this function owns closing it. The
    // caller never receives it to close on a failure path.
    stream.close();
    throw error;
  }
}

/**
 * Recover a boot turn from an observed post-open stream drop.
 *
 * `waitForTerminal` resolves `null` both on a genuine timeout and when the
 * socket finalizes, so the caller cannot otherwise tell a dropped transport from
 * a slow turn. This helper waits for the terminal within one absolute boot
 * budget, and when the socket has actually finalized (`isOpen === false`) it
 * reconnects with replay, bounded by that same budget and
 * `MAX_BOOT_RECONNECTS`; any observed close on a finalized socket triggers that
 * path, and the close code/reason is attached when one was observed. A healthy
 * socket that reaches the timeout is reported as a missing terminal and is never
 * reconnected. Only a failure to establish a replacement stream aborts recovery:
 * the error is rethrown with the accumulated close evidence attached, never
 * retried and never swallowed.
 */
export async function waitForBootTerminal(input: {
  deadline: ScenarioDeadline;
  config: DriverConfig;
  sessionId: string;
  messageId: string;
  stream: StreamConnection;
  budgetMs: number;
  label: string;
}): Promise<{ terminal: StreamEvent | null; stream: StreamConnection; transport: string }> {
  const { deadline, config, sessionId, messageId, budgetMs, label } = input;
  const bootDeadlineAt = Date.now() + Math.max(1, Math.min(budgetMs, deadline.remaining(label)));
  let stream = input.stream;
  let attempts = 0;
  let transport = '';

  while (Date.now() < bootDeadlineAt) {
    const terminal = await stream.waitForTerminal(bootDeadlineAt - Date.now(), messageId);
    if (terminal !== null) return { terminal, stream, transport };
    if (stream.isOpen) {
      // A live socket that reached the budget is a genuine missing terminal, not
      // a transport loss: report it without reconnecting.
      return { terminal: null, stream, transport };
    }
    transport = appendClose(transport, stream.closeInfo);
    if (Date.now() >= bootDeadlineAt || attempts >= MAX_BOOT_RECONNECTS) break;
    const remaining = bootDeadlineAt - Date.now();
    if (remaining <= 0) break;
    attempts += 1;
    try {
      stream = await deadline.within(
        `${label} reconnect`,
        signal => openConnectedStream(config, sessionId, true, undefined, signal),
        remaining
      );
    } catch (error) {
      throw attachTransport(error, transport);
    }
  }
  return { terminal: null, stream, transport };
}

/** Append one observed close to the accumulated transport evidence. */
function appendClose(transport: string, closeInfo: StreamConnection['closeInfo']): string {
  const described =
    closeInfo === null
      ? 'stream closed without a close frame'
      : `stream closed code=${closeInfo.code} reason=${closeInfo.reason || 'none'}`;
  return transport === '' ? described : `${transport}; ${described}`;
}

/**
 * Attach the accumulated close evidence to a reconnect failure and return it for
 * immediate rethrow. The original error object is kept so its identity and
 * message survive; the failure is not classified and no retry follows.
 */
function attachTransport(error: unknown, transport: string): unknown {
  if (error instanceof Error) {
    error.message = `${error.message}; transport: ${transport}`;
    return error;
  }
  return new Error(`${String(error)}; transport: ${transport}`);
}

/**
 * Start a paced `slow` hold and return once the turn is actually running. The
 * pre-send fake counter baseline, the send, the correlated-progress wait and the
 * durable-running check have one owner here so queue, callbacks, load and faults
 * cannot drift. Pass `stream` to reuse a connected stream; otherwise a fresh one
 * is opened and returned. A stream opened here is closed on every failure path;
 * a caller-supplied stream stays caller-owned.
 */
export async function startPacedHoldTurn(input: {
  deadline: ScenarioDeadline;
  config: DriverConfig;
  cloudAgentSessionId: string;
  directive: string;
  label: string;
  budgetMs: number;
  api?: ApiVersion;
  stream?: StreamConnection;
}): Promise<{ messageId: string; stream: StreamConnection }> {
  const { deadline, config, cloudAgentSessionId, directive, label, budgetMs } = input;
  const api = input.api ?? 'unified';
  const stream =
    input.stream ??
    (await deadline.within(`${label} stream`, signal =>
      openConnectedStream(config, cloudAgentSessionId, false, undefined, signal)
    ));
  try {
    const baseline = await deadline.within(`${label} baseline`, signal =>
      fetchFakeRequests(config.fakeLlmUrl, signal)
    );
    const sent = await deadline.within(
      `${label} send`,
      signal =>
        sendMessage(config, { cloudAgentSessionId, prompt: fakeDirective(directive), signal }, api),
      budgetMs
    );
    await waitForPacedProgress(
      config,
      stream,
      sent.messageId,
      baseline.chatCompletions,
      deadline,
      budgetMs,
      `${label} paced progress`
    );
    await requireRunning(
      config,
      cloudAgentSessionId,
      sent.messageId,
      deadline,
      `${label} paced turn`
    );
    return { messageId: sent.messageId, stream };
  } catch (error) {
    // Only close a stream this call opened; a caller-supplied stream is the
    // caller's to close on its own failure path.
    if (input.stream === undefined) stream.close();
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
} /**
 * Wait until the paced turn is underway: the paced turn's own stream shows a
 * message-correlated part (liveness; transient and empty initialization parts
 * permitted), **and** the fake's aggregate `chatCompletions` counter has
 * increased since the paced send. The counter is **not** authoritative: it is
 * attributed to the paced request under the documented assumption that no
 * auxiliary/title request is in flight in that window, so a bounded increase
 * proves "some request was dialed", not that it was the paced primary request.
 *
 * A content-based predicate was tried first and reverted. Requiring a
 * correlated **non-empty text** part looked like a model-served signal, but the
 * Kilo CLI's transient initialization part is correlated and empty, and for a
 * paced response the streamed content can lag the request past the wait budget.
 * Live evidence: one run showed `children=1 parts=9 correlated=2 text=1
 * nonEmptyText=0` while the fake had already served the paced request, so the
 * content predicate never fired and the counter check was never consulted.
 *
 * The wait is a bounded poll: each counter fetch is wrapped in `deadline.within`
 * and each sleep is capped by the remaining wait budget. The correlated-part
 * check reads the in-memory event buffer synchronously, so it cannot observe
 * anything after the loop guard; a counter result observed only after the budget
 * expires is rejected (`Date.now() <= end` before returning).
 */
export async function waitForPacedProgress(
  config: DriverConfig,
  stream: StreamConnection,
  parentMessageId: string,
  requestsBefore: number,
  deadline: ScenarioDeadline,
  budgetMs: number,
  label: string
): Promise<void> {
  const budget = Math.min(budgetMs, deadline.remaining(label));
  const end = Date.now() + budget;
  while (Date.now() < end) {
    if (hasCorrelatedStreamProgress(stream.events, parentMessageId)) {
      const current = await deadline.within(
        `${label} poll`,
        signal => fetchFakeRequests(config.fakeLlmUrl, signal),
        Math.max(1, end - Date.now())
      );
      if (current.chatCompletions > requestsBefore) {
        if (Date.now() <= end) return;
        break;
      }
    }
    await sleep(Math.min(200, Math.max(0, end - Date.now())));
  }
  throw new Error(
    `${label}: no correlated turn progress and new model request for ${parentMessageId} ` +
      `within ${budget}ms (${correlatedProgressSummary(stream.events, parentMessageId)})`
  );
}

/**
 * Require the held turn is actually `running`, not still `queued`: a slow
 * directive proves the turn is live only once the wrapper has accepted and
 * started it, and every action the caller takes next assumes an active turn.
 */
export async function requireRunning(
  config: DriverConfig,
  sessionId: string,
  messageId: string,
  deadline: ScenarioDeadline,
  label: string
): Promise<void> {
  const result = await deadline.within(`${label} status`, signal =>
    getMessageResult(config, sessionId, messageId, signal)
  );
  if (result.status !== 'running') {
    throw new Error(`${label}: ${messageId} status=${result.status}; expected running`);
  }
}
