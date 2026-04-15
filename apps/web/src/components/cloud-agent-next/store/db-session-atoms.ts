'use client';

/**
 * Database-Backed Session Atoms
 *
 * Jotai atoms for managing CLI sessions stored in the database (cli_sessions table).
 * These atoms enable cross-device session access, proper persistence, and integration
 * with the Kilocode ecosystem.
 *
 * Architecture:
 * - DB (cli_sessions + R2) = Source of truth for historical sessions
 * - IndexedDB (via jotai-minidb) = Client-side cache with message storage
 * - SSE stream = Real-time messages during active chat
 *
 * ⚠️ CLIENT-SIDE ONLY ⚠️
 * This module uses IndexedDB which is only available in browser environments.
 * DO NOT import this file in:
 * - Server components
 * - API routes
 * - Any server-side code
 */

import { atom } from 'jotai';
import { MiniDb } from 'jotai-minidb';
import type { StoredMessage, ResumeConfig } from '../types';
import { extractRepoFromGitUrl } from '../utils/git-utils';

// Re-export extractRepoFromGitUrl for backwards compatibility
// Many files import it from here, so we keep the export to avoid breaking changes
export { extractRepoFromGitUrl };

// ============================================================================
// IndexedDB Types
// ============================================================================

/**
 * Organization context for a session
 */
export type OrgContext = {
  organizationId: string;
};

/**
 * Session data stored in IndexedDB
 * Contains all the information needed to display and resume a session
 */
export type IndexedDbSessionData = {
  /** Local session ID (UUID) - used as the key in IndexedDB */
  sessionId: string;

  /** Cloud agent session ID (agent_xxx format) - set when connected to cloud */
  cloudAgentSessionId: string | null;

  /**
   * Session data version for format detection.
   * - Version 1 (or undefined): Legacy CloudMessage[] format (for server-side integrations)
   * - Version 2+: StoredMessage[] format (info + parts)
   */
  version?: number;

  /**
   * Messages in StoredMessage format.
   * Each message has info (metadata) and parts (content array).
   *
   * Note: For version 1 sessions, this will contain CloudMessage[] and should
   * be detected using isOldSessionFormat() before rendering.
   */
  messages: StoredMessage[];

  /**
   * High water mark - the DB's updated_at timestamp (in unix milliseconds) from the most recent
   * session_synced SSE event or from initial session load. Used for staleness detection:
   * if the DB's current updated_at is newer than this value, the session is stale.
   */
  highWaterMark: number;

  /** Timestamp when this session was loaded from DB (client time, for debugging) */
  loadedFromDbAt: string | null;

  /** Session title (user-provided or auto-generated) */
  title: string | null;

  /** Git URL of the repository */
  gitUrl: string | null;

  /** Repository in owner/repo format */
  repository: string | null;

  /** Organization context if applicable */
  orgContext: OrgContext | null;

  /** Whether org context has been confirmed by user */
  orgContextConfirmed: boolean;

  /** Resume configuration for restarting the session */
  resumeConfig: ResumeConfig | null;

  /** When the session was created */
  createdAt: string;

  /** When the session was last updated */
  updatedAt: string;

  /** Last mode used for this session (from DB) */
  lastMode: string | null;

  /** Last model used for this session (from DB) */
  lastModel: string | null;
};

// ============================================================================
// IndexedDB Store (jotai-minidb)
// ============================================================================

/** Lazily initialized session store instance */
let _sessionStore: MiniDb<IndexedDbSessionData> | null = null;

/**
 * Get the IndexedDB store for cloud agent sessions.
 *
 * Uses jotai-minidb for reactive IndexedDB access with Jotai integration.
 * Sessions are keyed by their sessionId (UUID).
 *
 * The store is created lazily on first access to avoid SSR issues
 * (IndexedDB is only available in browser environments).
 *
 * @returns The MiniDb session store instance
 * @throws Error if called in server-side context
 */
function getSessionStore(): MiniDb<IndexedDbSessionData> {
  if (typeof window === 'undefined') {
    throw new Error(
      '[db-session-atoms] Cannot access IndexedDB store: not available in server-side context.'
    );
  }

  if (!_sessionStore) {
    _sessionStore = new MiniDb<IndexedDbSessionData>({
      name: 'kilocode-cloud-sessions',
    });
  }

  return _sessionStore;
}

// ============================================================================
// Database Session Types
// ============================================================================

/**
 * API session type - matches the shape returned by cliSessionsV2 router list procedure.
 * The cli_sessions_v2 schema uses `mode: 'string'` for timestamps, so dates are strings.
 */
