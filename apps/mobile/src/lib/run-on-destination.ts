export function parseStoredRunOnDestination(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  return raw;
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
