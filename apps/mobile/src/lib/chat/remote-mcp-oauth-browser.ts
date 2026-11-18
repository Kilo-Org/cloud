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

/** The Android sign-ins waiting for their redirect, by the `state` their authorization carried. */
const waiting = new Map<string, (redirect: string) => void>();

/** The `state` an authorization URL was built with; null when it carries none. */
function authorizationState(authorizationUrl: string): string | null {
  try {
    return new URL(authorizationUrl).searchParams.get('state');
  } catch {
    return null;
  }
}

function redirectOf(path: string): URL | undefined {
  try {
    const url = new URL(path, REMOTE_MCP_REDIRECT_URL);
    return url.protocol === 'kiloapp:' && url.pathname === '/remote-mcp' ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Takes a deep link to the redirect path, and answers whether it was one. A
 * redirect whose `state` matches no waiting sign-in is dropped: handing it to
 * whatever is waiting would complete a different authorization with it.
 */
export function takeRemoteMcpRedirect(path: string): boolean {
  const url = redirectOf(path);
  if (url === undefined) {
    return false;
  }
  const state = url.searchParams.get('state');
  if (state !== null) {
    waiting.get(state)?.(url.href);
  }
  return true;
}

async function openOnAndroid(authorizationUrl: string): Promise<string | null> {
  const state = authorizationState(authorizationUrl);
  if (state === null) {
    /* No `state` is no correlation: serving the redirect back would complete a
       sign-in the app cannot attribute to this request. */
    throw new Error('The authorization request carried no state.');
  }
  const redirected = Promise.withResolvers<string | null>();
  const mine = (redirect: string): void => {
    redirected.resolve(redirect);
  };
  waiting.set(state, mine);
  const returned = Promise.withResolvers<null>();
  const subscription = AppState.addEventListener('change', next => {
    if (next === 'active') {
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
    if (waiting.get(state) === mine) {
      waiting.delete(state);
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