type ApiSession = {
  session_id: string;
  title: string | null;
  git_url: string | null;
  git_branch: string | null;
  cloud_agent_session_id: string | null;
  created_on_platform: string;
  created_at: string;
  updated_at: string;
  version: number;
  organization_id: string | null;
  status: string | null;
  status_updated_at: string | null;
  parent_session_id: string | null;
};

/**
 * Database session type - timestamps are ISO strings (Drizzle `mode: 'string'`).
 */
export type DbSession = {
  session_id: string;
  title: string | null;
  git_url: string | null;
  git_branch: string | null;
  cloud_agent_session_id: string | null;
  created_on_platform: string;
  created_at: string;
  updated_at: string;
  last_mode: string | null;
  last_model: string | null;
  version: number;
  organization_id: string | null;
  status: string | null;
  status_updated_at: string | null;
};

/**
 * Database session type for V2 - timestamps are ISO strings.
 * V2 sessions don't have git_url, organization_id, or mode/model fields
 */
export type DbSessionV2 = {
  session_id: string;
  title: string | null;
  cloud_agent_session_id: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  status: string | null;
  status_updated_at: string | null;
};

/**
 * Convert an API session from the v2 router to DbSession format.
 * Dates are already Date objects; last_mode/last_model are not present in v2.
 */
export function apiSessionToDbSession(apiSession: ApiSession): DbSession {
  return {
    ...apiSession,
    last_mode: null,
    last_model: null,
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
  created_at: Date | string;
  updated_at: Date | string;
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

// ============================================================================
// State Atoms
// ============================================================================

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

// ============================================================================
// Derived Atoms
// ============================================================================

/**
 * Recent sessions for display - returns dbSessionsAtom data
 * Falls back to empty array if loading
 */
export const recentSessionsAtom = atom(get => {
  const isLoading = get(sessionsLoadingAtom);
  if (isLoading) return [];
  return get(dbSessionsAtom);
});

// ============================================================================
// IndexedDB State Atoms
// ============================================================================

/**
 * Current session's IndexedDB data (reactive)
 * This holds the full session data including messages from IndexedDB
 */
const currentIndexedDbSessionAtom = atom<IndexedDbSessionData | null>(null);

// ============================================================================
// Action Atoms
// ============================================================================

/**
 * Update org context in IndexedDB
 *
 * Called when user confirms or changes the organization context for a session.
 *
 * @param payload - Session ID, orgContext, and confirmation flag
 */
export const updateOrgContextAtom = atom(
  null,
  async (
    get,
    set,
    payload: {
      sessionId: string;
      orgContext: OrgContext | null;
      orgContextConfirmed: boolean;
    }
  ): Promise<void> => {
    const { sessionId, orgContext, orgContextConfirmed } = payload;

    // Update current session atom if it matches
    const currentSession = get(currentIndexedDbSessionAtom);
    if (currentSession && currentSession.sessionId === sessionId) {
      const updatedSession: IndexedDbSessionData = {
        ...currentSession,
        orgContext,
        orgContextConfirmed,
        updatedAt: new Date().toISOString(),
      };
      set(currentIndexedDbSessionAtom, updatedSession);
    }

    // Update IndexedDB using jotai-minidb (client-side only)
    if (typeof window !== 'undefined') {
      try {
        const store = getSessionStore();
        const existingData = get(store.item(sessionId));
        if (existingData) {
          const updatedData: IndexedDbSessionData = {
            ...existingData,
            orgContext,
            orgContextConfirmed,
            updatedAt: new Date().toISOString(),
          };
          await set(store.setMany, [[sessionId, updatedData]]);
        }
      } catch (error) {
        // Error updating IndexedDB - org context still updated in memory
        console.error('[db-session-atoms] Error updating org context in IndexedDB:', error);
      }
    }
  }
);

/**
 * Action atom for deleting a session from IndexedDB.
 *
 * Used when deleting sessions from the UI.
 *
 * @param sessionId - The session ID to delete
 */
export const deleteSessionFromStoreAtom = atom(
  null,
  async (_get, set, sessionId: string): Promise<void> => {
    if (typeof window === 'undefined') return;

    try {
      const store = getSessionStore();
      await set(store.delete, sessionId);
    } catch (error) {
      // Error deleting from IndexedDB
      console.error('[db-session-atoms] Error deleting session from IndexedDB:', error);
    }
  }
);

// ============================================================================
// Utility Functions
// ============================================================================

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

  // Fall back to repository name
  const repo = extractRepoFromGitUrl(session.git_url);
  if (repo) return repo;

  // Last resort: use session ID prefix
  return `Session ${session.session_id.substring(0, 8)}`;
}
