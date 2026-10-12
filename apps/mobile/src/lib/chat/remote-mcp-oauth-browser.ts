import * as WebBrowser from 'expo-web-browser';
import { AppState, Platform } from 'react-native';

import { REMOTE_MCP_REDIRECT_URL } from './remote-mcp-oauth-provider';

/**
 * The browser a remote MCP sign-in runs in, and the redirect it ends on.
 *
 * iOS opens an auth session, which hands the redirect back itself. Android
 * opens a plain browser, because expo-web-browser's `openAuthSessionAsync`
 * polyfill keeps state that can get stuck and reject every later call
 * (KILO-APP-22); there the redirect arrives as a deep link, which
 * `+native-intent.tsx` hands to `takeRemoteMcpRedirect`.
 */

/**
 * How long a return to the app waits for the redirect. Android can report the
 * app active before it delivers the deep link that brought it back.
 */
const REDIRECT_GRACE_MS = 1500;

/** The one Android sign-in waiting for its redirect. A newer sign-in ends it as turned back. */
let deliver: ((url: string | null) => void) | undefined = undefined;

function redirectOf(path: string): URL | undefined {
  try {
    const url = new URL(path, REMOTE_MCP_REDIRECT_URL);
    return url.protocol === 'kiloapp:' && url.pathname === '/remote-mcp' ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Takes a deep link to the redirect path, and answers whether it was one. One
 * that arrives with no sign-in waiting is dropped: nothing can use its code.
 */
export function takeRemoteMcpRedirect(path: string): boolean {
  const url = redirectOf(path);
  if (url === undefined) {
    return false;
  }
  deliver?.(url.href);
  return true;
}

async function openOnAndroid(authorizationUrl: string): Promise<string | null> {
  const redirected = Promise.withResolvers<string | null>();
  deliver?.(null);
  const mine = redirected.resolve;
  deliver = mine;
  const returned = Promise.withResolvers<null>();
  const subscription = AppState.addEventListener('change', state => {
    if (state === 'active') {
      setTimeout(() => {
        returned.resolve(null);
      }, REDIRECT_GRACE_MS);
    }
  });
  try {
    await WebBrowser.openBrowserAsync(authorizationUrl);
    const answered = await Promise.race([redirected.promise, returned.promise]);
    return answered;
  } finally {
    subscription.remove();
    if (deliver === mine) {
      deliver = undefined;
    }
  }
}

/** Opens the authorization page and answers the redirect URL, or null when the person turned back. */
export async function openRemoteMcpAuthorization(authorizationUrl: string): Promise<string | null> {
  if (Platform.OS === 'android') {
    const answered = await openOnAndroid(authorizationUrl);
    return answered;
  }
  const result = await WebBrowser.openAuthSessionAsync(authorizationUrl, REMOTE_MCP_REDIRECT_URL);
  return result.type === 'success' ? result.url : null;
}
