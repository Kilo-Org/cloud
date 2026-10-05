import { classifyAssistantFailure } from '../../../src/shared/assistant-failure.js';
import {
  CONTROL_PLANE_WRAPPER_FINALIZING_EVENT,
  controlPlaneFailureReasonSchema,
  type ControlPlaneAnswerReply,
  type ControlPlaneOutcome,
  type ControlPlanePromptPayload,
  type ControlPlaneRouteSpec,
  type ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';
import type { ControlDiagnosticReporter } from '../../../src/shared/control-diagnostics.js';
import type { ControlPlaneTimers } from '../../../src/shared/control-plane-timers.js';
import { slashCommandCatalogStatus } from '../../../src/shared/slash-commands.js';
import { runAutoCommit } from '../auto-commit.js';
import {
  DEFAULT_CONDENSE_TIMEOUT_MS,
  summarizeWithTimeout,
  type CondenseResult,
} from '../condense-on-complete.js';
import { childFromSessionCreated, eventKiloSessionId } from '../control/feed.js';
import type { KiloFeedEvent } from '../control/worktree-feed.js';
import { isKiloServerUnreachableError, type WrapperKiloClient } from '../kilo-api.js';
import { materializeMessageAttachments } from '../session-bootstrap.js';
import { captureWorktreeState, logWorktreeState } from '../worktree-state.js';
import { WORKTREE_STATE_CAPTURE_BUDGET_MS } from '../../../src/shared/worktree-state.js';
import {
  isWorktreeStateDeletionInProgress,
  worktreeStateEndpointFor,
} from './worktree-state-endpoints.js';
import type { KiloRestartReason } from './kilo-runtime.js';
import { runtimeKey } from './prepare.js';

const SYNTHETIC_KILO_EVENTS = new Set(['server.connected', 'server.heartbeat']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type TurnTimers = ControlPlaneTimers['wrapper'];

/** Structural view of the parts of `KiloRuntime` a turn needs. */
export type TurnKiloRuntime = {
  readonly directory: string;
  readonly env: Record<string, string>;
  readonly client: WrapperKiloClient;
  ensure(): Promise<WrapperKiloClient>;
  isSuspected(): boolean;
  isRestarting(): boolean;
  isUnavailable(): boolean;
  isRetiredClient(client: WrapperKiloClient): boolean;
  applyPendingCredentials?(canRestart: () => boolean): Promise<boolean>;
};

export type TurnScheduler = {
  setInterval: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (handle: ReturnType<typeof setInterval>) => void;
  setTimeout: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
};

export type TurnManagerDeps = {
  timers: ControlPlaneTimers;
  emit: (frame: ControlPlaneWrapperFrame) => void;
  runtimes: { get(key: string): TurnKiloRuntime | undefined };
  log?: (message: string) => void;
  onDiagnostic?: ControlDiagnosticReporter;
  /** The one native projector, for the normal `session_outcome` transition. */
  onNativeDiagnostic?: ControlDiagnosticReporter;
  now?: () => number;
  scheduler?: TurnScheduler;
  materializeAttachments?: typeof materializeMessageAttachments;
  runAutoCommit?: typeof runAutoCommit;
  captureWorktreeState?: typeof captureWorktreeState;
  runCondense?: (input: {
    kiloClient: WrapperKiloClient;
    kiloSessionId: string;
    directory: string;
    model: string;
    signal?: AbortSignal;
  }) => Promise<CondenseResult>;
};

export type TurnPhase = 'busy' | 'finalizing';

type MaterializedPrompt = Awaited<ReturnType<typeof materializeMessageAttachments>>;
type PendingPrompt = {
  payload: ControlPlanePromptPayload;
  message?: Promise<MaterializedPrompt>;
  /** The prompt, compact or command call has been made to Kilo. */
  dispatched?: boolean;
};

export type Turn = {
  route: TurnRoute;
  phase: TurnPhase;
  assistantMessageId?: string;
  /** Prompts received but not yet submitted because Kilo is restarting/suspected. */
  inbox: PendingPrompt[];
  /** Prompts received in this batch, kept (with their materialized message) until the outcome. */
  prompts: PendingPrompt[];
  /**
   * A prompt has been handed to Kilo since the last finalization pass started.
   * Cleared at finalization pass start; a prompt submitted while the pass runs
   * suppresses `completed` for that idle.
   */
  submittedSinceIdle: boolean;
  /** A root idle was observed while finalizing and has not been consumed yet. */
  idleWhileFinalizing: boolean;
  started: boolean;
  startedAt: number;
  lastProgressAt: number;
  waitingSince: number | null;
  pausedMs: number;
  progressed: boolean;
  resubmitted: boolean;
  /**
   * Tool parts currently `running` in this turn's routed root session or its
   * resolved descendant tree, keyed by `<kilo session id>\0<part id>`. Kilo owns
   * each tool's own timeout, so a nonempty set holds the no-progress clock, but
   * never the hard cap. Diagnostic `lastTool` is not decision state.
   */
  runningParts: Set<string>;
  /**
   * Diagnostic only: real-progress events seen from descendant sessions in this
   * turn's tree, counted alongside the root progress they mark. This count is
   * reported at expiry to distinguish "descendant progress arrived" from "no
   * descendant progress arrived at all". It never affects any accounting.
   */
  descendantProgressEvents: number;
  lastProgressSessionId?: string;
  lastProgressEventType?: string;
  lastTool?: {
    sessionId: string;
    messageId: string;
    partId: string;
    status: string;
    observedAt: number;
    outputBytes?: number;
  };
  preDeadlineProbedAt?: number;
  /** Aborts the running finalization step (timeout or Stop). */
  stepAbort?: AbortController;
  submitting: Promise<void>;
};

type TurnRoute = {
  sessionId: string;
  kiloSessionId: string;
  directory: string;
  runtimeKey: string;
  createdOnPlatform?: string;
  automaticPermissions: Set<string>;
};

type QueueState = 'ready' | 'queue' | 'unavailable';

/** Time the turn spent paused because it was waiting on the user. */
export function turnPausedMs(turn: Pick<Turn, 'pausedMs' | 'waitingSince'>, now: number): number {
  return turn.waitingSince === null
    ? turn.pausedMs
    : turn.pausedMs + Math.max(0, now - turn.waitingSince);
}

/** Time since the last real progress, excluding time waiting on the user. */
export function noProgressElapsedMs(
  turn: Pick<Turn, 'lastProgressAt' | 'pausedMs' | 'waitingSince'>,
  now: number
): number {
  return Math.max(0, now - turn.lastProgressAt - turnPausedMs(turn, now));
}

export type TurnDeadlineAction = 'no_progress' | 'execution_limit';

/**
 * The pure outcome clock. The 7-minute real-progress clock pauses while the
 * turn waits on the user; a nonempty running set holds no-progress failure; the
 * 120-minute cap does not.
 */
export function turnDeadlineAction(
  turn: Pick<Turn, 'startedAt' | 'lastProgressAt' | 'pausedMs' | 'waitingSince' | 'runningParts'>,
  now: number,
  timers: TurnTimers
): TurnDeadlineAction | null {
  if (now - turn.startedAt >= timers.turnHardCapMs) return 'execution_limit';
  if (turn.runningParts.size > 0) return null;
  if (noProgressElapsedMs(turn, now) >= timers.noProgressMs) return 'no_progress';
  return null;
}

function eventMessageId(properties: Record<string, unknown>): string | undefined {
  if (typeof properties.messageID === 'string') return properties.messageID;
  const part = properties.part;
  if (isRecord(part) && typeof part.messageID === 'string') return part.messageID;
  return undefined;
}

function isRealProgress(
  turn: Pick<Turn, 'prompts'>,
  type: string,
  properties: Record<string, unknown>
): boolean {
  // Kilo stores the user's own prompt as a text part, which is not progress.
  const messageId = eventMessageId(properties);
  if (
    messageId !== undefined &&
    turn.prompts.some(entry => entry.payload.messageId === messageId)
  ) {
    return false;
  }
  if (type === 'message.part.delta') return true;
  if (type !== 'message.part.updated') return false;
  const part = properties.part;
  if (!isRecord(part)) return false;
  return part.type === 'text' || part.type === 'reasoning' || part.type === 'tool';
}

/** A prompt was received (and kept) but not yet handed to Kilo. */
function hasUndispatchedPrompt(turn: Pick<Turn, 'prompts'>): boolean {
  return turn.prompts.some(entry => entry.dispatched !== true);
}

/**
 * Record that a prompt reached Kilo. An idle seen before this dispatch cannot
 * cover the work it starts, so the pending idle is dropped.
 */
function markDispatched(
  turn: Pick<Turn, 'submittedSinceIdle' | 'idleWhileFinalizing' | 'phase'>,
  pending: PendingPrompt
): void {
  pending.dispatched = true;
  turn.submittedSinceIdle = true;
  if (turn.phase === 'finalizing') turn.idleWhileFinalizing = false;
}

export type TurnManager = ReturnType<typeof createTurnManager>;

export function createTurnManager(deps: TurnManagerDeps) {
  const timers = deps.timers.wrapper;
  const now = deps.now ?? Date.now;
  const scheduler = deps.scheduler ?? {
    setInterval: (handler, ms) => setInterval(handler, ms),
    clearInterval: handle => clearInterval(handle),
    setTimeout: (handler, ms) => setTimeout(handler, ms),
    clearTimeout: handle => clearTimeout(handle),
  };
  const materialize = deps.materializeAttachments ?? materializeMessageAttachments;
  const autoCommit = deps.runAutoCommit ?? runAutoCommit;
  const capture = deps.captureWorktreeState ?? captureWorktreeState;
  const condense =
    deps.runCondense ??
    ((input: {
      kiloClient: WrapperKiloClient;
      kiloSessionId: string;
      directory: string;
      model: string;
      signal?: AbortSignal;
    }) => summarizeWithTimeout({ ...input, directory: input.directory }));

  const routes = new Map<string, TurnRoute>();
  const turns = new Map<string, Turn>();
  const turnByKiloSession = new Map<string, string>();
  const childRoots = new Map<string, string>();
  const tickMs = Math.max(500, Math.floor(timers.noProgressMs / 7));
  let tickHandle: ReturnType<typeof setInterval> | undefined;

  function log(message: string): void {
    deps.log?.(message);
  }

  function emitEvents(
    sessionId: string,
    events: Array<{ type: string; properties: Record<string, unknown> }>
  ): void {
    if (events.length === 0) return;
    deps.emit({ type: 'session.events', sessionId, events });
  }

  function emitWarning(sessionId: string, message: string): void {
    log(`turn: warning - ${message}`);
    emitEvents(sessionId, [{ type: 'error', properties: { error: message, fatal: false } }]);
  }

  function lastReceivedMessageId(turn: Turn): string {
    return turn.prompts.at(-1)?.payload.messageId ?? '';
  }

  /**
   * Emits a terminal outcome and releases the turn. The `completed` path
   * captures the worktree first (see `finalize`); every other path captures
   * here, before the outcome, because the sandbox becomes idle-eligible as soon
   * as the outcome is reported. A prompt that arrives while a terminal capture
   * runs starts a fresh turn, so the reset happens before the capture.
   */
  function sendOutcome(
    turn: Turn,
    status: 'completed' | 'failed' | 'cancelled',
    reason?: string,
    facts?: Pick<ControlPlaneOutcome, 'assistantReason' | 'providerOwnership'>
  ): void {
    if (
      status === 'completed' ||
      worktreeStateEndpointFor(turn.route.directory) === undefined ||
      isWorktreeStateDeletionInProgress(turn.route.directory)
    ) {
      emitOutcome(turn, status, reason, facts);
      return;
    }
    resetTurn(turn.route.sessionId);
    void captureWorktreeStateForTurn(turn).finally(() => emitOutcome(turn, status, reason, facts));
  }

  function emitOutcome(
    turn: Turn,
    status: 'completed' | 'failed' | 'cancelled',
    reason?: string,
    facts?: Pick<ControlPlaneOutcome, 'assistantReason' | 'providerOwnership'>
  ): void {
    // Name the last prompt the wrapper RECEIVED. For a failure that settles a
    // queued-but-unsent prompt too, so it cannot sit accepted until the
    // backstop; for `completed` this is safe because completion requires every
    // received prompt to have been dispatched, and dispatch order is receipt
    // order.
    const lastMessageId = lastReceivedMessageId(turn);
    deps.emit({
      type: 'session.outcome',
      sessionId: turn.route.sessionId,
      status,
      ...(reason === undefined ? {} : { reason }),
      ...(facts?.assistantReason === undefined ? {} : { assistantReason: facts.assistantReason }),
      ...(facts?.providerOwnership === undefined
        ? {}
        : { providerOwnership: facts.providerOwnership }),
      lastMessageId,
    });
    // Closed native record for every status. `outcomeReason` is the parsed
    // failure enum only; an assistant `safeMessage` does not parse and is never
    // copied. `assistantReason` stays on the socket frame.
    const outcomeReason = controlPlaneFailureReasonSchema.safeParse(reason);
    deps.onNativeDiagnostic?.('wrapper.lifecycle', {
      phase: 'session_outcome',
      status,
      sessionId: turn.route.sessionId,
      ...(outcomeReason.success ? { outcomeReason: outcomeReason.data } : {}),
    });
    if (turns.get(turn.route.sessionId) === turn) resetTurn(turn.route.sessionId);
    maybeApplyPendingCredentials(turn.route.runtimeKey);
  }

  /**
   * Captures the worktree's uncommitted state so a rebuilt sandbox can restore
   * it. Best-effort and bounded: the capture never throws, and no failure here
   * can fail the turn.
   */
  async function captureWorktreeStateForTurn(turn: Turn): Promise<void> {
    const endpoint = worktreeStateEndpointFor(turn.route.directory);
    if (!endpoint || isWorktreeStateDeletionInProgress(turn.route.directory)) return;
    const env = deps.runtimes.get(turn.route.runtimeKey)?.env;
    try {
      const captured = await capture({
        directory: turn.route.directory,
        endpoint,
        ...(env ? { env } : {}),
        signal: AbortSignal.timeout(WORKTREE_STATE_CAPTURE_BUDGET_MS),
      });
      logWorktreeState('capture', turn.route.directory, captured);
    } catch {
      // capture() already degrades to a skip; this only guards a throw from the
      // diagnostic log itself.
    }
  }

  function resetTurn(sessionId: string): void {
    if (!turns.has(sessionId)) return;
    turns.delete(sessionId);
    stopTickIfIdle();
  }

  async function applyPendingCredentials(runtimeKeyValue: string): Promise<void> {
    const runtime = deps.runtimes.get(runtimeKeyValue);
    if (runtime?.applyPendingCredentials === undefined) return;
    try {
      await runtime.applyPendingCredentials(() => canRestartRuntime(runtimeKeyValue));
    } catch {
      // The next idle retries; a failed credential restart never fails a turn.
    }
  }

  function maybeApplyPendingCredentials(runtimeKeyValue: string): void {
    if (!canRestartRuntime(runtimeKeyValue)) return;
    void applyPendingCredentials(runtimeKeyValue);
  }

  function canRestartRuntime(runtimeKeyValue: string): boolean {
    return turnsForRuntimeKey(runtimeKeyValue).length === 0;
  }

  function queueState(route: TurnRoute): QueueState {
    const runtime = deps.runtimes.get(route.runtimeKey);
    if (runtime === undefined || runtime.isUnavailable()) return 'unavailable';
    if (runtime.isRestarting() || runtime.isSuspected()) return 'queue';
    return 'ready';
  }

  function ensureTick(): void {
    if (tickHandle !== undefined) return;
    if (turns.size === 0) return;
    tickHandle = scheduler.setInterval(() => tick(), tickMs);
  }

  function stopTickIfIdle(): void {
    if (tickHandle === undefined || turns.size > 0) return;
    scheduler.clearInterval(tickHandle);
    tickHandle = undefined;
  }

  function createTurn(route: TurnRoute): Turn {
    const at = now();
    const turn: Turn = {
      route,
      phase: 'busy',
      inbox: [],
      prompts: [],
      submittedSinceIdle: false,
      idleWhileFinalizing: false,
      started: false,
      startedAt: at,
      lastProgressAt: at,
      waitingSince: null,
      pausedMs: 0,
      progressed: false,
      resubmitted: false,
      runningParts: new Set(),
      descendantProgressEvents: 0,
      submitting: Promise.resolve(),
    };
    turns.set(route.sessionId, turn);
    ensureTick();
    return turn;
  }

  function beginWaiting(turn: Turn): void {
    if (turn.waitingSince === null) turn.waitingSince = now();
  }

  function endWaiting(turn: Turn): void {
    if (turn.waitingSince === null) return;
    turn.pausedMs += Math.max(0, now() - turn.waitingSince);
    turn.waitingSince = null;
  }

  function applyInteraction(turn: Turn, type: string): boolean {
    if (type === 'question.asked' || type === 'permission.asked') {
      beginWaiting(turn);
      return true;
    }
    if (
      type === 'question.replied' ||
      type === 'question.rejected' ||
      type === 'permission.replied'
    ) {
      endWaiting(turn);
      return true;
    }
    return false;
  }

  // Real progress only moves the progress clock. It must not end a user wait:
  // the pending question's own tool part is a tool event, so ending the wait here
  // resumes the no-progress clock and reports the waiting turn as active, which
  // pins the sandbox. A wait ends only on `question.replied`/`question.rejected`/
  // `permission.replied` or a delivered answer (spec §7 "waiting on the user
  // pauses the clock").
  function markProgress(turn: Turn, sessionId: string | undefined, eventType: string): void {
    turn.progressed = true;
    turn.lastProgressAt = now();
    turn.lastProgressSessionId = sessionId;
    turn.lastProgressEventType = eventType;
    // Pause credit belongs to the interval since the last progress, so a wait
    // that fully elapsed before this progress cannot be spent as credit after it.
    turn.pausedMs = 0;
    if (turn.waitingSince !== null) turn.waitingSince = turn.lastProgressAt;
  }

  function chainSubmit(turn: Turn, pending: PendingPrompt): void {
    const prompts = turn.prompts;
    turn.submitting = turn.submitting
      .then(() => submitPayloadInner(turn, pending, prompts))
      .catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        log(`turn: prompt submission failed - ${message}`);
        if (turns.get(turn.route.sessionId) === turn) {
          sendOutcome(turn, 'failed', 'prompt_failed');
        }
      });
  }

  async function submitPayloadInner(
    turn: Turn,
    pending: PendingPrompt,
    prompts: PendingPrompt[]
  ): Promise<void> {
    const isCurrent = () => turns.get(turn.route.sessionId) === turn && turn.prompts === prompts;
    if (!isCurrent()) {
      // The turn already reached a terminal outcome (Stop, failure or restart),
      // which settled everything the wrapper received. Sending it again would
      // run a message the user already terminalized.
      return;
    }
    const route = turn.route;
    const runtime = deps.runtimes.get(route.runtimeKey);
    if (runtime === undefined) throw new Error('Kilo runtime is unavailable');
    const model = pending.payload.agent.model;
    let message: MaterializedPrompt | undefined;
    if (pending.payload.turn.type === 'prompt') {
      // Materialize once: a resubmission after a restart reuses the parts that
      // are already on disk under the same message id.
      pending.message ??= materialize(
        {
          id: pending.payload.messageId,
          prompt: pending.payload.turn.prompt,
          parts: pending.payload.turn.parts,
          attachments: pending.payload.attachments,
        },
        {}
      );
      message = await pending.message;
    }
    if (!isCurrent()) return;
    if (queueState(route) === 'queue') {
      if (!turn.inbox.includes(pending)) turn.inbox.push(pending);
      return;
    }
    const client = await runtime.ensure();
    if (!isCurrent()) return;
    if (runtime.isRetiredClient(client) || queueState(route) === 'queue') {
      if (!turn.inbox.includes(pending)) turn.inbox.push(pending);
      return;
    }
    try {
      if (pending.payload.turn.type === 'prompt') {
        if (message === undefined) throw new Error('Prompt attachments were not materialized');
        // Now handed to Kilo. The mark lives on the prompt, so a resubmission of
        // the same messageId cannot outrun the receipt count.
        markDispatched(turn, pending);
        await client.sendPromptAsync({
          sessionId: route.kiloSessionId,
          directory: route.directory,
          messageId: pending.payload.messageId,
          agent: pending.payload.agent.mode,
          ...(pending.payload.agent.variant === undefined
            ? {}
            : { variant: pending.payload.agent.variant }),
          ...(message.prompt === undefined ? {} : { prompt: message.prompt }),
          ...(message.parts === undefined ? {} : { parts: message.parts }),
          ...(model === undefined ? {} : { model: { providerID: 'kilo', modelID: model } }),
        });
      } else if (pending.payload.turn.command === 'compact') {
        if (model === undefined) throw new Error('Compact requires a model');
        markDispatched(turn, pending);
        const summarized = await client.summarizeSession({
          sessionId: route.kiloSessionId,
          directory: route.directory,
          model: { modelID: model },
        });
        if (!summarized) throw new Error('Session summarization failed');
      } else {
        markDispatched(turn, pending);
        await client.sendCommand({
          sessionId: route.kiloSessionId,
          directory: route.directory,
          command: pending.payload.turn.command,
          args: pending.payload.turn.arguments,
          messageId: pending.payload.messageId,
          agent: pending.payload.agent.mode,
          ...(pending.payload.agent.variant === undefined
            ? {}
            : { variant: pending.payload.agent.variant }),
          ...(model === undefined ? {} : { model: { providerID: 'kilo', modelID: model } }),
        });
      }
    } catch (error) {
      if (runtime.isRetiredClient(client) && isKiloServerUnreachableError(error)) return;
      throw error;
    }
    if (isCurrent()) recordSubmitted(turn, pending);
  }

  function recordSubmitted(turn: Turn, pending: PendingPrompt): void {
    if (!turn.prompts.some(entry => entry.payload.messageId === pending.payload.messageId)) {
      turn.prompts.push(pending);
    }
    if (!turn.started) {
      // The batch clock starts at its first successful submission.
      turn.started = true;
      const at = now();
      turn.startedAt = at;
      turn.lastProgressAt = at;
    }
  }

  function acceptPrompt(sessionId: string, payload: ControlPlanePromptPayload): void {
    const route = routes.get(sessionId);
    if (route === undefined) {
      log(`turn: prompt for unknown session ${sessionId}`);
      return;
    }
    const turn = turns.get(sessionId) ?? createTurn(route);
    // A delivery retry (spec §12) repeats the same messageId; it must not
    // double-count or be dispatched again.
    if (turn.prompts.some(entry => entry.payload.messageId === payload.messageId)) return;
    const pending: PendingPrompt = { payload };
    turn.prompts.push(pending);
    const state = queueState(route);
    if (state === 'unavailable') {
      sendOutcome(turn, 'failed', 'agent_unavailable');
      return;
    }
    if (state === 'queue') {
      turn.inbox.push(pending);
      return;
    }
    chainSubmit(turn, pending);
  }

  function drainInbox(turn: Turn): void {
    if (turn.inbox.length === 0) return;
    const state = queueState(turn.route);
    if (state === 'queue') return;
    if (state === 'unavailable') {
      sendOutcome(turn, 'failed', 'agent_unavailable');
      return;
    }
    const queued = turn.inbox.splice(0);
    for (const pending of queued) chainSubmit(turn, pending);
  }

  async function abortKilo(route: TurnRoute): Promise<void> {
    const runtime = deps.runtimes.get(route.runtimeKey);
    if (runtime === undefined) return;
    try {
      await runtime.client.abortSession({
        sessionId: route.kiloSessionId,
        directory: route.directory,
      });
    } catch {
      log(`turn: Kilo abort failed session=${route.kiloSessionId}`);
    }
  }

  /**
   * Deliver a question or permission reply to Kilo for a route (spec §5). The
   * wrapper owns the route directory, so the caller only names the session and
   * the reply. Kilo's own `question.replied`/`permission.replied` event also
   * resumes the wait; ending it here stops the no-progress clock from staying
   * paused if that event is not observed.
   */
  async function answerInteraction(
    sessionId: string,
    reply: ControlPlaneAnswerReply
  ): Promise<void> {
    const route = routes.get(sessionId);
    if (route === undefined) {
      log(`turn: answer for unknown session ${sessionId}`);
      return;
    }
    const runtime = deps.runtimes.get(route.runtimeKey);
    if (runtime === undefined) {
      log(`turn: answer with no runtime for ${sessionId}`);
      return;
    }
    let client: WrapperKiloClient;
    try {
      client = runtime.client;
    } catch {
      return;
    }
    try {
      if (reply.action === 'permission') {
        await client.answerPermission(
          reply.permissionId,
          reply.response,
          reply.message,
          undefined,
          route.directory
        );
      } else if (reply.action === 'reject') {
        await client.rejectQuestion(reply.questionId, route.directory);
      } else {
        await client.answerQuestion(reply.questionId, reply.answers, route.directory);
      }
    } catch (error) {
      log(`turn: answer failed - ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const turn = turns.get(sessionId);
    if (turn !== undefined) endWaiting(turn);
  }

  function probeLastTool(turn: Turn, stage: 'pre_deadline' | 'deadline'): void {
    const tool = turn.lastTool;
    if (tool === undefined) return;
    const fields = {
      phase: 'freshness',
      probeStage: stage,
      sessionId: turn.route.sessionId,
      kiloSessionId: tool.sessionId,
      messageId: tool.messageId,
      partId: tool.partId,
    };
    let probe: WrapperKiloClient['probeMessagePart'];
    try {
      probe = deps.runtimes.get(turn.route.runtimeKey)?.client.probeMessagePart;
    } catch {
      deps.onDiagnostic?.('session.execution', { ...fields, probeStatus: 'unavailable' });
      return;
    }
    if (probe === undefined) return;
    // The pre-deadline sample can finish before cancellation. Neither probe
    // delays nor refreshes the seven-minute no-progress clock.
    try {
      void probe(
        tool.sessionId,
        turn.route.directory,
        tool.messageId,
        tool.partId,
        AbortSignal.timeout(1_500)
      ).then(
        part =>
          deps.onDiagnostic?.('session.execution', {
            ...fields,
            probeStatus: part === null ? 'missing' : 'found',
            toolStatus: part?.status,
            outputBytes: part?.outputBytes,
          }),
        () => deps.onDiagnostic?.('session.execution', { ...fields, probeStatus: 'unavailable' })
      );
    } catch {
      deps.onDiagnostic?.('session.execution', { ...fields, probeStatus: 'unavailable' });
    }
  }

  function failDeadline(turn: Turn, action: TurnDeadlineAction): void {
    const reason = action === 'execution_limit' ? 'execution_limit' : 'no_progress';
    const lastTool = turn.lastTool;
    deps.onDiagnostic?.('session.execution', {
      phase: 'deadline_expired',
      reason,
      sessionId: turn.route.sessionId,
      rootKiloSessionId: turn.route.kiloSessionId,
      kiloSessionId: turn.lastProgressSessionId,
      eventType: turn.lastProgressEventType,
      lastEventAt: turn.lastProgressAt,
      elapsedMs: noProgressElapsedMs(turn, now()),
      descendantProgressEvents: turn.descendantProgressEvents,
      messageId: lastTool?.messageId,
      partId: lastTool?.partId,
      toolStatus: lastTool?.status,
      toolObservedAt: lastTool?.observedAt,
      outputBytes: lastTool?.outputBytes,
    });
    probeLastTool(turn, 'deadline');
    log(
      `turn: ${reason} aborting session ${turn.route.kiloSessionId} descendantProgressEvents=${turn.descendantProgressEvents}`
    );
    turn.stepAbort?.abort(new Error(reason));
    void abortKilo(turn.route);
    sendOutcome(turn, 'failed', reason);
  }

  async function finalize(turn: Turn): Promise<void> {
    if (turn.phase === 'finalizing') return;
    turn.phase = 'finalizing';
    const sessionId = turn.route.sessionId;
    for (;;) {
      if (hasUndispatchedPrompt(turn)) {
        turn.phase = 'busy';
        return;
      }
      // A submit or an idle from here on belongs to a newer run. A new prompt
      // must not be settled before it runs, and an idle observed during the
      // pass must not be lost.
      turn.submittedSinceIdle = false;
      turn.idleWhileFinalizing = false;
      const controller = new AbortController();
      turn.stepAbort = controller;
      const timer = scheduler.setTimeout(() => {
        controller.abort(new Error('finalization timed out'));
      }, DEFAULT_CONDENSE_TIMEOUT_MS);
      emitEvents(sessionId, [{ type: CONTROL_PLANE_WRAPPER_FINALIZING_EVENT, properties: {} }]);
      try {
        await runAutoCommitStep(turn, controller.signal);
        await runCondenseStep(turn, controller.signal);
      } finally {
        scheduler.clearTimeout(timer);
        turn.stepAbort = undefined;
      }
      if (turns.get(sessionId) !== turn) return;
      if (hasUndispatchedPrompt(turn)) {
        turn.phase = 'busy';
        return;
      }
      if (turn.submittedSinceIdle) {
        if (turn.idleWhileFinalizing) continue; // the newer prompt's idle arrived; run again
        // A newer prompt is running; wait for its idle.
        turn.phase = 'busy';
        return;
      }
      // Capture uncommitted work before the turn is reported done, so the idle
      // stop cannot discard it. A prompt that arrives while the capture runs is
      // handled by the same rechecks the pass already uses.
      if (
        worktreeStateEndpointFor(turn.route.directory) !== undefined &&
        !isWorktreeStateDeletionInProgress(turn.route.directory)
      ) {
        await captureWorktreeStateForTurn(turn);
        if (turns.get(sessionId) !== turn) return;
        if (hasUndispatchedPrompt(turn)) {
          turn.phase = 'busy';
          return;
        }
        if (turn.submittedSinceIdle) {
          if (turn.idleWhileFinalizing) continue;
          turn.phase = 'busy';
          return;
        }
      }
      sendOutcome(turn, 'completed');
      return;
    }
  }

  async function runAutoCommitStep(turn: Turn, signal: AbortSignal): Promise<void> {
    if (!turn.prompts.some(entry => entry.payload.finalization?.autoCommit)) return;
    if (queueState(turn.route) === 'queue') return;
    const runtime = deps.runtimes.get(turn.route.runtimeKey);
    if (runtime === undefined) return;
    const sessionId = turn.route.sessionId;
    try {
      await autoCommit({
        workspacePath: turn.route.directory,
        kiloClient: runtime.client,
        messageId: turn.assistantMessageId ?? lastReceivedMessageId(turn),
        userMessageId: lastReceivedMessageId(turn),
        env: runtime.env,
        signal,
        onEvent: event => {
          emitEvents(sessionId, [
            {
              type: event.streamEventType,
              properties: { ...(event.data as Record<string, unknown>) },
              ...(typeof event.timestamp === 'string' ? { timestamp: event.timestamp } : {}),
            },
          ]);
        },
      });
    } catch (error) {
      emitWarning(
        sessionId,
        `Auto-commit failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async function runCondenseStep(turn: Turn, signal: AbortSignal): Promise<void> {
    if (!turn.prompts.some(entry => entry.payload.finalization?.condenseOnComplete)) return;
    const model = turn.prompts.findLast(entry => entry.payload.agent.model !== undefined)?.payload
      .agent.model;
    if (model === undefined) {
      emitWarning(turn.route.sessionId, 'Condense skipped: no model');
      return;
    }
    if (queueState(turn.route) === 'queue') return;
    const runtime = deps.runtimes.get(turn.route.runtimeKey);
    if (runtime === undefined) return;
    try {
      const result = await condense({
        kiloClient: runtime.client,
        kiloSessionId: turn.route.kiloSessionId,
        directory: turn.route.directory,
        model,
        signal,
      });
      if (!result.success) {
        emitWarning(turn.route.sessionId, `Condense failed: ${result.error ?? 'unknown error'}`);
      }
    } catch (error) {
      emitWarning(
        turn.route.sessionId,
        `Condense failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  function resolveRootKiloSession(kiloSessionId: string | undefined): string | undefined {
    if (kiloSessionId === undefined) return undefined;
    if (turnByKiloSession.has(kiloSessionId)) return kiloSessionId;
    return childRoots.get(kiloSessionId);
  }

  function onKiloError(turn: Turn, properties: Record<string, unknown>): void {
    const failure = classifyAssistantFailure(properties.error ?? properties);
    sendOutcome(turn, 'failed', failure.safeMessage, {
      assistantReason: failure.reason,
      providerOwnership: failure.providerOwnership,
    });
  }

  function observeRootEvent(turn: Turn, type: string, properties: Record<string, unknown>): void {
    if (
      turn.phase === 'finalizing' &&
      !turn.submittedSinceIdle &&
      (type === 'session.error' ||
        (type === 'session.turn.close' && properties.reason !== 'completed'))
    ) {
      return;
    }
    if (type === 'session.turn.close') {
      if (properties.reason === 'interrupted') {
        sendOutcome(turn, 'cancelled');
        return;
      }
      if (properties.reason === 'error') {
        onKiloError(turn, properties);
        return;
      }
      if (properties.reason !== 'completed') return;
      if (turn.phase === 'finalizing') {
        turn.idleWhileFinalizing = true;
        return;
      }
      void finalize(turn);
      return;
    }
    if (type === 'session.error') {
      onKiloError(turn, properties);
      return;
    }
  }

  function tick(): void {
    const at = now();
    for (const turn of [...turns.values()]) {
      if (turns.get(turn.route.sessionId) !== turn) continue;
      const state = queueState(turn.route);
      if (state === 'queue') continue;
      if (state === 'unavailable') {
        sendOutcome(turn, 'failed', 'agent_unavailable');
        continue;
      }
      const action = turnDeadlineAction(turn, at, timers);
      if (
        action === null &&
        turn.runningParts.size === 0 &&
        noProgressElapsedMs(turn, at) >= timers.noProgressMs - 60_000 &&
        turn.preDeadlineProbedAt !== turn.lastProgressAt
      ) {
        turn.preDeadlineProbedAt = turn.lastProgressAt;
        probeLastTool(turn, 'pre_deadline');
      }
      if (action !== null) failDeadline(turn, action);
    }
  }

  function registerChild(event: KiloFeedEvent): void {
    const child = childFromSessionCreated(event.properties);
    if (child === undefined) return;
    const parentRoot = resolveRootKiloSession(child.parentId);
    if (parentRoot === undefined) return;
    childRoots.set(child.childId, parentRoot);
  }

  async function answerAutomaticPermission(route: TurnRoute, event: KiloFeedEvent): Promise<void> {
    const permissionId = event.properties.id;
    if (typeof permissionId !== 'string') return;
    const turn = turns.get(route.sessionId);
    const codeReview = route.createdOnPlatform === 'code-review';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const runtime = deps.runtimes.get(route.runtimeKey);
        if (runtime === undefined) throw new Error('Kilo runtime unavailable');
        const success = await runtime.client.answerPermission(
          permissionId,
          codeReview ? 'reject' : 'always',
          codeReview
            ? 'Permission rejected for code-review non-interactive mode. Continue using another read-only, non-interactive method if available.'
            : undefined,
          undefined,
          route.directory
        );
        if (!success) throw new Error('Permission reply was not accepted');
        return;
      } catch (error) {
        log(
          `turn: automatic permission reply failed - ${error instanceof Error ? error.message : String(error)}`
        );
        if (
          routes.get(route.sessionId) !== route ||
          !route.automaticPermissions.has(permissionId)
        ) {
          return;
        }
        if (attempt === 0) continue;
        route.automaticPermissions.delete(permissionId);
        if (codeReview) {
          if (turn !== undefined && turns.get(route.sessionId) === turn) {
            void abortKilo(route);
            sendOutcome(turn, 'failed', 'Code-review permission rejection failed');
          }
          return;
        }
        emitEvents(route.sessionId, [{ type: event.type, properties: event.properties }]);
        if (turn !== undefined && turns.get(route.sessionId) === turn) beginWaiting(turn);
      }
    }
  }

  async function publishCommandsFor(sessionId: string): Promise<void> {
    const route = routes.get(sessionId);
    if (route === undefined) return;
    const runtime = deps.runtimes.get(route.runtimeKey);
    if (runtime === undefined || runtime.isRestarting() || runtime.isUnavailable()) return;
    let client: WrapperKiloClient;
    try {
      client = runtime.client;
    } catch {
      return;
    }
    try {
      const catalog = await client.listCommands();
      const catalogStatus = slashCommandCatalogStatus(catalog);
      emitEvents(sessionId, [
        {
          type: 'commands.available',
          properties: {
            commands: catalog.commands,
            ...(catalogStatus ? { catalogStatus } : {}),
          },
        },
      ]);
    } catch (error) {
      log(`turn: listCommands failed - ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function publishCommandsForRuntimeKey(runtimeKeyValue: string): Promise<void> {
    for (const route of routes.values()) {
      if (route.runtimeKey === runtimeKeyValue) await publishCommandsFor(route.sessionId);
    }
  }

  function turnsForRuntimeKey(runtimeKeyValue: string): Turn[] {
    const matched: Turn[] = [];
    for (const turn of turns.values()) {
      if (turn.route.runtimeKey === runtimeKeyValue) matched.push(turn);
    }
    return matched;
  }

  /** Turns not waiting on the user; the heartbeat and the status line share it. */
  function activeTurnCount(): number {
    let count = 0;
    for (const turn of turns.values()) {
      if (turn.waitingSince !== null) continue;
      count += 1;
    }
    return count;
  }

  return {
    canRestartRuntime,

    credentialsInstalled(runtimeKeyValue: string): void {
      maybeApplyPendingCredentials(runtimeKeyValue);
    },

    registerRoute(spec: ControlPlaneRouteSpec): void {
      const existing = routes.get(spec.sessionId);
      if (existing !== undefined && existing.kiloSessionId !== spec.kiloSessionId) {
        turnByKiloSession.delete(existing.kiloSessionId);
      }
      const route: TurnRoute = {
        sessionId: spec.sessionId,
        kiloSessionId: spec.kiloSessionId,
        directory: spec.directory,
        runtimeKey: runtimeKey(spec),
        createdOnPlatform: spec.createdOnPlatform,
        automaticPermissions: existing?.automaticPermissions ?? new Set(),
      };
      routes.set(spec.sessionId, route);
      turnByKiloSession.set(spec.kiloSessionId, spec.sessionId);
    },

    release(sessionId: string): void {
      const route = routes.get(sessionId);
      if (route !== undefined) {
        turnByKiloSession.delete(route.kiloSessionId);
        for (const [child, root] of childRoots) {
          if (root === route.kiloSessionId) childRoots.delete(child);
        }
      }
      routes.delete(sessionId);
      turns.delete(sessionId);
      stopTickIfIdle();
    },

    submit(sessionId: string, payload: ControlPlanePromptPayload): void {
      acceptPrompt(sessionId, payload);
    },

    abort(sessionId: string): void {
      const route = routes.get(sessionId);
      if (route !== undefined) void abortKilo(route);
      const turn = turns.get(sessionId);
      if (turn === undefined) return;
      turn.stepAbort?.abort(new Error('aborted'));
      sendOutcome(turn, 'cancelled');
    },

    answer(sessionId: string, reply: ControlPlaneAnswerReply): Promise<void> {
      return answerInteraction(sessionId, reply);
    },

    observeKiloEvent(event: KiloFeedEvent): void {
      // Kilo is back (or the feed resumed): drain anything waiting for it.
      for (const turn of turns.values()) {
        if (turn.inbox.length > 0) drainInbox(turn);
      }
      if (SYNTHETIC_KILO_EVENTS.has(event.type)) return;
      const eventSessionId = eventKiloSessionId(event.properties);
      if (event.type === 'session.created') registerChild(event);
      const root = resolveRootKiloSession(eventSessionId);
      if (root === undefined) return;
      const sessionId = turnByKiloSession.get(root);
      if (sessionId === undefined) return;
      const route = routes.get(sessionId);
      if (route === undefined) return;
      if (event.type === 'permission.replied' && typeof event.properties.requestID === 'string') {
        if (route.automaticPermissions.delete(event.properties.requestID)) return;
      }
      if (event.type === 'permission.asked' && typeof event.properties.id === 'string') {
        const metadata = event.properties.metadata;
        const requiresHuman =
          isRecord(metadata) &&
          (metadata.skillShell === true || metadata.sandboxEscalation === true);
        if (route.createdOnPlatform === 'code-review' || !requiresHuman) {
          if (!route.automaticPermissions.has(event.properties.id)) {
            route.automaticPermissions.add(event.properties.id);
            void answerAutomaticPermission(route, event);
          }
          return;
        }
      }
      emitEvents(sessionId, [{ type: event.type, properties: event.properties }]);
      if (event.type === 'session.deleted' && eventSessionId !== root) {
        if (eventSessionId !== undefined) childRoots.delete(eventSessionId);
      }
      const turn = turns.get(sessionId);
      if (turn === undefined) return;
      if (
        event.type === 'session.deleted' &&
        eventSessionId !== undefined &&
        eventSessionId !== root
      ) {
        for (const partKey of turn.runningParts) {
          if (partKey.startsWith(`${eventSessionId}\0`)) turn.runningParts.delete(partKey);
        }
      }
      // A subagent's question still pauses the root turn (spec §6).
      applyInteraction(turn, event.type);
      const realProgress = isRealProgress(turn, event.type, event.properties);
      if (realProgress) markProgress(turn, eventSessionId, event.type);
      if (event.type === 'message.part.updated') {
        const part = event.properties.part;
        if (isRecord(part) && part.type === 'tool' && eventSessionId !== undefined) {
          const state = part.state;
          if (isRecord(state) && typeof state.status === 'string' && typeof part.id === 'string') {
            const partKey = `${eventSessionId}\0${part.id}`;
            if (state.status === 'running') turn.runningParts.add(partKey);
            else turn.runningParts.delete(partKey);
            if (typeof part.messageID === 'string') {
              turn.lastTool = {
                sessionId: eventSessionId,
                messageId: part.messageID,
                partId: part.id,
                status: state.status,
                observedAt: now(),
                ...(typeof state.output === 'string'
                  ? { outputBytes: Buffer.byteLength(state.output, 'utf8') }
                  : {}),
              };
            }
          }
        }
      }
      if (eventSessionId !== root) {
        // Diagnostic only: count the descendant progress that was marked above,
        // so a no-progress expiry can report whether descendant progress reached
        // the manager.
        if (realProgress) turn.descendantProgressEvents += 1;
        return;
      }
      if (event.type === 'message.updated') {
        const info = event.properties.info;
        if (isRecord(info) && info.role === 'assistant' && typeof info.id === 'string') {
          turn.assistantMessageId = info.id;
        }
      }
      observeRootEvent(turn, event.type, event.properties);
    },

    onRuntimeRestart(info: { directory: string; reason: KiloRestartReason; key: string }): void {
      void publishCommandsForRuntimeKey(info.key);
      for (const turn of turnsForRuntimeKey(info.key)) {
        // Kilo is replaced, so no part it reported can still be running.
        turn.runningParts.clear();
        if (turn.phase === 'finalizing') {
          if (turn.submittedSinceIdle || hasUndispatchedPrompt(turn)) {
            // A follow-up was received or dispatched after finalization
            // started; the restart interrupted its Kilo work, so fail it
            // instead of letting it end as no_progress.
            turn.stepAbort?.abort(new Error('agent restarted'));
            sendOutcome(turn, 'failed', 'agent_restarted');
          }
          // Otherwise let finalization finish; a later idle triggers it again.
          continue;
        }
        if (!turn.progressed && !turn.resubmitted) {
          // A repeated prompt_async with the same messageID appends a second
          // copy of the text parts (Kilo 7.8.1). The duplicate is accepted: it
          // only happens for a no-progress turn, so it repeats no tool side
          // effects, and the resubmission carries the same messageIDs.
          turn.resubmitted = turn.prompts.some(pending => pending.dispatched === true);
          turn.prompts = [...turn.prompts];
          for (const pending of turn.prompts) pending.dispatched = false;
          turn.submitting = Promise.resolve();
          turn.inbox = [...turn.prompts];
          drainInbox(turn);
          continue;
        }
        sendOutcome(turn, 'failed', 'agent_restarted');
      }
    },

    onRuntimeUnavailable(_directory: string, key: string): void {
      for (const turn of turnsForRuntimeKey(key)) {
        sendOutcome(turn, 'failed', 'agent_unavailable');
      }
      // The route must leave `ready`, or the next message keeps delivering to
      // this spent runtime instead of preparing a fresh one (spec §7).
      for (const route of routes.values()) {
        if (route.runtimeKey !== key) continue;
        deps.emit({
          type: 'session.failed',
          sessionId: route.sessionId,
          reason: 'agent_unavailable',
        });
      }
    },

    publishCommands(sessionId: string): Promise<void> {
      return publishCommandsFor(sessionId);
    },

    isActive(): boolean {
      return activeTurnCount() > 0;
    },

    activeTurnCount,

    tick,

    shutdown(): void {
      if (tickHandle === undefined) return;
      scheduler.clearInterval(tickHandle);
      tickHandle = undefined;
    },
  };
}
