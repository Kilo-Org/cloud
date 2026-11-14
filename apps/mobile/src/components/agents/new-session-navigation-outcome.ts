/**
 * The new-session composer's place in the `(app)` stack, and how long a press
 * waits to see it there.
 *
 * `router.push` is fire-and-forget: expo-router dispatches the action and the
 * navigator either applies it or drops it. A push issued while the session
 * route is still settling can be dropped, and the caller then has no way to
 * tell an accepted navigation from a lost one. These helpers answer that
 * question from the navigation state the navigator already holds.
 */

/** The `(app)` stack's shape, as `navigation.getState()` reports it. */
export type AgentStackState = {
  index?: number;
  routes?: { name?: string }[];
};

/** The route the composer is registered under in `(app)/_layout.tsx`. */
const NEW_SESSION_ROUTE_NAME = 'agent-chat/new';

/**
 * How long a press waits for the composer to appear before it reports a
 * failure, measured from the press. The first read happens immediately; these
 * are the re-checks, and the last one is the answer.
 */
const COMPOSER_TOP_RECHECK_DELAYS_MS = [250, 650] as const;

/**
 * Whether a route name (or a full href, as tests and `push` payloads hold it)
 * names the new-session composer. `/(app)/agent-chat/new?cloneFrom…` and
 * `agent-chat/new` both do; `agent-chat/[session-id]` does not.
 */
export function isComposerRouteName(name: string | undefined): boolean {
  if (name === undefined) {
    return false;
  }
  const path = name.split('?')[0] ?? name;
  const segments = path
    .split('/')
    .filter(segment => segment !== '' && !(segment.startsWith('(') && segment.endsWith(')')));
  return segments.slice(-2).join('/') === NEW_SESSION_ROUTE_NAME;
}

/** Whether the composer is the route the person is looking at. */
export function composerOnTop(state: AgentStackState | undefined): boolean {
  if (state === undefined) {
    return false;
  }
  const index = state.index ?? (state.routes?.length ?? 0) - 1;
  return isComposerRouteName(state.routes?.[index]?.name);
}

/**
 * Resolve once the composer is the top route, or `false` when it never was
 * inside the wait. `sleep` is injected so a test can advance the wait without
 * timers.
 */
export async function awaitComposerTop(input: {
  readState: () => AgentStackState | undefined;
  sleep: (ms: number) => Promise<void>;
  delaysMs?: readonly number[];
}): Promise<boolean> {
  if (composerOnTop(input.readState())) {
    return true;
  }
  for (const delay of input.delaysMs ?? COMPOSER_TOP_RECHECK_DELAYS_MS) {
    // The re-checks are measured from the press, not from each other: they
    // must run in order, and a later one only runs if the earlier one missed.
    // eslint-disable-next-line no-await-in-loop -- sequential re-checks
    await input.sleep(delay);
    if (composerOnTop(input.readState())) {
      return true;
    }
  }
  return false;
}

/**
 * What one press of a composer entry point produced.
 *
 * `opened` — the navigator accepted the push and the composer is the route the
 * person now sees. `ignored` — the single-push guard answered this press, so
 * the press that owns the window is still the one landing. `failed` — the push
 * was dispatched and the composer never appeared: the navigator dropped it, or
 * the call raised. Only a caller that shows state of its own acts on this.
 */
export type NewSessionOpenOutcome = 'opened' | 'ignored' | 'failed';

/** Resolve after `ms`, for the composer re-checks `awaitComposerTop` runs. */
function delayMs(ms: number): Promise<undefined> {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setTimeout(() => {
    resolve(undefined);
  }, ms);
  return promise;
}

/**
 * Press an entry point that opens the composer, then read back whether the
 * composer arrived. A press the guard answered does not read anything back: it
 * belongs to the press that owns the window.
 *
 * `push` is the guarded push the screen already owns (`router.push` through
 * `useNewSessionNavigator`), and `readState` is that screen's navigator state.
 */
export async function openComposerWithOutcome(input: {
  /** Claim the single-push window. `false` means this press is not the first. */
  claim: () => boolean;
  /** Dispatch the navigation. */
  push: () => void;
  /** The `(app)` stack state the navigator holds right now. */
  readState: () => AgentStackState | undefined;
  sleep?: (ms: number) => Promise<void>;
  delaysMs?: readonly number[];
}): Promise<NewSessionOpenOutcome> {
  if (!input.claim()) {
    return 'ignored';
  }
  try {
    input.push();
  } catch {
    return 'failed';
  }
  const opened = await awaitComposerTop({
    readState: input.readState,
    sleep: input.sleep ?? delayMs,
    delaysMs: input.delaysMs,
  });
  return opened ? 'opened' : 'failed';
}
