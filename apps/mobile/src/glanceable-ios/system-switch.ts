import type * as ExpoWidgets from 'expo-widgets';
import { Platform } from 'react-native';

/**
 * The per-app "Live Activities" switch in Settings.
 *
 * ActivityKit refuses `start` when it is off, so the app used to learn the
 * state only from a failed start. Reading it directly lets the notifications
 * screen show the truth before anything is attempted.
 */
export function liveActivitiesAllowedBySystem(): boolean {
  if (Platform.OS !== 'ios') {
    return false;
  }
  try {
    // Lazy require keeps expo-widgets' native module out of the settings
    // screen's import graph, the same reason the sink registry defers Sentry.
    // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- lazy native load
    const { areLiveActivitiesEnabled } = require('expo-widgets') as typeof ExpoWidgets;
    return areLiveActivitiesEnabled();
  } catch {
    // An older binary without the patched native function: assume allowed and
    // let `start` be the authority, which is the behavior that shipped before.
    return true;
  }
}
