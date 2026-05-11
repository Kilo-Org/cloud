/**
 * Hook for polling active CLI sessions from the session-ingest worker.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import {
  cliConnectionDataSchema,
  heartbeatDataSchema,
  sessionsListDataSchema,
  type ActiveSessionWithConnectionData,
} from '@/lib/cloud-agent-sdk/schemas';
import { useUserWebConnection } from '../CloudAgentProvider';

export type ActiveSession = ActiveSessionWithConnectionData;

type CliConnectionPayload = {
  connectionId: string;
};

type RootHeartbeatPayload = {
  connectionId: string;
  sessions: ActiveSession[];
};

function isRootSession(session: { id: string; parentSessionId?: string | null }): boolean {
  return !session.parentSessionId;
}

export function getRootSessionsFromListPayload(value: unknown): ActiveSession[] | null {
  const parsed = sessionsListDataSchema.safeParse(value);
  if (!parsed.success) return null;
  return parsed.data.sessions.filter(isRootSession);
}

export function getRootSessionsFromHeartbeatPayload(value: unknown): RootHeartbeatPayload | null {
  const parsed = heartbeatDataSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    connectionId: parsed.data.connectionId,
    sessions: parsed.data.sessions
      .filter(isRootSession)
      .map(session => ({ ...session, connectionId: parsed.data.connectionId })),
  };
}

function getCliConnectionPayload(value: unknown): CliConnectionPayload | null {
  const parsed = cliConnectionDataSchema.safeParse(value);
  if (!parsed.success) return null;
  return parsed.data;
}

export function mergeActiveSessionsWithPollingFallback(
  liveSessions: ActiveSession[] | null,
  polledSessions: ActiveSession[]
): ActiveSession[] {
  if (liveSessions === null) return polledSessions;

  const merged = new Map<string, ActiveSession>();
  for (const session of liveSessions) {
    merged.set(session.id, session);
  }
  for (const session of polledSessions) {
    if (!merged.has(session.id)) {
      merged.set(session.id, session);
    }
  }
  return Array.from(merged.values());
}

export function useActiveSessions(): {
  activeSessions: ActiveSession[];
  isLoading: boolean;
} {
  const trpc = useTRPC();
  const sharedConnection = useUserWebConnection();
  const [liveSessions, setLiveSessions] = useState<ActiveSession[] | null>(null);
  const latestPolledSessionsRef = useRef<ActiveSession[]>([]);
  const activeSessionsQueryOptions = trpc.activeSessions.list.queryOptions();
  const { data, isLoading, refetch } = useQuery({
    ...activeSessionsQueryOptions,
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
  const polledRootSessions = useMemo(
    () => (data?.sessions ?? []).filter(isRootSession),
    [data?.sessions]
  );

  useEffect(() => {
    latestPolledSessionsRef.current = polledRootSessions;
  }, [polledRootSessions]);

  useEffect(() => {
    if (!sharedConnection) return;
    const refreshActiveSessions = () => {
      void refetch().then(result => {
        if (result.data?.sessions) setLiveSessions(result.data.sessions.filter(isRootSession));
      });
    };
    sharedConnection.connect();
    return sharedConnection.onSystemEvent(event => {
      if (event.event === 'sessions.list') {
        const sessions = getRootSessionsFromListPayload(event.data);
        if (sessions) setLiveSessions(sessions);
      }
      if (event.event === 'sessions.heartbeat') {
        const data = getRootSessionsFromHeartbeatPayload(event.data);
        if (data) {
          setLiveSessions(prev => {
            const baseSessions = prev ?? latestPolledSessionsRef.current;
            const sessionsFromOtherConnections = baseSessions.filter(
              s => s.connectionId !== data.connectionId
            );
            return [...data.sessions, ...sessionsFromOtherConnections];
          });
        }
      }
      if (event.event === 'cli.disconnected') {
        const data = getCliConnectionPayload(event.data);
        if (data) {
          setLiveSessions(prev => {
            const baseSessions = prev ?? latestPolledSessionsRef.current;
            return baseSessions.filter(s => s.connectionId !== data.connectionId);
          });
          refreshActiveSessions();
        }
      }
      if (event.event === 'cli.connected') {
        refreshActiveSessions();
      }
    });
  }, [refetch, sharedConnection]);

  return {
    activeSessions: mergeActiveSessionsWithPollingFallback(liveSessions, polledRootSessions),
    isLoading: liveSessions === null && isLoading,
  };
}
