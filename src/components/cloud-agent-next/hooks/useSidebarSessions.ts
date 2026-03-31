/**
 * Hook for managing sidebar session list
 *
 * Fetches sessions from the unified sessions router and maintains them in Jotai atoms
 * for reactive updates across the UI. Supports search and platform filtering.
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
import { startOfDay, subDays } from 'date-fns';
import { extractRepoFromGitUrl } from '../utils/git-utils';
import type { StoredSession } from '../types';

/**
 * Extract "owner/repo" from a git URL for display.
 * Branch is returned separately via StoredSession.branch.
 */
function extractRepoDisplay(gitUrl: string | null | undefined): string {
  return extractRepoFromGitUrl(gitUrl) ?? '';
}

function dbSessionToStoredSession(session: DbSession | DbSessionV2): StoredSession {
  const title = session.title || `Session ${session.session_id.substring(0, 8)}`;

  // DbSession has git_url/git_branch/created_on_platform/last_mode/last_model; DbSessionV2 does not
  const isV1 = 'git_url' in session;
  const v1 = isV1 ? (session as DbSession) : null;

  return {
    sessionId: session.session_id,
    repository: extractRepoDisplay(v1?.git_url),
    branch: v1?.git_branch ?? null,
    prompt: title,
    mode: v1?.last_mode ?? 'code',
    model: v1?.last_model ?? '',
    status: session.cloud_agent_session_id ? 'active' : 'completed',
    createdAt: session.created_at.toISOString(),
    updatedAt: session.updated_at.toISOString(),
    messages: [],
    cloudAgentSessionId: session.cloud_agent_session_id,
    createdOnPlatform: v1?.created_on_platform ?? null,
  };
}

type UseSidebarSessionsOptions = {
  organizationId?: string | null;
  searchQuery?: string;
  createdOnPlatform?: string | string[];
  gitUrl?: string;
};

type UseSidebarSessionsReturn = {
  sessions: StoredSession[];
  isLoading: boolean;
  refetchSessions: () => void;
  renameSessionLocally: (sessionId: string, newTitle: string) => void;
};

export function useSidebarSessions(options?: UseSidebarSessionsOptions): UseSidebarSessionsReturn {
  const { organizationId, searchQuery = '', createdOnPlatform, gitUrl } = options ?? {};
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const recentSessions = useAtomValue(recentSessionsAtom);
  const setDbSessions = useSetAtom(dbSessionsAtom);

  const isSearchActive = searchQuery.length > 0;

  // --- List query (default, non-search) ---
  const updatedSince = useMemo(() => startOfDay(subDays(new Date(), 5)).toISOString(), []);
  const listInput = {
    updatedSince,
    orderBy: 'updated_at' as const,
    organizationId,
    createdOnPlatform,
    gitUrl,
  };
  const listQueryKey = trpc.unifiedSessions.list.queryKey(listInput);

  const { data: listData, isLoading: isListLoading } = useQuery({
    ...trpc.unifiedSessions.list.queryOptions(listInput),
    staleTime: 5000,
    enabled: !isSearchActive,
  });

  // --- Search query ---
  const searchInput = { search_string: searchQuery, createdOnPlatform, organizationId, gitUrl };

  const { data: searchData, isLoading: isSearchLoading } = useQuery({
    ...trpc.unifiedSessions.search.queryOptions(searchInput),
    staleTime: 5000,
    enabled: isSearchActive,
  });

  // Track last processed data key to avoid unnecessary atom updates
  const lastDataKeyRef = useRef<string | null>(null);

  // Populate Jotai atom when list query data actually changes (NOT for search)
  useEffect(() => {
    if (isSearchActive) return;
    if (listData?.cliSessions) {
      const dataKey = listData.cliSessions.map(s => `${s.session_id}-${s.updated_at}`).join('|');

      if (lastDataKeyRef.current !== dataKey) {
        lastDataKeyRef.current = dataKey;
        const sessions = listData.cliSessions.map(apiSessionToDbSession);
        setDbSessions(sessions);
      }
    }
  }, [listData?.cliSessions, setDbSessions, isSearchActive]);

  // Atom-derived sessions for list mode
  const listSessions = useMemo<StoredSession[]>(() => {
    return recentSessions.map(dbSessionToStoredSession);
  }, [recentSessions]);

  // Convert search results directly to StoredSession[] (no Jotai atoms)
  const searchSessions = useMemo<StoredSession[]>(() => {
    if (!searchData?.results) return [];
    return searchData.results.map(row => ({
      sessionId: row.session_id,
      repository: extractRepoDisplay(row.git_url),
      branch: row.git_branch,
      prompt: row.title || `Session ${row.session_id.substring(0, 8)}`,
      mode: row.last_mode ?? 'code',
      model: row.last_model ?? '',
      status: row.cloud_agent_session_id ? ('active' as const) : ('completed' as const),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messages: [],
      cloudAgentSessionId: row.cloud_agent_session_id,
      createdOnPlatform: row.created_on_platform,
    }));
  }, [searchData?.results]);

  const sessions = isSearchActive ? searchSessions : listSessions;
  const isLoading = isSearchActive ? isSearchLoading : isListLoading;

  // Refetch sessions by invalidating the query cache
  const refetchSessions = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: listQueryKey });
  }, [queryClient, listQueryKey]);

  // Optimistically update a session's title in the Jotai atom so the UI
  // reflects the change immediately (before the server refetch completes).
  const renameSessionLocally = useCallback(
    (sessionId: string, newTitle: string) => {
      setDbSessions(prev =>
        prev.map(s => (s.session_id === sessionId ? { ...s, title: newTitle } : s))
      );
    },
    [setDbSessions]
  );

  return { sessions, isLoading, refetchSessions, renameSessionLocally };
}
