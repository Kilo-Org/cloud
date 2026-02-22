/**
 * Hook for managing sidebar session list
 *
 * Fetches sessions from the unified sessions router and maintains them in Jotai atoms
 * for reactive updates across the UI.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import {
  apiSessionToDbSession,
  dbSessionsAtom,
  recentSessionsAtom,
  type DbSession,
  type DbSessionV2,
} from '../store/db-session-atoms';
import type { StoredSession } from '../types';

function dbSessionToStoredSession(session: DbSession | DbSessionV2): StoredSession {
  const title = session.title || `Session ${session.session_id.substring(0, 8)}`;

  return {
    sessionId: session.session_id,
    repository: '',
    prompt: title,
    mode: 'build',
    model: '',
    status: session.cloud_agent_session_id ? 'active' : 'completed',
    createdAt: session.created_at.toISOString(),
    updatedAt: session.updated_at.toISOString(),
    messages: [],
    cloudAgentSessionId: session.cloud_agent_session_id,
  };
}

type UseSidebarSessionsOptions = {
  organizationId?: string | null;
};

type UseSidebarSessionsReturn = {
  sessions: StoredSession[];
  isLoading: boolean;
  refetchSessions: () => void;
};

export function useSidebarSessions(options?: UseSidebarSessionsOptions): UseSidebarSessionsReturn {
  const { organizationId } = options ?? {};
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const recentSessions = useAtomValue(recentSessionsAtom);
  const setDbSessions = useSetAtom(dbSessionsAtom);

  const queryInput = { limit: 10, organizationId };

  const queryKey = trpc.unifiedSessions.list.queryKey(queryInput);

  // staleTime: 5000 prevents unnecessary refetches within 5 seconds
  // while still catching sessions created from other devices/tabs on navigation
  const { data: dbSessionsData, isLoading } = useQuery({
    ...trpc.unifiedSessions.list.queryOptions(queryInput),
    staleTime: 5000,
  });

  // Track last processed data key to avoid unnecessary atom updates
  const lastDataKeyRef = useRef<string | null>(null);

  // Populate Jotai atom when query data actually changes
  useEffect(() => {
    if (dbSessionsData?.cliSessions) {
      // Create stable key from session IDs + updated_at to detect real changes
      const dataKey = dbSessionsData.cliSessions
        .map(s => `${s.session_id}-${s.updated_at}`)
        .join('|');

      // Only update atoms when data actually changes
      if (lastDataKeyRef.current !== dataKey) {
        lastDataKeyRef.current = dataKey;
        const sessions = dbSessionsData.cliSessions.map(apiSessionToDbSession);
        setDbSessions(sessions);
      }
    }
  }, [dbSessionsData?.cliSessions, setDbSessions]);

  const sessions = useMemo<StoredSession[]>(() => {
    return recentSessions.map(dbSessionToStoredSession);
  }, [recentSessions]);

  // Refetch sessions by invalidating the query cache
  const refetchSessions = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  return { sessions, isLoading, refetchSessions };
}
