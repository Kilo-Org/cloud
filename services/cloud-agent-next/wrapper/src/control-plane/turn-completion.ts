import { DEFAULT_CONDENSE_TIMEOUT_MS } from '../condense-on-complete.js';
import { DrainSessionError, type WrapperKiloClient } from '../kilo-api.js';
import { createDrainWaiter, type DrainWaiter, type DrainWaitResult } from '../drain-wait.js';
import { isAssistantInterrupt } from '../../../src/shared/assistant-failure.js';
import type { KiloFeedEvent } from '../control/worktree-feed.js';
import type { PendingPrompt, TurnKiloRuntime, TurnScheduler } from './turn.js';
import type { createReviewPublication } from './review-publication.js';

type CompletionRequest = {
  tail: PendingPrompt;
  delivery: Promise<void>;
  publicationSubmission?: Promise<void>;
  runtime: TurnKiloRuntime;
  client: WrapperKiloClient;
  nativeRuntimeId: string;
  abort: AbortController;
  waiter?: DrainWaiter;
  pair?: {
    token: string;
    marker(): void;
    refresh(): void;
    timed(): boolean;
  };
};

type OptionalOperation = {
  request: CompletionRequest;
  abort: AbortController;
};

/** What the supervisor showed for the route's tree when an established feed ended. */
type FeedGap = {
  nativeRuntimeId: string;
  /** The root's live execution. */
  root?: number;
  /** Every live execution in the root's tree; undefined when observation was already lost. */
  tree?: number[];
};

type CompletionState = {
  readonly route: {
    sessionId: string;
    kiloSessionId: string;
    directory: string;
    runtimeKey: string;
  };
  readonly prompts: PendingPrompt[];
  readonly submitting: Promise<void>;
  readonly publication: ReturnType<typeof createReviewPublication> | undefined;
  completion?: CompletionRequest;
  completionRunner?: Promise<void>;
  operation?: OptionalOperation;
  nativeProof?: CompletionRequest;
  publicationSubmission?: Promise<void>;
  publicationDelivery?: Promise<void>;
  publicationOrigin?: CompletionRequest;
  publicationCleanup?: { request: CompletionRequest; release(): void };
  /** The last prompt dispatched when this process last closed the root `completed`. */
  closedThrough?: PendingPrompt;
  /** Native history may be missing until the same process reconciles after the gap. */
  gap?: FeedGap;
};

type CompletionInput = {
  route: CompletionState['route'];
  prompts(): PendingPrompt[];
  submission(): Promise<void>;
  publication(): CompletionState['publication'];
  runtime(): TurnKiloRuntime | undefined;
  isActive(): boolean;
  scheduler: TurnScheduler;
  reserveDelivery(barrier: Promise<void>): void;
  submitPublication(client: WrapperKiloClient, signal: AbortSignal): Promise<void>;
  autoCommit: (client: WrapperKiloClient, signal: AbortSignal) => Promise<void>;
  condense: (client: WrapperKiloClient, signal: AbortSignal) => Promise<void>;
  finalizing(): void;
  warn(message: string): void;
  outcome(status: 'completed' | 'failed', reason?: string): void;
  nativeFailure(error: unknown): void;
};

export type TurnCompletion = ReturnType<typeof createTurnCompletion>;

