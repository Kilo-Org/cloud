/**
 * Transient new-session route-param value that asks the form to open on the
 * Cloud Agent target regardless of the stored preference. The first-sign-in
 * tour's cloud path passes it so its "New session" action creates a cloud
 * session without wiping the person's saved run-on destination.
 */
export const PRESELECT_CLOUD_RUN_ON = 'cloud';

export function parseStoredRunOnDestination(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  return raw;
}

/**
 * Whether the new-session form should restore the persisted run-on
 * destination. An explicit Cloud Agent preselect (the tour's cloud path)
 * starts with no remote target and leaves the stored preference untouched;
 * every other entry keeps the existing restore behaviour.
 */
export function shouldRestorePersistedRunOn(
  preselectRunOn: string | string[] | undefined
): boolean {
  const value = Array.isArray(preselectRunOn) ? preselectRunOn[0] : preselectRunOn;
  return value !== PRESELECT_CLOUD_RUN_ON;
}

export function resolvePersistedRunOn<T extends { connectionId: string }>(
  storedConnectionId: string | null,
  instances: readonly T[]
): T | null {
  if (!storedConnectionId) {
    return null;
  }
  return instances.find(instance => instance.connectionId === storedConnectionId) ?? null;
}
