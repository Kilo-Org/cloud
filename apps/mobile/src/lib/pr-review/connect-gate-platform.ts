import * as WebBrowser from 'expo-web-browser';
import { AppState, type AppStateStatus, Platform } from 'react-native';

/**
 * Subscribes to the next foreground return. The subscription comes back too so
 * a launch that fails before the app returns can drop the listener.
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
    subscription.remove();
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
 */
export async function openAuthorizationAndWaitForReturn(authorizationUrl: string): Promise<void> {
  if (Platform.OS !== 'android') {
    await WebBrowser.openAuthSessionAsync(authorizationUrl);
    return;
  }
  const { returned, subscription } = waitForForeground();
  try {
    await WebBrowser.openBrowserAsync(authorizationUrl);
  } catch (error) {
    subscription.remove();
    throw error;
  }
  await returned;
}

type ConnectGateLaunchHandlers = {
  onReturn: () => Promise<void>;
  /** The browser failed to open: tell the user instead of leaving the CTA inert. */
  onOpenFailure: () => void;
};

/**
 * Launch failures are reported separately from refetch failures. Cancellation
 * still refetches: the server-driven connection may have completed before close.
 */
export async function launchConnectGateBrowser(
  authorizationUrl: string,
  handlers: ConnectGateLaunchHandlers
): Promise<void> {
  try {
    await openAuthorizationAndWaitForReturn(authorizationUrl);
  } catch {
    handlers.onOpenFailure();
    return;
  }
  await handlers.onReturn();
}