/** Owns one Cloud batch's native confirmation, optional I/O, and success path. */
export function createTurnCompletion(input: CompletionInput) {
  const scheduler = input.scheduler;
  const turn: CompletionState = {
    route: input.route,
    get prompts() {
      return input.prompts();
    },
    get submitting() {
      return input.submission();
    },
    get publication() {
      return input.publication();
    },
  };
  function invalidateCompletion(turn: CompletionState): void {
    const request = turn.completion;
    turn.completion = undefined;
    request?.abort.abort();
    request?.waiter?.cancel();
  }

  function isCurrent(turn: CompletionState, request: CompletionRequest): boolean {
    return (
      input.isActive() &&
      turn.completion === request &&
      !request.abort.signal.aborted &&
      turn.prompts.at(-1) === request.tail &&
      turn.publicationSubmission === request.publicationSubmission
    );
  }

  function ownsNativeClient(turn: CompletionState, request: CompletionRequest): boolean {
    return (
      input.runtime() === request.runtime &&
      !request.runtime.isRetiredClient(request.client) &&
      request.runtime.nativeRuntimeId === request.nativeRuntimeId
    );
  }

  function cancellable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      work.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    });
  }

  function pairedDrain(
    turn: CompletionState,
    request: CompletionRequest,
    signal: AbortSignal,
    transportBudget?: number
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const token = crypto.randomUUID();
      const transport = new AbortController();
      let http = false;
      let marker = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const clearTimer = () => {
        if (timer !== undefined) scheduler.clearTimeout(timer);
        timer = undefined;
      };
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimer();
        signal.removeEventListener('abort', cancel);
        if (request.pair?.token === token) request.pair = undefined;
        transport.abort();
        if (error !== undefined) reject(error);
        else resolve(true);
      };
      const cancel = () => finish(signal.reason ?? new Error('Completion cancelled'));
      const refresh = () => {
        if (settled) return;
        if (!ownsNativeClient(turn, request)) {
          request.abort.abort();
          cancel();
          return;
        }
        // The pair cannot prove work the gap may have hidden, and its marker cannot arrive
        // without a feed; the reconcile that settles the gap refreshes the pair again.
        if (turn.gap !== undefined) {
          clearTimer();
          return;
        }
        if (http && marker) {
          finish();
          return;
        }
        const timed =
          transportBudget !== undefined ||
          http ||
          marker ||
          request.runtime.liveTreeExecutions(turn.route.kiloSessionId)?.length === 0;
        if (!timed) {
          clearTimer();
          return;
        }
        if (timer === undefined)
          timer = scheduler.setTimeout(
            () =>
              finish(
                new DrainSessionError(
                  'transient',
                  'native completion HTTP/marker pair was not confirmed'
                )
              ),
            transportBudget ?? 10_000
          );
      };
      request.pair = {
        token,
        marker: () => {
          marker = true;
          refresh();
        },
        refresh,
        timed: () => timer !== undefined,
      };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) {
        cancel();
        return;
      }
      refresh();
      if (settled) return;
      void request.client
        .drainSession({
          sessionId: turn.route.kiloSessionId,
          directory: turn.route.directory,
          token,
          signal: transport.signal,
        })
        .then(value => {
          if (settled) return;
          if (value !== true) {
            finish(new DrainSessionError('anomalous', 'Session drain returned false'));
            return;
          }
          http = true;
          refresh();
        }, finish);
    });
  }

  async function drainNativeWork(
    turn: CompletionState,
    request: CompletionRequest,
    transportBudget?: number
  ): Promise<DrainWaitResult> {
    const waiter = createDrainWaiter(
      signal => pairedDrain(turn, request, signal, transportBudget),
      {
        slowFailureResetMs: Infinity,
        scheduler,
      }
    );
    request.waiter = waiter;
    const cancel = () => waiter.cancel();
    request.abort.signal.addEventListener('abort', cancel, { once: true });
    try {
      if (request.abort.signal.aborted) return { state: 'cancelled' };
      return await waiter.start();
    } finally {
      request.abort.signal.removeEventListener('abort', cancel);
      request.waiter = undefined;
    }
  }

  function requestCompletion(turn: CompletionState, nativeRuntimeId: string): void {
    if (turn.prompts.some(entry => !entry.dispatched) || turn.publicationCleanup) return;
    const runtime = input.runtime();
    const tail = turn.prompts.at(-1);
    if (!runtime || !tail || runtime.isRestarting() || runtime.isUnavailable()) return;
    const client = runtime.client;
    if (runtime.isRetiredClient(client)) return;
    if (
      turn.completion?.tail === tail &&
      turn.completion.client === client &&
      turn.completion.publicationSubmission === turn.publicationSubmission
    )
      return;
    // An optional operation's own close does not start another finalizer.
    if (turn.operation?.request.tail === tail) return;
    invalidateCompletion(turn);
    turn.completion = {
      tail,
      delivery: turn.submitting,
      publicationSubmission: turn.publicationSubmission,
      runtime,
      client,
      nativeRuntimeId,
      abort: new AbortController(),
    };
    startCompletionRunner(turn);
  }

  function startCompletionRunner(turn: CompletionState): void {
    if (turn.completionRunner) return;
    turn.completionRunner = runCompletion(turn).finally(() => {
      turn.completionRunner = undefined;
      if (turn.completion && input.isActive()) startCompletionRunner(turn);
    });
  }

  async function optionalStep(
    turn: CompletionState,
    request: CompletionRequest,
    run: (client: WrapperKiloClient, signal: AbortSignal) => Promise<void>
  ): Promise<void> {
    const operation: OptionalOperation = { request, abort: new AbortController() };
    turn.operation = operation;
    const timer = scheduler.setTimeout(
      () => operation.abort.abort(new Error('finalization timed out')),
      DEFAULT_CONDENSE_TIMEOUT_MS
    );
    try {
      await cancellable(run(request.client, operation.abort.signal), operation.abort.signal);
    } catch (error) {
      if (input.isActive()) input.warn(error instanceof Error ? error.message : String(error));
    } finally {
      scheduler.clearTimeout(timer);
      if (turn.operation === operation) turn.operation = undefined;
    }
  }

  async function runCompletion(turn: CompletionState): Promise<void> {
    while (turn.completion && input.isActive()) {
      const request = turn.completion;
      try {
        const confirmed = turn.nativeProof === request;
        if (!confirmed) {
          await cancellable(
            Promise.all([request.delivery, request.publicationSubmission]),
            request.abort.signal
          );
          if (!isCurrent(turn, request) || !ownsNativeClient(turn, request)) continue;
          const drained = await drainNativeWork(turn, request);
          if (!isCurrent(turn, request) || !ownsNativeClient(turn, request)) continue;
          if (drained.state === 'failed') {
            input.warn(`Session completion was not confirmed: ${drained.reason}`);
            input.outcome('failed', 'no_outcome');
            return;
          }
          if (drained.state !== 'drained') continue;
          turn.nativeProof = request;
        }
        const failure = turn.publication?.failure();
        if (failure !== undefined) {
          input.nativeFailure(failure);
          return;
        }
        if (turn.publication?.recover()) continue;
        if (!isCurrent(turn, request)) continue;
        input.finalizing();
        if (
          ownsNativeClient(turn, request) &&
          turn.prompts.some(entry => entry.payload.finalization?.autoCommit)
        )
          await optionalStep(turn, request, input.autoCommit);
        if (!isCurrent(turn, request)) continue;
        if (
          ownsNativeClient(turn, request) &&
          turn.prompts.some(entry => entry.payload.finalization?.condenseOnComplete)
        )
          await optionalStep(turn, request, input.condense);
        if (isCurrent(turn, request)) input.outcome('completed');
      } catch (error) {
        if (request.publicationSubmission && isCurrent(turn, request)) {
          invalidateCompletion(turn);
        } else if (isCurrent(turn, request) && ownsNativeClient(turn, request)) {
          input.warn(`Session completion was not confirmed: ${String(error)}`);
          input.outcome('failed', 'no_outcome');
        }
      } finally {
        if (turn.completion === request) turn.completion = undefined;
        request.abort.abort();
        request.waiter?.cancel();
      }
    }
  }

  /** Dispatched prompts after the one the native proof, or else the latest root close, covers. */
  function dispatchedAfter(turn: CompletionState, covered?: PendingPrompt): PendingPrompt[] {
    const through = Math.max(
      turn.nativeProof ? turn.prompts.indexOf(turn.nativeProof.tail) : -1,
      covered ? turn.prompts.indexOf(covered) : -1
    );
    return turn.prompts.slice(through + 1).filter(entry => entry.dispatched);
  }

  /** Kilo was handed work that no native proof covers yet. */
  function hasUnconfirmedWork(turn: CompletionState): boolean {
    return (
      dispatchedAfter(turn).length > 0 ||
      (turn.publicationSubmission !== undefined &&
        turn.nativeProof?.publicationSubmission !== turn.publicationSubmission)
    );
  }

  /** The publication submission was handed to Kilo, and no close has shown it yet. */
  function publicationUnclosed(turn: CompletionState): boolean {
    return (
      turn.publicationCleanup === undefined &&
      turn.publicationSubmission !== undefined &&
      turn.completion?.publicationSubmission !== turn.publicationSubmission &&
      turn.nativeProof?.publicationSubmission !== turn.publicationSubmission
    );
  }

  /**
   * The reconcile shows nothing the gap can hide. Either the root's execution continues, or the
   * root was idle and its tree's executions are all still live, so nothing ended to wake it. An
   * idle root closes observed work, so observed work without a seen close is hidden. Work that no
   * observation or close has shown must still be running at the root.
   */
  function gapHidNoWork(turn: CompletionState, gap: FeedGap, after: number[]): boolean {
    if (gap.tree === undefined) return false;
    const root = input.runtime()?.sessionState(turn.route.kiloSessionId)?.execution;
    if (gap.root !== undefined) return root === gap.root;
    if (!gap.tree.every(execution => after.includes(execution))) return false;
    const unclosed = dispatchedAfter(turn, turn.closedThrough);
    if (unclosed.some(entry => entry.nativeObserved)) return false;
    return root !== undefined || (unclosed.length === 0 && !publicationUnclosed(turn));
  }

  /** Decides a gap after the same process reconciles; returns whether the turn failed. */
  function settleGap(turn: CompletionState): boolean {
    const gap = turn.gap;
    const runtime = input.runtime();
    if (gap === undefined || runtime?.nativeRuntimeId !== gap.nativeRuntimeId) return false;
    const after = runtime.liveTreeExecutions(turn.route.kiloSessionId);
    if (after === undefined) return false;
    turn.gap = undefined;
    if (gapHidNoWork(turn, gap, after) || !hasUnconfirmedWork(turn)) return false;
    input.warn(
      `Session completion history is incomplete: native event feed interrupted (${gap.nativeRuntimeId})`
    );
    input.outcome('failed', 'no_outcome');
    return true;
  }

  async function cleanupPublication(turn: CompletionState): Promise<void> {
    const origin = turn.publicationOrigin;
    if (!origin || turn.publicationCleanup) return;
    const pending = turn.completion;
    invalidateCompletion(turn);
    if (turn.prompts.at(-1) !== origin.tail) {
      turn.publicationSubmission = Promise.resolve();
      if (pending && pending.tail === turn.prompts.at(-1))
        requestCompletion(turn, pending.nativeRuntimeId);
      return;
    }
    if (!ownsNativeClient(turn, origin)) return;
    const request: CompletionRequest = {
      ...origin,
      abort: new AbortController(),
      pair: undefined,
      waiter: undefined,
    };
    const barrier = Promise.withResolvers<void>();
    const cleanup = { request, release: () => barrier.resolve() };
    turn.publicationCleanup = cleanup;
    // Reserve dispatch ordering synchronously before the whole-session abort starts.
    input.reserveDelivery(barrier.promise);
    const timer = scheduler.setTimeout(
      () => request.abort.abort(new Error('Publication cleanup abort was not confirmed')),
      10_000
    );
    try {
      const aborted = await cancellable(
        request.client.abortSession({
          sessionId: turn.route.kiloSessionId,
          directory: turn.route.directory,
          signal: request.abort.signal,
        }),
        request.abort.signal
      );
      scheduler.clearTimeout(timer);
      if (!aborted) throw new Error('Publication cleanup abort was not confirmed');
      if (!ownsNativeClient(turn, request) || !input.isActive()) return;
      const drained = await drainNativeWork(turn, request, 10_000);
      if (!ownsNativeClient(turn, request) || !input.isActive()) return;
      if (drained.state !== 'drained')
        throw new Error('Publication cleanup native completion was not confirmed');
      turn.publicationSubmission = undefined;
      turn.publicationCleanup = undefined;
      barrier.resolve();
      // The cleanup cannot await the submission chain that contains its own barrier.
      queueMicrotask(() => {
        if (input.isActive() && turn.prompts.at(-1) === origin.tail)
          requestCompletion(turn, origin.nativeRuntimeId);
      });
    } catch (error) {
      if (input.isActive() && ownsNativeClient(turn, request)) {
        input.warn(error instanceof Error ? error.message : String(error));
        input.outcome('failed', 'no_outcome');
      }
    } finally {
      scheduler.clearTimeout(timer);
      request.abort.abort();
      request.waiter?.cancel();
      if (ownsNativeClient(turn, request) || !input.isActive()) {
        if (turn.publicationCleanup === cleanup) turn.publicationCleanup = undefined;
        barrier.resolve();
      }
    }
  }

  return {
    /** A completed root close; it covers every prompt dispatched before it. */
    request(nativeRuntimeId: string) {
      turn.closedThrough = turn.prompts.findLast(entry => entry.dispatched);
      requestCompletion(turn, nativeRuntimeId);
    },
    invalidate() {
      invalidateCompletion(turn);
    },
    refresh() {
      if (settleGap(turn)) return;
      turn.completion?.pair?.refresh();
      turn.publicationCleanup?.request.pair?.refresh();
    },
    dispose() {
      turn.gap = undefined;
      turn.closedThrough = undefined;
      invalidateCompletion(turn);
      turn.operation?.abort.abort();
      turn.publicationCleanup?.request.abort.abort();
      turn.publicationCleanup?.release();
    },
    async submitPublication(signal: AbortSignal): Promise<void> {
      const runtime = input.runtime();
      if (!runtime) throw new Error('Kilo runtime unavailable');
      turn.publicationOrigin = turn.completion;
      invalidateCompletion(turn);
      const submission = cancellable(input.submitPublication(runtime.client, signal), signal);
      turn.publicationSubmission = submission;
      turn.publicationDelivery = submission;
      try {
        await submission;
      } finally {
        if (turn.publicationDelivery === submission) turn.publicationDelivery = undefined;
      }
    },
    cleanupPublication() {
      void cleanupPublication(turn);
    },
    observe(event: KiloFeedEvent): boolean {
      const cleanup = turn.publicationCleanup?.request;
      const request = cleanup ?? turn.completion;
      if (event.type === 'session.drained') {
        if (
          request &&
          event.nativeRuntimeId === request.nativeRuntimeId &&
          event.properties.token === request.pair?.token &&
          ownsNativeClient(turn, request)
        )
          request.pair?.marker();
        return true;
      }
      if (
        cleanup &&
        event.nativeRuntimeId === cleanup.nativeRuntimeId &&
        ((event.type === 'session.error' && isAssistantInterrupt(event.properties.error)) ||
          (event.type === 'session.turn.close' && event.properties.reason === 'interrupted') ||
          event.type === 'session.drain.interrupted')
      )
        return true;
      return false;
    },
    ownsOptionalFailure(event: KiloFeedEvent): boolean {
      const operation = turn.operation;
      return (
        operation !== undefined &&
        !turn.prompts
          .slice(turn.prompts.indexOf(operation.request.tail) + 1)
          .some(entry => entry.dispatched) &&
        (event.type === 'session.error' ||
          (event.type === 'session.turn.close' && event.properties.reason !== 'completed'))
      );
    },
    /**
     * Records the tree before the runtime marks observation lost. The turn waits for the same
     * process to reconcile; a restart decides instead.
     */
    onFeedInterrupted(nativeRuntimeId: string) {
      if (turn.gap !== undefined) return;
      const runtime = input.runtime();
      const root = turn.route.kiloSessionId;
      const tree = runtime?.liveTreeExecutions(root);
      turn.gap = {
        nativeRuntimeId,
        tree,
        root: tree === undefined ? undefined : runtime?.sessionState(root)?.execution,
      };
    },
    onRestart(reason: string): boolean {
      turn.gap = undefined;
      turn.closedThrough = undefined;
      turn.publicationCleanup?.request.abort.abort();
      turn.publicationCleanup?.release();
      turn.publicationCleanup = undefined;
      if (!turn.nativeProof) {
        invalidateCompletion(turn);
        return false;
      }
      if (turn.nativeProof.tail !== turn.prompts.at(-1)) input.outcome('failed', reason);
      else if (turn.nativeProof.publicationSubmission !== turn.publicationSubmission) {
        invalidateCompletion(turn);
        turn.publication?.dispose();
        turn.publicationSubmission = turn.nativeProof.publicationSubmission;
        turn.completion = {
          ...turn.nativeProof,
          abort: new AbortController(),
          waiter: undefined,
          pair: undefined,
        };
        turn.nativeProof = turn.completion;
        input.warn('Review publication recovery stopped after the native runtime restarted');
        startCompletionRunner(turn);
      }
      return true;
    },
    hasPendingWork() {
      return (
        turn.operation !== undefined ||
        turn.publicationCleanup !== undefined ||
        turn.publicationDelivery !== undefined ||
        turn.completion?.pair?.timed() === true ||
        turn.completion?.waiter?.waitingToRetry === true
      );
    },
  };
}
