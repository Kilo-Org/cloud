/**
 * Hook for managing sidebar session list (V2)
 *
 * Fetches sessions from cli_sessions_v2 table and maintains them in Jotai atoms
 * for reactive updates across the UI.
 *
 * Note: V2 sessions don't have organization_id - all sessions are personal.
 * The organizationId parameter is accepted but ignored for API compatibility.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import {
  apiSessionV2ToDbSession,
  dbSessionsAtom,
  recentSessionsAtom,
  type DbSessionV2,
} from '../store/db-session-atoms';
import type { StoredSession } from '../types';

/**
 * Convert a V2 DbSession to StoredSession format for display in ChatSidebar
 * V2 sessions don't have git_url - repository info comes from DO
 */
function dbSessionV2ToStoredSession(session: DbSessionV2): StoredSession {
  const title = session.title || `Session ${session.session_id.substring(0, 8)}`;

  return {
    sessionId: session.session_id,
    repository: 'Repository', // V2 sessions don't store git_url in DB - shown as generic
    prompt: title,
    mode: 'build', // Default mode for V2
    model: '', // Not stored in DB session list
    status: session.cloud_agent_session_id ? 'active' : 'completed',
    createdAt: session.created_at.toISOString(),
    updatedAt: session.updated_at.toISOString(),
    messages: [], // Not loaded in list view
    cloudAgentSessionId: session.cloud_agent_session_id,
  };
}

type UseSidebarSessionsOptions = {
  /**
   * Organization ID - accepted for API compatibility but ignored.
   * V2 sessions don't have organization scoping.
   */
  organizationId?: string | null;
};

type UseSidebarSessionsReturn = {
  /** Sessions formatted for ChatSidebar display */
  sessions: StoredSession[];
  /** Whether the query is currently loading */
  isLoading: boolean;
  /** Manually refetch sessions from DB */
  refetchSessions: () => void;
};

/**
 * Manages sidebar session list by:
 * 1. Fetching sessions from cli_sessions_v2 via tRPC
 * 2. Storing them in Jotai atoms for reactive updates
 * 3. Converting to StoredSession format for UI display
 */
export function useSidebarSessions(options?: UseSidebarSessionsOptions): UseSidebarSessionsReturn {
  // organizationId is accepted but not used - V2 sessions are personal only
  const _organizationId = options?.organizationId;
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // DB-backed session atoms for sidebar
  const recentSessions = useAtomValue(recentSessionsAtom);
  const setDbSessions = useSetAtom(dbSessionsAtom);

  // Query options - V2 doesn't support organizationId filtering
  const queryInput = { limit: 10 };

  // Query key for invalidation
  const queryKey = trpc.cliSessionsV2.list.queryKey(queryInput);

  // Fetch sessions from database and populate Jotai atom
  // staleTime: 5000 prevents unnecessary refetches within 5 seconds
  // while still catching sessions created from other devices/tabs on navigation
  const { data: dbSessionsData, isLoading } = useQuery({
    ...trpc.cliSessionsV2.list.queryOptions(queryInput),
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
        const sessions = dbSessionsData.cliSessions.map(apiSessionV2ToDbSession);
        setDbSessions(sessions);
      }
    }
  }, [dbSessionsData?.cliSessions, setDbSessions]);

  // Convert DB sessions to StoredSession format for sidebar display
  const sessions = useMemo<StoredSession[]>(() => {
    // V2 sessions - type assertion since we know this hook only stores V2 sessions
    return (recentSessions as DbSessionV2[]).map(dbSessionV2ToStoredSession);
  }, [recentSessions]);

  // Refetch sessions by invalidating the query cache
  const refetchSessions = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  return { sessions, isLoading, refetchSessions };
}
