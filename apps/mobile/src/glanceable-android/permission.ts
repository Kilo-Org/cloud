/**
 * Notification-permission reader for the Android ongoing surface. The default
 * reads expo-notifications lazily so pure test suites never load React Native;
 * tests inject a synchronous reader instead.
 */

export type NotificationPermissionStatus = 'granted' | 'denied' | 'undetermined';

type PermissionReader = () => Promise<NotificationPermissionStatus>;

let permissionReader: PermissionReader | null = null;

async function defaultPermissionReader(): Promise<NotificationPermissionStatus> {
  // Lazy require keeps expo-notifications (→ expo-modules-core → RN) out of the
  // unit-test graph, matching the persist/deep-link-launch pattern.
  // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- lazy native load
  const { getNotificationPermissionStatus } = require('@/lib/notifications') as {
    getNotificationPermissionStatus: () => Promise<NotificationPermissionStatus>;
  };
  const status = await getNotificationPermissionStatus();
  return status;
}

export async function isNotificationPermissionGranted(): Promise<boolean> {
  const reader = permissionReader ?? defaultPermissionReader;
  const status = await reader();
  return status === 'granted';
}

/** Test-only: replace the reader so permission state is controllable per case. */
export function _setPermissionReaderForTests(reader: PermissionReader | null): void {
  permissionReader = reader;
}
