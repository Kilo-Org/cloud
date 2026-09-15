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
 * The new-session route's explicit Run-on preselection, normalised to a single
 * value. `null` means the route named no target (absent or empty), so the form
 * restores the stored preference; any other value is either the Cloud Agent
 * sentinel or a connection id to preselect. Expo Router hands a repeated param
 * over as an array, so the first element wins.
 */
export function readPreselectRunOn(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) {
    return null;
  }
  return value;
}

/**
 * Whether the new-session form should restore the persisted run-on
 * destination. Any explicit preselect — the tour's Cloud Agent path or a
 * connected computer — starts on the named target and leaves the stored
 * preference untouched; an ordinary entry (no preselect) keeps the existing
 * restore behaviour.
 */
export function shouldRestorePersistedRunOn(
  preselectRunOn: string | string[] | undefined
): boolean {
  return readPreselectRunOn(preselectRunOn) === null;
}

/**
 * Resolves a stored or preselected connection id against the live instance
 * list so the form binds the real row (with its capabilities) or falls back to
 * Cloud Agent when the computer is disconnected. The connection preselect and
 * the stored-preference restore both resolve through here.
 */
export function resolvePersistedRunOn<T extends { connectionId: string }>(
  storedConnectionId: string | null,
  instances: readonly T[]
): T | null {
  if (!storedConnectionId) {
    return null;
  }
  return instances.find(instance => instance.connectionId === storedConnectionId) ?? null;
}
