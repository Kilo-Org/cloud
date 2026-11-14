import { useCallback, useSyncExternalStore } from 'react';

import { sessionById, sessionList, sessionsRehydrated, subscribeSessions } from './session-store';
import { type SshSession } from './types';

/** Every open session, oldest first. */
export function useSshSessions(): readonly SshSession[] {
  return useSyncExternalStore(subscribeSessions, sessionList, sessionList);
}

/**
 * Whether this runtime has finished adopting the sessions the native registry
 * kept. Until it has, a null from {@link useSshSession} means "not read yet".
 */
export function useSshSessionsRehydrated(): boolean {
  return useSyncExternalStore(subscribeSessions, sessionsRehydrated, sessionsRehydrated);
}

/** One session, or null once it has been closed and dropped. */
export function useSshSession(id: string): SshSession | null {
  const read = useCallback(() => sessionById(id), [id]);
  return useSyncExternalStore(subscribeSessions, read, read);
}
