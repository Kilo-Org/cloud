import { useCallback, useSyncExternalStore } from 'react';

import { sessionById, sessionList, subscribeSessions } from './session-store';
import  { type SshSession } from './types';

/** Every open session, oldest first. */
export function useSshSessions(): readonly SshSession[] {
  return useSyncExternalStore(subscribeSessions, sessionList, sessionList);
}

/** One session, or null once it has been closed and dropped. */
export function useSshSession(id: string): SshSession | null {
  const read = useCallback(() => sessionById(id), [id]);
  return useSyncExternalStore(subscribeSessions, read, read);
}
