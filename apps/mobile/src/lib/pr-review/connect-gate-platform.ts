import * as WebBrowser from 'expo-web-browser';
import { AppState, type AppStateStatus, Platform } from 'react-native';

type LaunchEdge<Result> =
  | { readonly edge: 'launched'; readonly result: Result }
  | { readonly edge: 'failed'; readonly error: unknown };

/**
 * The browser's own report as a settled value, so it can lose the race below
 * without leaving a rejection unobserved.
 */
async function launchSettled(
  authorizationUrl: string
): Promise<LaunchEdge<WebBrowser.WebBrowserResult | WebBrowser.WebBrowserAuthSessionResult>> {
  try {
    return {
      edge: 'launched',
      result:
        Platform.OS === 'android'
          ? await WebBrowser.openBrowserAsync(authorizationUrl)
          : await WebBrowser.openAuthSessionAsync(authorizationUrl),
    };
  } catch (error) {
    return { edge: 'failed', error };
  }
}

/** A bare completion signal as a distinguishable race edge. */
async function delayEdge<Edge extends string>(
  signal: Promise<unknown>,
  edge: Edge
): Promise<{ readonly edge: Edge }> {
  await signal;
  return { edge };
}

/**
 * Subscribes to the next foreground return. The caller owns cleanup, including
 * when the launch fails or its wait is cancelled before the app returns.
 *
 * Only a transition back from a non-active state counts: a stray `active`
 * delivery while the app never left (the first Android state echo) is not a
 * return to the app.
 */
function waitForForeground() {
  let resolveReturn: (() => void) | undefined = undefined;
  const returned = new Promise<void>(resolve => {
    resolveReturn = resolve;
  });
  let away = AppState.currentState !== 'active';
  const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state !== 'active') {
      away = true;
      return;
    }
    if (away) {
      resolveReturn?.();
    }
  });
  return { returned, subscription };
}

export type AuthorizationWait = {
  /**
   * The browser's own report, resolving with its result or `undefined` when the
   * browser failed. It stays pending while the browser is open, so a caller
   * whose wait ended on another edge can still learn the outcome.
   */
  readonly reported: Promise<
    WebBrowser.WebBrowserResult | WebBrowser.WebBrowserAuthSessionResult | undefined
  >;
  /** True when the browser's report is what ended the wait. */
  readonly settledByLaunch: boolean;
};

/**
 * Opens the authorization URL and resolves once the user is back in the app.
 *
 * The wait ends on whichever comes first: the browser reporting its own
 * dismissal, the app coming back to the foreground, or the caller aborting.
 *
 * The foreground subscription is what makes the wait bounded. On both platforms
 * it is the only edge the app itself produces when the user leaves the sheet;
 * the launch promise is the browser's report and the platform may never deliver
 * it (a sign-in sheet whose system consent was dismissed, a completion iOS
 * drops). Waiting on that report alone left callers in their "in progress"
 * state with no error and no retry. A plain browser resolves `opened` as soon as
 * it launches, so Android keeps awaiting the foreground edge afterwards.
 *
 * The report is returned either way: when a foreground edge wins, the sheet may
 * still complete afterwards, and the caller has to see that outcome.
 *
 * Android is the one platform branch left, and it exists because the platform
 * is missing a capability: it has no native auth-session completion callback.
 * expo-web-browser's Android `openAuthSessionAsync` fallback is a polyfill that
 * keeps module-level state which can get stuck and reject every later call
 * (KILO-APP-22), so Android opens a plain browser instead. Callers await the
 * same promise on both platforms, and aborting ends the wait without closing
 * the browser or auth session.
 */
