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
} from '@kilocode/cloud-agent-sdk/schemas';
import { useUserWebConnection } from '../CloudAgentProvider';

/**
 * A live row as the sidebar needs it: the connection wire shape plus the
 * fields `activeSessions.list` enriches from `cli_sessions_v2`. A WebSocket
 * payload carries none of them, so the merge below keeps the enriched copy —
 * the live-row filters read `createdOnPlatform` and `organizationId`.
 */
export type ActiveSession = ActiveSessionWithConnectionData & {
  createdOnPlatform?: string;
  organizationId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  lastActivityAt?: string;
  statusUpdatedAt?: string;
};

type CliConnectionPayload = {
  connectionId: string;
};

/**
 * One connection's `sessions.heartbeat`: the full snapshot of that
 * connection's root sessions, broadcast on its own. A cached row of this
 * connection that the snapshot omits has ended on it, so it is dropped; rows
 * of every other connection are untouched here.
 */
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

/**
 * Fields the sidebar reads that `activeSessions.list` enriches from
 * `cli_sessions_v2` and a connection payload never carries.
 */
const ENRICHED_FIELDS = [
  'createdOnPlatform',
  'createdAt',
  'updatedAt',
  'lastActivityAt',
  'statusUpdatedAt',
] as const;

/**
 * Overlay the cache onto a wire row for an id we already know.
 *
 * `activeSessions.list` enriches a row from `cli_sessions_v2` and the wire row
 * is worse on every field this touches: the title is DB-authoritative (nothing
 * propagates a cloud rename back to the CLI, so the wire title stays stale
 * forever), and the origin, owner scope, and timestamp fields are absent from
 * the wire entirely. Dropping them on each heartbeat would also drop a live row
 * out of a filtered sidebar until the next poll refetch. A brand-new id still
 * shows exactly what the connection reported.
 *
 * `organizationId` is the exception: a row the query has since attributed must
 * take the query's value. A WebSocket row never carries one, so the fallback
 * below only applies to an already-attributed cache entry.
 */
function mergeCachedEnrichment(
  cached: ActiveSession | undefined,
  incoming: ActiveSession
): ActiveSession {
  if (!cached) return incoming;
  const merged: ActiveSession = {
    ...incoming,
    title: cached.title,
    // `null` is meaningful here: it is the personal scope, which the wire
    // cannot express, so only an absent value falls back to the incoming row.
    organizationId:
      incoming.organizationId !== undefined ? incoming.organizationId : cached.organizationId,
  };
  for (const field of ENRICHED_FIELDS) {
    const value = cached[field] !== undefined ? cached[field] : incoming[field];
    if (value !== undefined) merged[field] = value;
  }
  return merged;
}

/**
 * Merge one connection's heartbeat into the cached list.
 *
 * The heartbeating connection's rows come first, as they always have; the
 * sidebar decides the rendered order itself (`remotePriority` in
 * `ChatSidebar.tsx`), so a heartbeat cannot reshuffle what the user sees.
 *
 * A row another connection now owns is replaced in place rather than kept
 * alongside the reported one: the connection list attributes each session to
 * one connection, so a takeover must not render it twice.
 *
 * Only a row the heartbeating connection owns is dropped when the payload omits
 * it. A row another connection owns is kept even when its id is absent: the
 * payload is an aggregate that can lag a connection's own report, and a dropped
 * row is invisible to a scoped sidebar until the next poll attributes it again.
 */
export function applyActiveSessionsHeartbeat(
  currentSessions: ActiveSession[],
  payload: RootHeartbeatPayload
): ActiveSession[] {
  const cachedById = new Map(currentSessions.map(session => [session.id, session]));
  const reported = new Set(payload.sessions.map(session => session.id));
  return [
    ...payload.sessions.map(session => mergeCachedEnrichment(cachedById.get(session.id), session)),
    ...currentSessions.filter(
      session => !reported.has(session.id) && session.connectionId !== payload.connectionId
    ),
  ];
}

/**
 * Merge the full connection snapshot into the cached list. The payload already
 * carries every connection's rows in the server's order, so only the enriched
 * fields the wire lacks have to be carried over.
 *
 * A cached row the snapshot omits keeps its place: the snapshot is one
 * connection event, not the authoritative set, and dropping the row would hide
 * it from a scoped sidebar until the next poll attributes it.
 */
export function applyActiveSessionsList(
  currentSessions: ActiveSession[],
  incomingSessions: ActiveSession[]
): ActiveSession[] {
  const cachedById = new Map(currentSessions.map(session => [session.id, session]));
  const incomingById = new Map(incomingSessions.map(session => [session.id, session]));
  const merged = incomingSessions.map(session =>
    mergeCachedEnrichment(cachedById.get(session.id), session)
  );
  for (const session of currentSessions) {
    if (!incomingById.has(session.id)) merged.push(session);
  }
  return merged;
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
        if (sessions) {
          updateCachedSessions(current => applyActiveSessionsList(current, sessions));
        }
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
