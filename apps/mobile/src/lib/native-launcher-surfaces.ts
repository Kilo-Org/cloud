import { requireOptionalNativeModule } from 'expo';

import { LAUNCHER_NEW_AGENT_URL } from '@/lib/launcher-surfaces';

/**
 * JS wrapper over the local `KiloLauncherSurfaces` native module: the launcher
 * shortcuts the OS shows on the app icon and the quick-settings tile. The
 * native side owns the platform mechanism (Android `ShortcutManager` plus the
 * tile service, iOS Home Screen Quick Actions) and the labels it publishes; the
 * JS side owns which actions exist and where they route.
 *
 * Every export is a silent no-op when the module is absent — an old
 * development client, or a Node test — and never throws into a render or an
 * auth transition.
 */

export const LAUNCHER_SURFACES_MODULE_NAME = 'KiloLauncherSurfaces';

export type LauncherSurfacesPayload = {
  newAgentUrl: string;
  newAgentLabel: string;
  needsInputUrl: string | null;
  needsInputLabel: string;
  openLastSessionUrl: string | null;
  openLastSessionLabel: string;
};

type LauncherSurfacesModule = {
  setSurfaces: (payloadJson: string) => void;
  clearDynamicSurfaces: () => void;
  /** iOS only: the Quick Action URL that launched a cold start, consumed once. */
  consumePendingLaunchUrl?: () => string | null;
};

const nativeModule = requireOptionalNativeModule<LauncherSurfacesModule>(
  LAUNCHER_SURFACES_MODULE_NAME
);

export const isNativeLauncherSurfacesAvailable: boolean = nativeModule !== null;

/** Publish the shortcut set. A null URL omits that shortcut on both platforms. */
export function publishLauncherSurfaces(payload: LauncherSurfacesPayload): void {
  try {
    nativeModule?.setSurfaces(JSON.stringify(payload));
  } catch {
    // Best effort: an absent or older native side keeps the static shortcuts.
  }
}

/** The sign-out path: drop the dynamic shortcuts that leak the prior account. */
export function clearLauncherSurfaces(): void {
  try {
    nativeModule?.clearDynamicSurfaces();
  } catch {
    // Best effort: sign-out must complete even when the native clear fails.
  }
}

/**
 * The launch URL a Quick Action cold start left behind, or null. Android has
 * no such function: the tile and shortcut intents arrive as deep links.
 */
export function consumePendingLaunchUrl(): string | null {
  try {
    return nativeModule?.consumePendingLaunchUrl?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * Read-and-clear the parked launch URL when it names a destination that belongs
 * to no account.
 *
 * A Quick Action tapped while the app is signed out parks its URL natively, and
 * the signed-in launcher mount is the only reader. The value is read and
 * cleared here so the caller owns it; only the destination that names no
 * account is returned, and every other value is left to the surfaces it came
 * from.
 */
export function takeAccountIndependentLaunchUrl(): string | null {
  const url = consumePendingLaunchUrl();
  return url === LAUNCHER_NEW_AGENT_URL ? url : null;
}
