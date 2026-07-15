import { classifyLocalSessionCreateError } from './local-session-create-errors';
import {
  completeHappyPath,
  type CreateAndRunResult,
  handlePromptPartial,
} from './local-session-create-effects';
import { pollReadinessUntilReady } from './local-session-create-polling';
import {
  type BuiltLocalSessionCreateRequest,
  LocalSessionCreateRequestError,
} from './local-session-create-request';
import { type LocalRuntimeFence } from './local-runtime-catalog-types';
import {
  extractErrorMessage,
  type LocalSessionCreateOrchestrator,
  type LocalSessionCreateOrchestratorDeps,
  type LocalSessionCreateOrchestratorInput,
  type LocalSessionCreateOrchestratorState,
  type LocalSessionCreateRecovery,
  readinessTimeoutRecovery,
  requestErrorToRecovery,
  withInFlightCleared,
} from './local-session-create-orchestrator-shared';

export type { LocalSessionCreateOrchestratorDeps } from './local-session-create-orchestrator-shared';
export { createLocalSessionCreateOrchestrator };

/**
 * Submission orchestrator for `localRuntimeControl.createAndRun`. Pure
 * state machine: every side effect is behind `deps`, every state
 * transition is a single `setState`. The orchestrator is consumed by the
 * React `useLocalSessionCreateOrchestrator` hook (which wires the real
 * tRPC, haptics, toast, router, and analytics) and by the test suite
 * (which wires fakes).
 *
 * Invariants enforced by tests:
 *
 * - `createAndRun` runs at most once per user attempt. Concurrent submits
 *   while a request is in flight are coalesced.
 * - The same fence + the same requestId reuses the same requestId. A
 *   fence change (runtimeId OR connectionId) clears the binding and the
 *   next attempt allocates a new UUID.
 * - `session_not_ready` triggers a bounded sequential poll of
 *   `pollReadiness` at `pollIntervalMs` up to `pollMaxMs`. Ready
 *   transitions to the happy path; timeout stores `sessionId` +
 *   requestId and exposes the `Check again` CTA which only polls.
 * - `promptStarted:false` (ready or session_not_ready) invalidates the
 *   session detail/list caches, surfaces the fixed safe info toast, and
 *   navigates to the session detail; no analytics, no success haptic.
 *   If invalidation itself throws, the orchestrator still navigates to
 *   the known session and surfaces the prompt-partial toast once.
 * - Every other thrown error is classified into one of the recovery
 *   categories with a precise CTA (or no CTA for non-retryable branches).
 *   The orchestrator surfaces the upstream error message exactly once
 *   through the shared `showError` seam; the React hook wires the same
 *   seam into the mutation's `onError` so the user always sees the
 *   upstream message exactly once.
 */
