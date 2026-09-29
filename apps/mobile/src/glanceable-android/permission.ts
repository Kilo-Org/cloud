/**
 * Notification-permission reader and requester for the Android ongoing surface.
 * The defaults reach expo-notifications lazily so pure test suites never load
 * React Native; tests inject synchronous functions instead.
 */

export type NotificationPermissionStatus = 'granted' | 'denied' | 'undetermined';

type PermissionReader = () => Promise<NotificationPermissionStatus>;
type PermissionRequester = () => Promise<NotificationPermissionStatus>;

let permissionReader: PermissionReader | null = null;
let permissionRequester: PermissionRequester | null = null;

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

async function defaultPermissionRequester(): Promise<NotificationPermissionStatus> {
  // Lazy require keeps expo-notifications out of the unit-test graph, matching
  // the reader above.
  // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- lazy native load
  const { requestNotificationPermissionStatus } = require('@/lib/notifications') as {
    requestNotificationPermissionStatus: () => Promise<NotificationPermissionStatus>;
  };
  const status = await requestNotificationPermissionStatus();
  return status;
}

/**
 * The raw permission status. Distinct from `isNotificationPermissionGranted`
 * because `undetermined` (never asked) must take the OS prompt path, while only
 * a real `denied` sends the user to Settings.
 */
export async function getNotificationPermissionStatus(): Promise<NotificationPermissionStatus> {
  const reader = permissionReader ?? defaultPermissionReader;
  const status = await reader();
  return status;
}

export async function isNotificationPermissionGranted(): Promise<boolean> {
  return (await getNotificationPermissionStatus()) === 'granted';
}

/**
 * Ask the OS for the notification permission, the same live request the
 * Notifications screen enable flow makes. Used when the status is
 * `undetermined`, where a Settings deep link would be wrong.
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionStatus> {
  const requester = permissionRequester ?? defaultPermissionRequester;
  const status = await requester();
  return status;
}

/** Test-only: replace the reader so permission state is controllable per case. */
export function _setPermissionReaderForTests(reader: PermissionReader | null): void {
  permissionReader = reader;
}

/** Test-only: replace the requester so the OS prompt is controllable per case. */
export function _setPermissionRequesterForTests(requester: PermissionRequester | null): void {
  permissionRequester = requester;
}
