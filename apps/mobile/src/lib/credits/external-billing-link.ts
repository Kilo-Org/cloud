import { Platform } from 'react-native';

/**
 * Whether this platform may offer an in-app link to an external billing or
 * purchase page.
 *
 * App Store review forbids an iOS app from sending a reader to an external page
 * that sells or manages a payment the app could have sold in-app, while Play
 * permits it. Every surface that offers such a destination — the credit pack
 * action, the "manage billing" row — asks here rather than repeating the
 * platform comparison, so one rule keeps them consistent.
 */
export function canOpenExternalBilling(): boolean {
  return Platform.OS !== 'ios';
}
