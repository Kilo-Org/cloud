/**
 * Focused post-create side effects for the `createAndRun` orchestrator.
 *
 * The hooks layer wires `deps.invalidateCaches` to the four-path
 * `invalidateAgentSessionQueries` helper (see `agent-session-cache.ts`);
 * the orchestrator therefore calls `invalidateCaches` exactly once on the
 * happy path and once on the prompt-partial path so the new session can
 * resolve on the detail/list screens.
 */
export const SESSION_CREATED_EVENT = 'session_created';
export const SESSION_CREATED_EVENT_SURFACE = 'remote-session';
export const SESSION_DETAIL_PATH_PREFIX = '/(app)/agent-chat/';

export type HapticKind = 'success' | 'warning' | 'error';

export type CreateAndRunResult =
  | { status: 'ready'; result: ReadyResult }
  | {
      status: 'session_not_ready';
      code: 'SESSION_NOT_READY';
      result: ReadyResult;
    };

export type ReadyResult =
  | { protocolVersion: 1; sessionId: string; promptStarted: true }
  | {
      protocolVersion: 1;
      sessionId: string;
      promptStarted: false;
      error: { code: 'PROMPT_START_FAILED'; message: string };
    };

type CompleteHappyPathDeps = {
  captureEvent: (name: string, properties: Record<string, unknown>) => void;
  invalidateCaches: () => Promise<void>;
  notificationHaptic: (kind: HapticKind) => void;
  navigate: (path: string) => void;
};

/**
 * Execute the happy-path side effects for a successfully created session.
 *
 * Order: invalidate caches → capture analytics → fire success haptic →
 * navigate. The order is deliberate: a stale detail or list must not
 * race the navigation. Cache invalidation must be awaited before the
 * navigate so the next render can refetch the new row in the same
 * network round-trip.
 */
export async function completeHappyPath(
  sessionId: string,
  deps: CompleteHappyPathDeps
): Promise<void> {
  await deps.invalidateCaches();
  deps.captureEvent(SESSION_CREATED_EVENT, { surface: SESSION_CREATED_EVENT_SURFACE });
  deps.notificationHaptic('success');
  deps.navigate(`${SESSION_DETAIL_PATH_PREFIX}${sessionId}`);
}

export const PROMPT_PARTIAL_TOAST =
  'The session was created, but the first prompt did not start. Retry from the session composer.';

type HandlePromptPartialDeps = {
  invalidateCaches: () => Promise<void>;
  showInfo: (message: string) => void;
  navigate: (path: string) => void;
};

/**
 * Execute the prompt-partial side effects when the server reports
 * `promptStarted: false`. The session exists; we must invalidate the
 * detail/list caches so the next render can resolve, but the create was
 * not a success — no analytics, no success haptic. The fixed safe info
 * toast is shown exactly once. Cache invalidation, the info toast, and
 * navigation each fire exactly once on this branch — the helper
 * guarantees all three are attempted even if one throws so the user
 * always lands on the session detail with a consistent message.
 *
 * Returns the cache-invalidation outcome to the caller so the orchestrator
 * can capture test-visible state without exposing the raw error.
 */
export async function handlePromptPartial(
  sessionId: string,
  deps: HandlePromptPartialDeps
): Promise<{ invalidationFailed: boolean }> {
  let invalidationFailed = false;
  try {
    await deps.invalidateCaches();
  } catch {
    invalidationFailed = true;
  }
  deps.showInfo(PROMPT_PARTIAL_TOAST);
  deps.navigate(`${SESSION_DETAIL_PATH_PREFIX}${sessionId}`);
  return { invalidationFailed };
}
