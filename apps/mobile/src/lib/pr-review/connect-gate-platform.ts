// Pure/hook selection for every external-auth flow's platform branch (PR
// review connect gate, security-agent setup, provider connect card). Extracted
// so the platform choice (which browser launcher + which refetch trigger) can
// be unit-tested without pulling in the full React component tree.

import * as WebBrowser from 'expo-web-browser';

type AuthLauncher = 'openAuthSession' | 'openBrowser';

type GateRefetchTrigger = 'sheet-close' | 'app-foreground';

type ConnectGatePlatformPlan = {
  launcher: AuthLauncher;
  refetchTrigger: GateRefetchTrigger;
};

/**
 * Maps a React Native platform to the browser launcher and refetch trigger
 * the connect gate should use after the auth session ends.
 *
 *  - iOS: `openAuthSessionAsync` returns when the sheet closes, so we
 *    refetch on `sheet-close`. No foreground listener needed.
 *  - Android: `openBrowserAsync` is fire-and-forget (no callback when the
 *    user finishes), so we wait for the app to return to foreground and
 *    refetch then. Same pattern as `use-device-auth.ts` ~:34-42.
 */
export function getConnectGatePlatformPlan(platform: string): ConnectGatePlatformPlan {
  if (platform === 'ios') {
    return { launcher: 'openAuthSession', refetchTrigger: 'sheet-close' };
  }
  return { launcher: 'openBrowser', refetchTrigger: 'app-foreground' };
}

/**
 * Opens the authorization URL with the platform-appropriate launcher and
 * resolves with the trigger the caller should use to refetch the
 * authorization query. Kept as a single helper so the gate component
 * doesn't have to know which platform maps to which API.
 */
export async function openAuthorizationAndWaitForReturn(
  platform: string,
  authorizationUrl: string
): Promise<GateRefetchTrigger> {
  const plan = getConnectGatePlatformPlan(platform);
  await (plan.launcher === 'openAuthSession'
    ? WebBrowser.openAuthSessionAsync(authorizationUrl)
    : WebBrowser.openBrowserAsync(authorizationUrl));
  return plan.refetchTrigger;
}

type ConnectGateLaunchHandlers = {
  /** Arms the foreground-return sentinel before the browser opens (Android). */
  markLaunched: () => void;
  /** Disarms the sentinel once it is consumed, or the launch failed. */
  clearLaunch: () => void;
  /** Runs the caller's refetch on the iOS `sheet-close` trigger. */
  onSheetClose: () => Promise<void>;
  /** The browser failed to open: tell the user instead of leaving the CTA inert. */
  onOpenFailure: () => void;
};

/**
 * Runs one external-auth launch for a connect gate: arms the launch sentinel,
 * opens the URL with the platform launcher, and on iOS's `sheet-close` trigger
 * clears the sentinel and refetches. A browser that fails to open clears the
 * sentinel and calls `onOpenFailure`, so the Connect control never looks inert
 * (no browser, no progress, no error). The sentinel is cleared on every
 * terminal path, so a later unrelated foreground cannot stray-refetch.
 *
 * Never rejects on a launch failure; `onSheetClose` errors propagate to the
 * caller.
 */
export async function launchConnectGateBrowser(
  platform: string,
  authorizationUrl: string,
  handlers: ConnectGateLaunchHandlers
): Promise<void> {
  handlers.markLaunched();
  // `null` is the launch-failure sentinel: `openAuthorizationAndWaitForReturn`
  // only rejects when the browser itself could not be opened, so converting
  // the rejection to a value keeps the failure branch explicit and lets the
  // success path stay flat.
  const trigger = await openAuthorizationAndWaitForReturn(platform, authorizationUrl).catch(
    () => null
  );
  if (trigger === null) {
    handlers.clearLaunch();
    handlers.onOpenFailure();
    return;
  }
  if (trigger === 'sheet-close') {
    handlers.clearLaunch();
    await handlers.onSheetClose();
  }
}
