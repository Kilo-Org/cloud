// Pure/hook selection for the connect-gate's platform branch. Extracted so
// the platform choice (which browser launcher + which refetch trigger) can
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
