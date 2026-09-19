import * as WebBrowser from 'expo-web-browser';
import { AppState, type AppStateStatus, Platform } from 'react-native';

/**
 * Subscribes to the next foreground return. The caller owns cleanup, including
 * when the launch fails or its wait is cancelled before the app returns.
 */
function waitForForeground() {
  let resolveReturn: (() => void) | undefined = undefined;
  const returned = new Promise<void>(resolve => {
    resolveReturn = resolve;
  });
  const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state !== 'active') {
      return;
    }
    resolveReturn?.();
  });
  return { returned, subscription };
}

/**
 * Opens the authorization URL and resolves once the user is back in the app.
 *
 * Android is the one platform branch: it has no native auth-session completion
 * callback, and expo-web-browser's `openAuthSessionAsync` polyfill keeps
 * module-level state that can get stuck and reject every later call
 * (KILO-APP-22), so Android opens a plain browser and resolves when the app
 * returns to the foreground instead. iOS keeps the native auth session, which
 * resolves when the sheet closes. Callers await the same promise on both.
 * Aborting ends the wait without closing the browser or auth session.
 */
export async function openAuthorizationAndWaitForReturn(
  authorizationUrl: string,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) {
    return;
  }
  let resolveCancellation: (() => void) | undefined = undefined;
  const cancelled = new Promise<void>(resolve => {
    resolveCancellation = resolve;
  });
  const onAbort = () => resolveCancellation?.();
  signal?.addEventListener('abort', onAbort);
  const foreground = Platform.OS === 'android' ? waitForForeground() : undefined;
  try {
    const opened = foreground
      ? WebBrowser.openBrowserAsync(authorizationUrl)
      : WebBrowser.openAuthSessionAsync(authorizationUrl);
    await Promise.race([opened, cancelled]);
    if (foreground && !signal?.aborted) {
      await Promise.race([foreground.returned, cancelled]);
    }
  } finally {
    foreground?.subscription.remove();
    signal?.removeEventListener('abort', onAbort);
  }
}

type ConnectGateLaunchHandlers = {
  signal?: AbortSignal;
  onReturn: () => Promise<void>;
  /** The browser failed to open: tell the user instead of leaving the CTA inert. */
  onOpenFailure: () => void;
};

/**
 * Launch failures are reported separately from refetch failures. Closing the
 * browser still refetches: the server-driven connection may have completed.
 * Aborting on unmount instead skips callbacks belonging to the stale caller.
 */
export async function launchConnectGateBrowser(
  authorizationUrl: string,
  handlers: ConnectGateLaunchHandlers
): Promise<void> {
  try {
    await openAuthorizationAndWaitForReturn(authorizationUrl, handlers.signal);
  } catch {
    if (!handlers.signal?.aborted) {
      handlers.onOpenFailure();
    }
    return;
  }
  if (!handlers.signal?.aborted) {
    await handlers.onReturn();
  }
}