export async function openAuthorizationAndWaitForReturn(
  authorizationUrl: string,
  signal?: AbortSignal
): Promise<AuthorizationWait> {
  if (signal?.aborted) {
    // Nothing to launch and nothing to report, so the caller stays silent.
    return { reported: Promise.resolve(undefined), settledByLaunch: false };
  }
  const launched = launchSettled(authorizationUrl);
  const reported = (async () => {
    const edge = await launched;
    return edge.edge === 'launched' ? edge.result : undefined;
  })();
  let resolveCancellation: (() => void) | undefined = undefined;
  const cancelled = new Promise<void>(resolve => {
    resolveCancellation = resolve;
  });
  const onAbort = () => resolveCancellation?.();
  signal?.addEventListener('abort', onAbort);
  const foreground = waitForForeground();
  try {
    // Every edge races as a settled value: a launch failure that loses the race
    // still has to reach the caller when it is the edge that ended the wait, and
    // a late one must not escape as an unhandled rejection.
    const first = await Promise.race([
      launched,
      delayEdge(cancelled, 'aborted'),
      delayEdge(foreground.returned, 'foreground'),
    ]);
    if (first.edge === 'aborted' || first.edge === 'foreground') {
      return { reported, settledByLaunch: false };
    }
    if (first.edge === 'failed') {
      throw first.error;
    }
    if (first.result.type === WebBrowser.WebBrowserResultType.OPENED) {
      await Promise.race([foreground.returned, cancelled]);
    }
    return { reported, settledByLaunch: true };
  } finally {
    foreground.subscription.remove();
    signal?.removeEventListener('abort', onAbort);
  }
}

type ConnectGateLaunchHandlers = {
  signal?: AbortSignal;
  onReturn: () => Promise<void>;
  /** The browser failed to open: tell the user instead of leaving the CTA inert. */
  onOpenFailure: () => void;
};

/** Resolves when the caller aborts, so a detached wait can end with it. */
function whenAborted(signal: AbortSignal | undefined): Promise<undefined> {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  if (signal === undefined) {
    // No caller to end it: this edge never fires.
    return promise;
  }
  if (signal.aborted) {
    resolve(undefined);
    return promise;
  }
  signal.addEventListener(
    'abort',
    () => {
      resolve(undefined);
    },
    { once: true }
  );
  return promise;
}

/**
 * Reports a launch that failed after the wait had already ended on another
 * edge.
 *
 * `openAuthorizationAndWaitForReturn` settles on whichever edge comes first, so
 * a foreground return can win while the browser is still reporting. When that
 * report turns out to be a failure, the caller's `catch` never ran and the user
 * saw no browser: without this report the action looks inert. Call it with the
 * wait a caller is not awaiting further, so a platform that never delivers a
 * report costs nothing and an aborted caller hears nothing.
 */
export function reportLateLaunchFailure(
  wait: AuthorizationWait,
  handlers: { signal?: AbortSignal; onFailure: () => void }
): void {
  if (wait.settledByLaunch || handlers.signal?.aborted) {
    return;
  }
  void (async () => {
    const reported = await Promise.race([wait.reported, whenAborted(handlers.signal)]);
    if (handlers.signal?.aborted) {
      return;
    }
    // A report is the browser's own outcome; `undefined` is the same launch
    // failure that would have thrown had it arrived first.
    if (reported === undefined) {
      handlers.onFailure();
    }
  })();
}

/**
 * Launch failures are reported separately from refetch failures. Closing the
 * browser still refetches: the server-driven connection may have completed.
 * Aborting on unmount instead skips callbacks belonging to the stale caller.
 *
 * When the app's own return edge ends the wait before the browser reports, the
 * sheet can still complete afterwards — a sign-in that succeeds after the user
 * was briefly back in the app. The status is refreshed again on that late
 * report, so a completed connection is never missed. That follow-up ends with
 * the caller's abort: nothing it would refresh is on screen once the caller is
 * gone.
 */
export async function launchConnectGateBrowser(
  authorizationUrl: string,
  handlers: ConnectGateLaunchHandlers
): Promise<void> {
  let wait: AuthorizationWait = { reported: Promise.resolve(undefined), settledByLaunch: true };
  try {
    wait = await openAuthorizationAndWaitForReturn(authorizationUrl, handlers.signal);
  } catch {
    if (!handlers.signal?.aborted) {
      handlers.onOpenFailure();
    }
    return;
  }
  if (!handlers.signal?.aborted) {
    await handlers.onReturn();
  }
  if (wait.settledByLaunch) {
    return;
  }
  void (async () => {
    const late = await Promise.race([wait.reported, whenAborted(handlers.signal)]);
    // An aborted caller wants nothing more: only a real dismissal or sign-in
    // after the fact is worth a read, and only a live caller hears a failure.
    if (handlers.signal?.aborted) {
      return;
    }
    if (late === undefined) {
      // The launch failed after the app's own return edge ended the wait, so
      // the caller's catch never ran and no browser ever appeared.
      handlers.onOpenFailure();
      return;
    }
    try {
      await handlers.onReturn();
    } catch {
      // The read's own error state carries the outcome to the screen.
    }
  })();
}
