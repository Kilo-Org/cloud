import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

import { PRODUCTION_HOSTS } from '@/lib/url-contract';

/**
 * Which browser API presents the device-auth page. The flow ends on the poll's
 * approval rather than on the page's redirect, so the page must be closed from
 * here, and only the API that opened it can close it: `dismissAuthSession` does
 * nothing to a plain browser.
 */
export type AuthBrowserKind = 'auth-session' | 'plain-browser';

// iOS's ASWebAuthenticationSession raises a consent alert naming the auth URL's
// host ("<App>" Wants to Use "<host>" to Sign In). On a non-product host — a
// dev or preview stack — that alert shows the user a raw developer address
// instead of a domain they can recognize as Kilo, so only open the native auth
// session when the host is a product host. Otherwise present
// SFSafariViewController via openBrowserAsync: it shares Safari's cookies (an
// existing web session still applies) and raises no consent alert. The flow
// polls the server for approval and never consumes the session redirect, so
// nothing else changes. Android keeps openBrowserAsync because
// expo-web-browser's openAuthSessionAsync polyfill can get stuck (KILO-APP-22).
function isProductAuthHost(url: string): boolean {
  try {
    return PRODUCTION_HOSTS.includes(new URL(url).hostname);
  } catch {
    // An unparseable URL cannot be recognized as a product host, so avoid the
    // consent alert and fall back to the plain browser.
    return false;
  }
}

export function resolveAuthBrowserKind(url: string): AuthBrowserKind {
  return Platform.OS === 'android' || !isProductAuthHost(url) ? 'plain-browser' : 'auth-session';
}

export async function openAuthBrowser(url: string): Promise<void> {
  await (resolveAuthBrowserKind(url) === 'plain-browser'
    ? WebBrowser.openBrowserAsync(url)
    : WebBrowser.openAuthSessionAsync(url));
}

/**
 * Close the page the flow opened, with the API that matches it. Android opened
 * a Chrome custom tab, which the user returns from with the back gesture, and
 * the flow has never dismissed it from the app.
 */
export function dismissAuthBrowser(kind: AuthBrowserKind): void {
  if (kind === 'auth-session') {
    WebBrowser.dismissAuthSession();
    return;
  }
  if (Platform.OS === 'ios') {
    void WebBrowser.dismissBrowser();
  }
}
