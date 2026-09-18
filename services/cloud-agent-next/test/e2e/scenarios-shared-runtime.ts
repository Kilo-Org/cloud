/**
 * Shared scenario mechanics: the scenario deadline, the container-observation
 * seam and the send/terminal/durable turn lifecycle.
 *
 * This module imports only `client.ts` and `scenario-capabilities.ts` types, so a
 * shared scenario module can use it without importing a local-only inspection
 * module, and it performs no Docker, filesystem, process, log or database I/O.
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
  getMessageResult,
  openConnectedStream,
  sendMessage,
  type DriverConfig,
  type StreamConnection,
  type StreamEvent,
} from './client.js';
import type { ScenarioEnvironment, SessionSandboxObservation } from './scenario-capabilities.js';

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
   * Only `startSession` invokes that hook. `prepareBrowserSession` and
   * `createWorktreeChat` never do, so a runner that uses either must call
   * `register()` with the returned session immediately after the create
   * resolves, before any assertion; dropping it leaks the worktree session.
   */
  config: DriverConfig;
  /** Record a create result's ids. Repeated ids keep their first registration. */
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
      owned.set(session.cloudAgentSessionId, session.kiloSessionId);
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
  timeoutMs: number
): Promise<string | null> {
  if (sandbox === undefined) return null;
  return sandbox.waitForContainer({
    cloudAgentSessionId: session.cloudAgentSessionId,
    kiloSessionId: session.kiloSessionId,
    timeoutMs,
  });
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
  return deadline.within(`${label} allocation`, () =>
    sandbox.currentContainer({
      cloudAgentSessionId: session.cloudAgentSessionId,
      kiloSessionId: session.kiloSessionId,
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
    () =>
      sandbox.waitForContainer({
        cloudAgentSessionId: session.cloudAgentSessionId,
        kiloSessionId: session.kiloSessionId,
        timeoutMs: budget,
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
