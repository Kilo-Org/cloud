'use client';

import { useLayoutEffect, useState } from 'react';
import type { KiloSessionId, SessionManager } from '@kilocode/cloud-agent-sdk';
import { useLocalSession, useLocalSessions } from './local-sessions/LocalSessionsProvider';
import type { LocalSession } from './local-sessions/local-session';

/**
 * Switches the manager to the requested chat. A chat created here connects
 * only once the server has it, and a reload waits until local sessions are
 * restored, because one of them may be this chat. Runs before paint, so a
 * reopened chat's cached page is on screen in the first frame.
 */
export function useSessionSwitch(
  manager: SessionManager,
  requestedSessionId: string | null
): { localSession: LocalSession | null; lastStartedSessionId: string | null } {
  const [lastStartedSessionId, setLastStartedSessionId] = useState<string | null>(null);
  const localSession = useLocalSession(requestedSessionId);
  const { restored } = useLocalSessions();
  const connectSessionId =
    localSession && localSession.sync.state !== 'synced' ? null : requestedSessionId;

  useLayoutEffect(() => {
    if (!restored) return;
    if (connectSessionId) {
      setLastStartedSessionId(connectSessionId);
      void manager.switchSession(connectSessionId as KiloSessionId);
    } else {
      setLastStartedSessionId(null);
      manager.destroy();
    }
  }, [connectSessionId, restored, manager]);

  return { localSession, lastStartedSessionId };
}
