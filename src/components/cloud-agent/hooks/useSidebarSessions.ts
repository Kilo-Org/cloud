/**
 * Hook for managing sidebar session list
 *
 * Fetches sessions from the database and maintains them in Jotai atoms
 * for reactive updates across the UI.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import {
  apiSessionToDbSession,
  extractRepoFromGitUrl,
  dbSessionsAtom,
  recentSessionsAtom,
  type DbSession,
} from '../store/db-session-atoms';
import type { StoredSession } from '../types';

/**
 * Convert a DbSession to StoredSession format for display in ChatSidebar
 */
function dbSessionToStoredSession(session: DbSession): StoredSession {
  const repository = extractRepoFromGitUrl(session.git_url) ?? '';
  const title = session.title || `Session ${session.session_id.substring(0, 8)}`;

  return {
    sessionId: session.session_id,
    repository,
    prompt: title,
    mode: 'code', // Default mode - DB doesn't store this directly
    model: '', // Not stored in DB session list
    status: session.cloud_agent_session_id ? 'active' : 'completed',
    createdAt: session.created_at.toISOString(),
    updatedAt: session.updated_at.toISOString(),
    messages: [], // Not loaded in list view
    cloudAgentSessionId: session.cloud_agent_session_id,
  };
}

type UseSidebarSessionsOptions = {
  /** Organization ID to scope sessions to (null for personal, undefined to include all) */
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
 * 1. Fetching sessions from database via tRPC
 * 2. Storing them in Jotai atoms for reactive updates
 * 3. Converting to StoredSession format for UI display
 */
export function useSidebarSessions(options?: UseSidebarSessionsOptions): UseSidebarSessionsReturn {
  const { organizationId } = options ?? {};
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // DB-backed session atoms for sidebar
  const recentSessions = useAtomValue(recentSessionsAtom);
  const setDbSessions = useSetAtom(dbSessionsAtom);

  // Query options with organizationId for proper scoping
  const queryInput = { limit: 10, organizationId };

  // Query key for invalidation (includes organizationId for cache separation)
  const queryKey = trpc.unifiedSessions.list.queryKey(queryInput);

  // Fetch sessions from database and populate Jotai atom
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

  // Convert DB sessions to StoredSession format for sidebar display
  const sessions = useMemo<StoredSession[]>(() => {
    return recentSessions.map(dbSessionToStoredSession);
  }, [recentSessions]);

  // Refetch sessions by invalidating the query cache
  const refetchSessions = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  return { sessions, isLoading, refetchSessions };
}
