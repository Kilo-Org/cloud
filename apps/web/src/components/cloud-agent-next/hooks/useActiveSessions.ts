/**
 * Hook for polling active CLI sessions from the session-ingest worker.
 */

import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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

export function applyActiveSessionsHeartbeat(
  currentSessions: ActiveSession[],
  payload: RootHeartbeatPayload
): ActiveSession[] {
  return [
    ...payload.sessions,
    ...currentSessions.filter(session => session.connectionId !== payload.connectionId),
  ];
}

export function removeActiveSessionsForConnection(
  currentSessions: ActiveSession[],
  connectionId: string
): ActiveSession[] {
  return currentSessions.filter(session => session.connectionId !== connectionId);
}

type ActiveSessionsQueryData = {
  sessions: ActiveSession[];
};

export function useActiveSessions(): {
  activeSessions: ActiveSession[];
  isLoading: boolean;
} {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const sharedConnection = useUserWebConnection();
  const activeSessionsQueryOptions = trpc.activeSessions.list.queryOptions();
  const activeSessionsQueryKey = useMemo(() => trpc.activeSessions.list.queryKey(), [trpc]);
  const { data, isLoading, refetch } = useQuery({
    ...activeSessionsQueryOptions,
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
  const activeSessions = useMemo(
    () => (data?.sessions ?? []).filter(isRootSession),
    [data?.sessions]
  );

  useEffect(() => {
    if (!sharedConnection) return;
    let pendingLiveUpdate = Promise.resolve();
    const updateCachedSessions = (
      update: (sessions: ActiveSession[]) => ActiveSession[],
      refetchAfterUpdate = false
    ) => {
      pendingLiveUpdate = pendingLiveUpdate.then(async () => {
        await queryClient.cancelQueries({ queryKey: activeSessionsQueryKey });
        queryClient.setQueryData<ActiveSessionsQueryData>(activeSessionsQueryKey, current => ({
          sessions: update((current?.sessions ?? []).filter(isRootSession)),
        }));
        if (refetchAfterUpdate) void refetch();
      });
    };
    const refreshActiveSessions = () => {
      pendingLiveUpdate = pendingLiveUpdate.then(async () => {
        await queryClient.cancelQueries({ queryKey: activeSessionsQueryKey });
        void refetch();
      });
    };
    return sharedConnection.onSystemEvent(event => {
      if (event.event === 'sessions.list') {
        const sessions = getRootSessionsFromListPayload(event.data);
        if (sessions) updateCachedSessions(() => sessions);
      }
      if (event.event === 'sessions.heartbeat') {
        const payload = getRootSessionsFromHeartbeatPayload(event.data);
        if (payload) {
          updateCachedSessions(sessions => applyActiveSessionsHeartbeat(sessions, payload));
        }
      }
      if (event.event === 'cli.disconnected') {
        const payload = getCliConnectionPayload(event.data);
        if (payload) {
          updateCachedSessions(
            sessions => removeActiveSessionsForConnection(sessions, payload.connectionId),
            true
          );
        }
      }
      if (event.event === 'cli.connected') {
        refreshActiveSessions();
      }
    });
  }, [activeSessionsQueryKey, queryClient, refetch, sharedConnection]);

  return {
    activeSessions,
    isLoading,
  };
}
