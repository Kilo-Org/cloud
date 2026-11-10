'use client';

/**
 * Session Atoms
 *
 * Jotai atoms and types for CLI sessions listed in the database (cli_sessions
 * and cli_sessions_v2 tables). The database is the source of truth for
 * historical sessions; nothing about a session is cached in the browser.
 *
 * ⚠️ CLIENT-SIDE ONLY ⚠️
 * These atoms use jotai and are only meaningful in the browser.
 * DO NOT import this file in:
 * - Server components
 * - API routes
 * - Any server-side code
 */

import { atom } from 'jotai';
import type { AssociatedPr } from '../utils/github-pr-link';
import { extractRepoFromGitUrl } from '../utils/git-utils';

// Re-export extractRepoFromGitUrl for backwards compatibility
// Many files import it from here, so we keep the export to avoid breaking changes
export { extractRepoFromGitUrl };

/**
 * API session type - matches the shape returned by cli-sessions-router.list (V1)
 * Dates are returned as strings from the tRPC API
 */
type ApiSession = {
  latest_run_status?: 'queued' | 'accepted' | 'completed' | 'failed' | 'interrupted' | null;
  latest_run_failure_kind?: 'failed' | 'system_interrupted' | null;
  latest_run_terminal_at?: string | null;
  session_id: string;
  title: string | null;
  git_url: string | null;
  git_branch: string | null;
  cloud_agent_session_id: string | null;
  cloud_agent_worktree_id?: string | null;
  created_on_platform: string | null;
  created_at: string;
  updated_at: string;
  last_mode?: string | null;
  last_model?: string | null;
  version: number;
  organization_id: string | null;
  status: string | null;
  status_updated_at: string | null;
  parent_session_id: string | null;
  associatedPr?: AssociatedPr | null;
};

/**
 * Database session type - with Date objects for convenient manipulation
 */
export type DbSession = {
  latest_run_status?: ApiSession['latest_run_status'];
  latest_run_failure_kind?: ApiSession['latest_run_failure_kind'];
  latest_run_terminal_at?: ApiSession['latest_run_terminal_at'];
  session_id: string;
  title: string | null;
  git_url: string | null;
  git_branch: string | null;
  cloud_agent_session_id: string | null;
  cloud_agent_worktree_id?: string | null;
  created_on_platform: string | null;
  created_at: Date;
  updated_at: Date;
  last_mode: string | null;
  last_model: string | null;
  version: number;
  organization_id: string | null;
  status: string | null;
  status_updated_at: Date | null;
  associatedPr?: AssociatedPr | null;
};

/**
 * Database session type for V2 - with Date objects
 * V2 sidebar sessions include git/platform/org/parent/status fields from cli_sessions_v2.
 */
export type DbSessionV2 = {
  latest_run_status?: ApiSession['latest_run_status'];
  latest_run_failure_kind?: ApiSession['latest_run_failure_kind'];
  latest_run_terminal_at?: ApiSession['latest_run_terminal_at'];
  session_id: string;
  title: string | null;
  cloud_agent_session_id: string | null;
  cloud_agent_worktree_id?: string | null;
  created_on_platform: string | null;
  organization_id: string | null;
  git_url: string | null;
  git_branch: string | null;
  parent_session_id: string | null;
  created_at: Date;
  updated_at: Date;
  version: number;
  status: string | null;
  status_updated_at: Date | null;
  associatedPr?: AssociatedPr | null;
  /**
   * Persisted session total cost in microdollars (USD × 1,000,000). Optional
   * because the cloud-agent API path that populates `DbSessionV2` does not
   * surface it; tRPC list/search results that do carry it flow through
   * unchanged. The sidebar does not render cost, so missing values are
   * treated as unknown and serialized as `null`.
   */
  total_cost_microdollars?: number | null;
};

/**
 * Convert an API session (with string dates) to DbSession format (with Date objects)
 */
export function apiSessionToDbSession(apiSession: ApiSession): DbSession | DbSessionV2 {
  return {
    ...apiSession,
    last_mode: apiSession.last_mode ?? null,
    last_model: apiSession.last_model ?? null,
    created_at: new Date(apiSession.created_at),
    updated_at: new Date(apiSession.updated_at),
    status_updated_at: apiSession.status_updated_at ? new Date(apiSession.status_updated_at) : null,
    associatedPr: apiSession.associatedPr ?? null,
  };
}

/**
 * Full session details from cli-sessions-router.get (V1) or cli-sessions-v2-router.get (V2)
 *
 * V2 sessions don't have blob URLs, git_url, organization_id, or created_on_platform.
 * These fields are optional to support both V1 and V2 sessions.
 */
export type DbSessionDetails = {
  session_id: string;
  title: string | null;
  cloud_agent_session_id: string | null;
  organization_id: string | null;
  created_at: Date;
  updated_at: Date;
  // V1-only fields (optional for V2 compatibility)
  kilo_user_id?: string;
  git_url?: string | null;
  git_branch?: string | null;
  created_on_platform?: string | null;
  forked_from?: string | null;
  api_conversation_history_blob_url?: string | null;
  task_metadata_blob_url?: string | null;
  ui_messages_blob_url?: string | null;
  git_state_blob_url?: string | null;
  last_mode?: string | null;
  last_model?: string | null;
};

/**
 * Recent sessions fetched from database
 * This is populated by the useSidebarSessions hook
 * Supports both V1 (DbSession) and V2 (DbSessionV2) session types
 */
export const dbSessionsAtom = atom<(DbSession | DbSessionV2)[]>([]);

/**
 * Loading state for sessions list
 */
const sessionsLoadingAtom = atom(false);

/**
 * Recent sessions for display - returns dbSessionsAtom data
 * Falls back to empty array if loading
 */
export const recentSessionsAtom = atom(get => {
  const isLoading = get(sessionsLoadingAtom);
  if (isLoading) return [];
  return get(dbSessionsAtom);
});

/**
 * Format a date for display in the session list
 *
 * @param date - Date to format
 * @returns Formatted string like "2 hours ago" or "Dec 5"
 */
export function formatSessionDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Get a display title for a session
 *
 * Note: Visual truncation should be handled via CSS (e.g., `truncate` class)
 * rather than JavaScript string manipulation for responsive behavior.
 *
 * @param session - The session to get a title for
 * @returns A display-friendly title
 */
export function getSessionDisplayTitle(session: DbSession): string {
  if (session.title) {
    return session.title;
  }

  const repo = extractRepoFromGitUrl(session.git_url);
  if (repo) return repo;

  return `Session ${session.session_id.substring(0, 8)}`;
}