function createLocalSessionCreateOrchestrator(
  input: LocalSessionCreateOrchestratorInput
): LocalSessionCreateOrchestrator {
  const { deps, fence, catalog, selectedAgentSlug, selectedModel, getPrompt } = input;

  let state: LocalSessionCreateOrchestratorState = { phase: 'idle' };
  const inFlight: { current: Promise<LocalSessionCreateOrchestratorState> | null } = {
    current: null,
  };
  const listeners = new Set<(state: LocalSessionCreateOrchestratorState) => void>();

  function setState(next: LocalSessionCreateOrchestratorState) {
    state = next;
    for (const listener of listeners) {
      listener(state);
    }
  }

  function build(): BuiltLocalSessionCreateRequest {
    const requestId = deps.requestIdStore.getOrAcquire(fence);
    return deps.buildRequest({
      fence,
      catalog,
      selectedAgentSlug,
      selectedModel,
      prompt: getPrompt(),
      requestId,
    });
  }

  function withRequestId(requestId: string): BuiltLocalSessionCreateRequest {
    return deps.buildRequest({
      fence,
      catalog,
      selectedAgentSlug,
      selectedModel,
      prompt: getPrompt(),
      requestId,
    });
  }

  function reportErrorAndRecovery(
    error: unknown,
    fallbackRequestId: string | null
  ): LocalSessionCreateOrchestratorState {
    const message = extractErrorMessage(error);
    deps.showError(message);
    const recovery = classifyLocalSessionCreateError(error);
    const shouldClear = recovery.kind === 'fence-changed';
    if (shouldClear) {
      deps.requestIdStore.clearByFence(fence);
    }
    return publishRecovery({
      recovery,
      sessionId: null,
      requestId: shouldClear ? null : fallbackRequestId,
      fence,
    });
  }

  function publishRecovery(args: {
    recovery: LocalSessionCreateRecovery;
    sessionId: string | null;
    requestId: string | null;
    fence: LocalRuntimeFence;
  }): LocalSessionCreateOrchestratorState {
    setState({ phase: 'recovery', ...args });
    return state;
  }

  function publishNavigated(): LocalSessionCreateOrchestratorState {
    setState({ phase: 'navigated' });
    return state;
  }

  async function completeHappySafe(sessionId: string): Promise<void> {
    try {
      await completeHappyPath(sessionId, {
        captureEvent: deps.captureEvent,
        invalidateCaches: deps.invalidateCaches,
        notificationHaptic: deps.notificationHaptic,
        navigate: deps.navigate,
      });
    } finally {
      deps.requestIdStore.markSuccess(fence);
    }
  }

  async function handlePromptPartialSafe(sessionId: string): Promise<void> {
    try {
      await handlePromptPartial(sessionId, {
        invalidateCaches: deps.invalidateCaches,
        showInfo: deps.showInfo,
        navigate: deps.navigate,
      });
    } finally {
      deps.requestIdStore.markSuccess(fence);
    }
  }

  async function pollReadinessFor(sessionId: string): Promise<boolean> {
    const ready = await pollReadinessUntilReady({
      sessionId,
      pollReadiness: deps.pollReadiness,
      sleep: deps.sleep,
      intervalMs: deps.pollIntervalMs,
      maxAttempts: Math.max(1, Math.floor(deps.pollMaxMs / deps.pollIntervalMs)),
    });
    return ready;
  }

  async function runCreate(): Promise<LocalSessionCreateOrchestratorState> {
    let request: BuiltLocalSessionCreateRequest | null = null;
    try {
      request = build();
    } catch (error) {
      if (error instanceof LocalSessionCreateRequestError) {
        const recovery = requestErrorToRecovery(error);
        if (recovery.kind === 'catalog-changed') {
          deps.requestIdStore.clearByFence(fence);
        }
        return publishRecovery({
          recovery,
          sessionId: null,
          requestId: null,
          fence,
        });
      }
      throw error;
    }
    const result = await runAttempt(request);
    return result;
  }

  async function runAttempt(
    request: BuiltLocalSessionCreateRequest
  ): Promise<LocalSessionCreateOrchestratorState> {
    const result = await runAttemptInner(request);
    return result;
  }

  async function runAttemptInner(
    request: BuiltLocalSessionCreateRequest
  ): Promise<LocalSessionCreateOrchestratorState> {
    let result: CreateAndRunResult | null = null;
    try {
      result = await deps.createAndRun(request);
    } catch (error) {
      return reportErrorAndRecovery(error, request.request.requestId);
    }

    const sessionId = result.result.sessionId;
    const requestId = request.request.requestId;

    if (!result.result.promptStarted) {
      await handlePromptPartialSafe(sessionId);
      return publishNavigated();
    }

    if (result.status === 'ready') {
      await completeHappySafe(sessionId);
      return publishNavigated();
    }

    const ready = await pollReadinessFor(sessionId);
    if (ready) {
      await completeHappySafe(sessionId);
      return publishNavigated();
    }

    return publishRecovery({
      recovery: readinessTimeoutRecovery(),
      sessionId,
      requestId,
      fence,
    });
  }

  async function runRetry(requestId: string): Promise<LocalSessionCreateOrchestratorState> {
    let request: BuiltLocalSessionCreateRequest | null = null;
    try {
      request = withRequestId(requestId);
    } catch (error) {
      if (error instanceof LocalSessionCreateRequestError) {
        return publishRecovery({
          recovery: requestErrorToRecovery(error),
          sessionId: null,
          requestId,
          fence,
        });
      }
      throw error;
    }
    const result = await runAttempt(request);
    return result;
  }

  async function runCheckAgain(
    sessionId: string,
    requestId: string
  ): Promise<LocalSessionCreateOrchestratorState> {
    const probe = await deps.pollReadiness({ sessionId });
    if (probe.status === 'ready') {
      await completeHappySafe(sessionId);
      return publishNavigated();
    }
    return publishRecovery({
      recovery: readinessTimeoutRecovery(),
      sessionId,
      requestId,
      fence,
    });
  }

  async function runGuarded(
    action: () => Promise<LocalSessionCreateOrchestratorState>
  ): Promise<LocalSessionCreateOrchestratorState> {
    if (inFlight.current) {
      const result = await inFlight.current;
      return result;
    }
    setState({ phase: 'submitting' });
    const promise = action();
    inFlight.current = promise;
    const result = await withInFlightCleared(inFlight, promise);
    return result;
  }

  return {
    submit: async () => {
      const result = await runGuarded(runCreate);
      return result;
    },
    retry: async () => {
      if (state.phase !== 'recovery') {
        return state;
      }
      const requestId = state.requestId;
      if (!requestId) {
        const result = await runGuarded(runCreate);
        return result;
      }
      const result = await runGuarded(async () => {
        const inner = await runRetry(requestId);
        return inner;
      });
      return result;
    },
    checkAgain: async () => {
      if (state.phase !== 'recovery' || state.recovery.kind !== 'readiness-timeout') {
        return state;
      }
      const { sessionId, requestId } = state;
      if (!sessionId || !requestId) {
        return state;
      }
      const result = await runGuarded(async () => {
        const inner = await runCheckAgain(sessionId, requestId);
        return inner;
      });
      return result;
    },
    getState: () => state,
    subscribe: listener => {
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
