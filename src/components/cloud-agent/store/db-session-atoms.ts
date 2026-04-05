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
import type { CloudMessage } from '../types';
import {
  updateMessageAtom,
  clearMessagesAtom,
  sessionConfigAtom,
  currentSessionIdAtom as currentLocalSessionIdAtom,
} from './atoms';
import { buildSessionConfig } from '../session-config';
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
 * Resume configuration stored with the session
 * Captures the settings needed to resume a session
 */
export type StoredResumeConfig = {
  mode: string;
  model: string;
  envVars?: Record<string, string>;
  setupCommands?: string[];
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

  /** Messages in CloudMessage format (streaming format with ts, type, etc.) */
  messages: CloudMessage[];

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
  resumeConfig: StoredResumeConfig | null;

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

/**
 * Create a new IndexedDbSessionData object from session details.
 *
 * @param session - Partial session data (requires at least sessionId)
 * @param messages - Array of CloudMessage objects to store
 * @param repository - Optional repository string in owner/repo format
 * @returns Complete IndexedDbSessionData object with defaults filled in
 */
export function createSessionData(
  session: {
    sessionId: string;
    cloudAgentSessionId?: string | null;
    title?: string | null;
    gitUrl?: string | null;
    orgContext?: OrgContext | null;
    orgContextConfirmed?: boolean;
    resumeConfig?: StoredResumeConfig | null;
    createdAt?: string;
    dbUpdatedAt?: string | null;
    lastMode?: string | null;
    lastModel?: string | null;
  },
  messages: CloudMessage[],
  repository?: string | null
): IndexedDbSessionData {
  const now = new Date().toISOString();
  // Initialize highWaterMark from DB's updated_at timestamp (converted to ms)
  // This represents "the most recent DB update we know about"
  const highWaterMark = session.dbUpdatedAt ? new Date(session.dbUpdatedAt).getTime() : 0;

  return {
    sessionId: session.sessionId,
    cloudAgentSessionId: session.cloudAgentSessionId ?? null,
    messages,
    highWaterMark,
    loadedFromDbAt: null,
    title: session.title ?? null,
    gitUrl: session.gitUrl ?? null,
    repository: repository ?? null,
    orgContext: session.orgContext ?? null,
    orgContextConfirmed: session.orgContextConfirmed ?? false,
    resumeConfig: session.resumeConfig ?? null,
    createdAt: session.createdAt ?? now,
    updatedAt: now,
    lastMode: session.lastMode ?? null,
    lastModel: session.lastModel ?? null,
  };
}

// ============================================================================
// Database Session Types
// ============================================================================

/**
 * API session type - matches the shape returned by cli-sessions-router.list
 * Dates are returned as strings from the tRPC API
 */
export type ApiSession = {
  session_id: string;
  title: string;
  git_url: string | null;
  cloud_agent_session_id: string | null;
  created_on_platform: string;
  created_at: string;
  updated_at: string;
  last_mode: string | null;
  last_model: string | null;
  version: number;
  organization_id: string | null;
};

/**
 * Database session type - with Date objects for convenient manipulation
 */
export type DbSession = {
  session_id: string;
  title: string | null;
  git_url: string | null;
  cloud_agent_session_id: string | null;
  created_on_platform: string;
  created_at: Date;
  updated_at: Date;
  last_mode: string | null;
  last_model: string | null;
  version: number;
  organization_id: string | null;
};

/**
 * Convert an API session (with string dates) to DbSession format (with Date objects)
 */
export function apiSessionToDbSession(apiSession: ApiSession): DbSession {
  return {
    ...apiSession,
    created_at: new Date(apiSession.created_at),
    updated_at: new Date(apiSession.updated_at),
  };
}

/**
 * Full session details from cli-sessions-router.get
 */
export type DbSessionDetails = DbSession & {
  kilo_user_id: string;
  created_on_platform: string | null;
  forked_from: string | null;
  api_conversation_history_blob_url: string | null;
  task_metadata_blob_url: string | null;
  ui_messages_blob_url: string | null;
  git_state_blob_url: string | null;
  last_mode: string | null;
  last_model: string | null;
};

/**
 * Resume strategy when loading a session
 */
export type ResumeStrategy = 'sendMessageStream' | 'initiateFromKilocodeSession';

/**
 * Result from loading a session
 */
export type LoadSessionResult = {
  session: DbSessionDetails;
  messages: CloudMessage[];
  resumeStrategy: ResumeStrategy;
};

// ============================================================================
// State Atoms
// ============================================================================

/**
 * Recent sessions fetched from database
 * This is populated by the useDbSessions hook
 */
export const dbSessionsAtom = atom<DbSession[]>([]);

/**
 * Loading state for sessions list
 */
export const sessionsLoadingAtom = atom(false);

/**
 * Error state for sessions operations
 */
export const sessionsErrorAtom = atom<string | null>(null);

/**
 * Current database session ID (UUID from cli_sessions table)
 * This differs from currentLocalSessionIdAtom which holds the cloud-agent session ID
 */
export const currentDbSessionIdAtom = atom<string | null>(null);

/**
 * Cloud agent session ID for the current session
 * Used to determine resume strategy
 */
export const cloudAgentSessionIdAtom = atom<string | null>(null);

/**
 * Flag indicating the local session is stale (DB has newer data)
 */
export const sessionStaleAtom = atom(false);

/**
 * Pagination cursor for loading more sessions
 */
export const sessionsNextCursorAtom = atom<string | null>(null);

/**
 * Queue for messages that arrive before IndexedDB session entry is created.
 * This handles the race condition where SSE messages arrive between
 * session_created event and completion of createNewSessionInIndexedDbAtom.
 */
export const pendingMessagesAtom = atom<CloudMessage[]>([]);

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

/**
 * Check if there are more sessions to load
 */
export const hasMoreSessionsAtom = atom(get => {
  return get(sessionsNextCursorAtom) !== null;
});

// ============================================================================
// Action Atoms
// ============================================================================

/**
 * Action atom for updating sessions list from DB
 * Called by useDbSessions hook when data is fetched
 */
export const setDbSessionsAtom = atom(
  null,
  (
    _get,
    set,
    payload: {
      sessions: DbSession[];
      nextCursor: string | null;
      append?: boolean;
    }
  ) => {
    if (payload.append) {
      set(dbSessionsAtom, prev => [...prev, ...payload.sessions]);
    } else {
      set(dbSessionsAtom, payload.sessions);
    }
    set(sessionsNextCursorAtom, payload.nextCursor);
    set(sessionsLoadingAtom, false);
    set(sessionsErrorAtom, null);
  }
);

/**
 * Action atom for setting loading state
 */
export const setSessionsLoadingAtom = atom(null, (_get, set, loading: boolean) => {
  set(sessionsLoadingAtom, loading);
});

/**
 * Action atom for setting error state
 */
export const setSessionsErrorAtom = atom(null, (_get, set, error: string | null) => {
  set(sessionsErrorAtom, error);
  set(sessionsLoadingAtom, false);
});

/**
 * Action atom for clearing staleness flag after refresh
 */
export const clearSessionStaleAtom = atom(null, (_get, set) => {
  set(sessionStaleAtom, false);
});

/**
 * Action atom for updating cloud agent session ID
 * Called when a session is linked to a cloud-agent session
 */
export const linkCloudAgentSessionAtom = atom(null, (_get, set, cloudAgentSessionId: string) => {
  set(cloudAgentSessionIdAtom, cloudAgentSessionId);
});

/**
 * Action atom for setting the current DB session ID
 * Used when receiving session_created events to enable IndexedDB tracking
 */
export const setCurrentDbSessionIdAtom = atom(null, (_get, set, sessionId: string | null) => {
  set(currentDbSessionIdAtom, sessionId);
});

/**
 * Action atom for creating a new session in IndexedDB
 *
 * Called when receiving a session_created SSE event during a new session.
 * This initializes IndexedDB storage so subsequent messages are persisted.
 *
 * IMPORTANT: This atom sets currentDbSessionIdAtom FIRST (before async IndexedDB write)
 * so that processIncomingMessageAtom can immediately start queueing messages for this session.
 * After the IndexedDB entry is created, pending messages are flushed.
 *
 * @param payload - Session IDs and metadata for the new session
 */
export const createNewSessionInIndexedDbAtom = atom(
  null,
  async (
    get,
    set,
    payload: {
      /** CLI session UUID (from payload.sessionId in session_created event) */
      kiloSessionId: string;
      /** Cloud agent session ID in agent_xxx format (from event.sessionId) */
      cloudAgentSessionId: string;
      /** Repository in owner/repo format */
      repository: string;
      /** Initial prompt/title for the session */
      title: string;
      /** Organization context if applicable */
      orgContext?: OrgContext | null;
      /** Session mode from the form */
      mode?: 'architect' | 'code' | 'ask' | 'debug' | 'orchestrator';
      /** Session model from the form */
      model?: string;
    }
  ): Promise<void> => {
    const { kiloSessionId, cloudAgentSessionId, repository, title, orgContext, mode, model } =
      payload;

    // CRITICAL: Set session ID atoms FIRST (synchronous) before async IndexedDB write
    // This allows processIncomingMessageAtom to immediately know which session messages belong to
    // Messages arriving between now and IndexedDB creation will be queued in pendingMessagesAtom
    set(currentDbSessionIdAtom, kiloSessionId);
    set(cloudAgentSessionIdAtom, cloudAgentSessionId);

    // Create initial session data
    const now = new Date().toISOString();

    // Store mode/model as resumeConfig so it's preserved across refreshes
    // This is CRITICAL for new sessions - without it, the resume modal will show on refresh
    const resumeConfig: StoredResumeConfig | null =
      mode && model
        ? {
            mode,
            model,
            envVars: undefined,
            setupCommands: undefined,
          }
        : null;

    const sessionData: IndexedDbSessionData = {
      sessionId: kiloSessionId,
      cloudAgentSessionId,
      messages: [], // Will be populated after we flush pending messages
      highWaterMark: 0, // Will be set by session_synced events
      loadedFromDbAt: null, // Not loaded from DB - this is a new session
      title,
      gitUrl: null, // Not known yet
      repository,
      orgContext: orgContext ?? null,
      orgContextConfirmed: true, // New session - context is implicit (either org or personal)
      resumeConfig, // Store form config for refresh persistence
      createdAt: now,
      updatedAt: now,
      lastMode: mode ?? null,
      lastModel: model ?? null,
    };

    // Save to IndexedDB using jotai-minidb (client-side only)
    if (typeof window !== 'undefined') {
      try {
        const store = getSessionStore();
        await set(store.setMany, [[kiloSessionId, sessionData]]);

        // Flush any messages that were queued while IndexedDB entry was being created
        const pendingMessages = get(pendingMessagesAtom);
        if (pendingMessages.length > 0) {
          // Get the session data we just saved and append pending messages
          const currentData = get(store.item(kiloSessionId));
          if (currentData) {
            const updatedData: IndexedDbSessionData = {
              ...currentData,
              messages: [...currentData.messages, ...pendingMessages],
              updatedAt: new Date().toISOString(),
            };
            await set(store.setMany, [[kiloSessionId, updatedData]]);
          }

          // Clear the pending messages queue
          set(pendingMessagesAtom, []);
        }
      } catch {
        // Error saving to IndexedDB - session will still work in memory
      }
    }

    // Update in-memory session atom
    set(currentIndexedDbSessionAtom, sessionData);

    // Add new session to the sessions list for immediate sidebar display
    const nowDate = new Date();
    const newDbSession: DbSession = {
      session_id: kiloSessionId,
      title,
      git_url: repository ? `https://github.com/${repository}` : null,
      cloud_agent_session_id: cloudAgentSessionId,
      created_on_platform: 'cloud-agent',
      created_at: nowDate,
      updated_at: nowDate,
      last_mode: mode ?? null,
      last_model: model ?? null,
      // New sessions created via prepareSession are version 2+ and have explicit org context
      version: 2,
      organization_id: orgContext?.organizationId ?? null,
    };

    // Prepend to existing sessions (most recent first)
    set(dbSessionsAtom, prev => [newDbSession, ...prev]);
  }
);

/**
 * Action atom for resetting all DB session state
 */
export const resetDbSessionAtom = atom(null, (_get, set) => {
  set(currentDbSessionIdAtom, null);
  set(cloudAgentSessionIdAtom, null);
  set(sessionStaleAtom, false);
});

// ============================================================================
// IndexedDB State Atoms
// ============================================================================

/**
 * Current session's IndexedDB data (reactive)
 * This holds the full session data including messages from IndexedDB
 */
export const currentIndexedDbSessionAtom = atom<IndexedDbSessionData | null>(null);

// ============================================================================
// IndexedDB Action Atoms
// ============================================================================

/**
 * Action atom for loading a session from DB into IndexedDB
 *
 * Flow:
 * 1. Receive session data from DB/R2 (passed as payload)
 * 2. Check if session exists in IndexedDB (to preserve client-side state)
 * 3. Store/update in IndexedDB with proper merging
 * 4. Update currentIndexedDbSessionAtom
 * 5. Return resume strategy and whether org context prompt is needed
 *
 * @param payload - Session details and messages from DB
 * @returns Object containing sessionData, resumeStrategy, and needsOrgContextPrompt
 */
export const loadSessionToIndexedDbAtom = atom(
  null,
  async (
    get,
    set,
    payload: {
      session: DbSessionDetails;
      messages: CloudMessage[];
    }
  ): Promise<{
    sessionData: IndexedDbSessionData;
    resumeStrategy: ResumeStrategy;
    needsOrgContextPrompt: boolean;
  }> => {
    const { session, messages } = payload;

    // Check if session exists in IndexedDB using jotai-minidb (client-side only)
    let existingData: IndexedDbSessionData | null = null;
    if (typeof window !== 'undefined') {
      try {
        const store = getSessionStore();
        existingData = get(store.item(session.session_id)) ?? null;
      } catch {
        // Error reading from IndexedDB - will create fresh session data
      }
    }

    // Extract repository from git URL
    const repository = extractRepoFromGitUrl(session.git_url);

    // Determine if we need org context prompt
    // For sessions with version >= 2, the organization_id field is reliable:
    // - If organization_id is set, we know it's an org session
    // - If organization_id is null, we know it's a personal session
    // For older sessions (version < 2), we need to prompt if not confirmed
    const knowsOrgContextFromDb = session.version >= 2;
    const needsOrgContextPrompt =
      !knowsOrgContextFromDb && (!existingData || !existingData.orgContextConfirmed);

    // Create or merge session data
    let sessionData: IndexedDbSessionData;

    // Convert DB's updated_at to milliseconds for highWaterMark
    const dbUpdatedAtMs = new Date(session.updated_at).getTime();

    if (existingData) {
      // Merge: preserve client-side state (orgContext, resumeConfig) but update messages
      // When loading from DB, we always use DB messages and update highWaterMark to match
      // the DB's updated_at timestamp. This is our new sync point for staleness detection.

      sessionData = {
        ...existingData,
        // Update metadata from DB
        cloudAgentSessionId: session.cloud_agent_session_id ?? existingData.cloudAgentSessionId,
        title: session.title ?? existingData.title,
        gitUrl: session.git_url ?? existingData.gitUrl,
        repository: repository ?? existingData.repository,
        // Always use DB messages when loading from DB - this is a refresh
        messages: messages,
        // CRITICAL: Set highWaterMark to DB's updated_at. After loading from DB,
        // the DB's timestamp becomes our sync reference point. Don't use Math.max
        // because that can keep an old value that causes false staleness reports.
        highWaterMark: dbUpdatedAtMs,
        // Record that we loaded from DB
        loadedFromDbAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        // Update last mode/model from DB (prefer DB values as source of truth)
        lastMode: session.last_mode ?? existingData.lastMode,
        lastModel: session.last_model ?? existingData.lastModel,
      };
    } else {
      // Create new session data
      // For sessions with version >= 2, auto-set org context from DB
      const orgContextFromDb: OrgContext | null =
        knowsOrgContextFromDb && session.organization_id
          ? { organizationId: session.organization_id }
          : null;

      sessionData = createSessionData(
        {
          sessionId: session.session_id,
          cloudAgentSessionId: session.cloud_agent_session_id,
          title: session.title,
          gitUrl: session.git_url,
          orgContext: orgContextFromDb,
          orgContextConfirmed: knowsOrgContextFromDb, // Auto-confirm if we know from DB
          createdAt: session.created_at.toISOString(),
          dbUpdatedAt: session.updated_at.toISOString(),
          lastMode: session.last_mode,
          lastModel: session.last_model,
        },
        messages,
        repository
      );
      sessionData.loadedFromDbAt = new Date().toISOString();
    }

    // Save to IndexedDB using jotai-minidb (client-side only)
    if (typeof window !== 'undefined') {
      try {
        const store = getSessionStore();
        await set(store.setMany, [[session.session_id, sessionData]]);
      } catch {
        // Error saving to IndexedDB - session will still work in memory
      }
    }

    // Update current session atom
    set(currentIndexedDbSessionAtom, sessionData);

    // Clear stale flag since we just loaded fresh data
    set(sessionStaleAtom, false);

    // Update DB session atoms
    set(currentDbSessionIdAtom, session.session_id);
    set(cloudAgentSessionIdAtom, session.cloud_agent_session_id);

    // Populate in-memory atoms for UI rendering
    // Clear existing messages first
    set(clearMessagesAtom);

    // Load messages into the messages atom (feeds into staticMessagesAtom/dynamicMessagesAtom)
    messages.forEach(msg => {
      set(updateMessageAtom, msg);
    });

    // Set session config for the UI using centralized helper
    // Note: sessionId in config is for display only - actual routing is determined by
    // cloudAgentSessionIdAtom (for sendMessageStream) vs kiloSessionId (for initiateFromKilocodeSession)
    // Use last_mode/last_model from DB - these are set during prepareSession and are the source of truth
    // for prepared sessions. Without them, follow-up messages would fail sendMessageStream validation.
    set(
      sessionConfigAtom,
      buildSessionConfig({
        sessionId: session.cloud_agent_session_id || session.session_id,
        repository: repository || '',
        dbSession: {
          last_mode: session.last_mode,
          last_model: session.last_model,
        },
      })
    );

    // CRITICAL: Only set local session ID to the cloud agent session ID, or null if none.
    // If we set it to the CLI UUID, sendMessage will try to use sendMessageStream with the UUID
    // which fails because sendMessageStream expects agent_xxx format.
    // When this is null, sendMessage will fall through to initiateFromKilocodeSession flow.
    set(currentLocalSessionIdAtom, session.cloud_agent_session_id);

    // Determine resume strategy
    const resumeStrategy: ResumeStrategy = session.cloud_agent_session_id
      ? 'sendMessageStream'
      : 'initiateFromKilocodeSession';

    return {
      sessionData,
      resumeStrategy,
      needsOrgContextPrompt,
    };
  }
);

/**
 * Check staleness by comparing the DB's current updated_at with our highWaterMark
 *
 * highWaterMark represents the DB's updated_at timestamp (in milliseconds) from:
 * - Initial session load (set from DB's updated_at)
 * - session_synced SSE events (which contain the DB's updated_at at sync time)
 *
 * If the DB's current updated_at is newer than our highWaterMark, someone else
 * (another device, CLI, etc.) has updated the session and we should refresh.
 *
 * @param payload - Session ID and DB's current updated_at timestamp
 * @returns True if local data is stale (DB has been updated since we last synced)
 */
export const checkStalenessWithHighWaterMarkAtom = atom(
  null,
  async (
    get,
    set,
    payload: {
      sessionId: string;
      dbUpdatedAt: string;
    }
  ): Promise<boolean> => {
    const { sessionId, dbUpdatedAt } = payload;

    // Get current IndexedDB session
    const currentSession = get(currentIndexedDbSessionAtom);

    // Helper to perform the staleness check
    const performStalenessCheck = (highWaterMark: number): boolean => {
      // If we don't have a highWaterMark (0), we can't determine staleness
      // This happens on first load - don't mark as stale
      if (!highWaterMark) {
        return false;
      }

      // Convert DB's updated_at to milliseconds for comparison
      const dbUpdatedAtMs = new Date(dbUpdatedAt).getTime();

      // Stale if DB's updated_at is NEWER than our highWaterMark
      // Use a 2-second tolerance to handle timestamp precision differences
      const TOLERANCE_MS = 2000;
      return dbUpdatedAtMs > highWaterMark + TOLERANCE_MS;
    };

    // If we have the session in memory, use that
    if (currentSession && currentSession.sessionId === sessionId) {
      const isStale = performStalenessCheck(currentSession.highWaterMark);

      if (isStale) {
        set(sessionStaleAtom, true);
      }

      return isStale;
    }

    // Otherwise, try to get from IndexedDB using jotai-minidb
    if (typeof window !== 'undefined') {
      try {
        const store = getSessionStore();
        const existingData = get(store.item(sessionId));
        if (existingData) {
          const isStale = performStalenessCheck(existingData.highWaterMark);

          if (isStale) {
            set(sessionStaleAtom, true);
          }

          return isStale;
        }
      } catch {
        // Error reading from IndexedDB - assume not stale
      }
    }

    // No local data - not stale (we'll load fresh)
    return false;
  }
);

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
      } catch {
        // Error updating IndexedDB - org context still updated in memory
      }
    }
  }
);

/**
 * Update resume config in IndexedDB
 *
 * Called when user configures session settings (mode, model, env vars, etc.)
 * that should be preserved for session resumption.
 *
 * @param payload - Session ID and resume configuration
 */
export const updateResumeConfigAtom = atom(
  null,
  async (
    get,
    set,
    payload: {
      sessionId: string;
      resumeConfig: StoredResumeConfig;
    }
  ): Promise<void> => {
    const { sessionId, resumeConfig } = payload;

    // Update current session atom if it matches
    const currentSession = get(currentIndexedDbSessionAtom);
    if (currentSession && currentSession.sessionId === sessionId) {
      const updatedSession: IndexedDbSessionData = {
        ...currentSession,
        resumeConfig,
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
            resumeConfig,
            updatedAt: new Date().toISOString(),
          };
          await set(store.setMany, [[sessionId, updatedData]]);
        }
      } catch {
        // Error updating IndexedDB - resume config still updated in memory
      }
    }
  }
);

/**
 * Action atom for clearing IndexedDB session state
 * Called when resetting or starting a new session
 */
export const clearIndexedDbSessionAtom = atom(null, (_get, set) => {
  set(currentIndexedDbSessionAtom, null);
});

/**
 * Action atom for updating highWaterMark in both IndexedDB and memory
 *
 * This MUST be used instead of directly writing to IndexedDB, because:
 * 1. The staleness check reads from currentIndexedDbSessionAtom (memory) first
 * 2. Writing only to IndexedDB creates a desync where memory has stale highWaterMark
 *
 * @param payload - Session ID and new highWaterMark timestamp
 */
export const updateHighWaterMarkAtom = atom(
  null,
  async (
    get,
    set,
    payload: {
      sessionId: string;
      timestamp: number;
    }
  ): Promise<void> => {
    const { sessionId, timestamp } = payload;

    // Detect if timestamp is in seconds (10 digits) or milliseconds (13 digits)
    const timestampMs = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;

    // Update in-memory atom if it's the current session
    const currentSession = get(currentIndexedDbSessionAtom);
    if (currentSession && currentSession.sessionId === sessionId) {
      // Only update if newer
      if (timestampMs > currentSession.highWaterMark) {
        const updatedSession: IndexedDbSessionData = {
          ...currentSession,
          highWaterMark: timestampMs,
          updatedAt: new Date().toISOString(),
        };
        set(currentIndexedDbSessionAtom, updatedSession);
      }
    }

    // Also update IndexedDB for persistence using jotai-minidb (client-side only)
    if (typeof window !== 'undefined') {
      try {
        const store = getSessionStore();
        const existingData = get(store.item(sessionId));
        if (existingData && timestampMs > existingData.highWaterMark) {
          const updatedData: IndexedDbSessionData = {
            ...existingData,
            highWaterMark: timestampMs,
            updatedAt: new Date().toISOString(),
          };
          await set(store.setMany, [[sessionId, updatedData]]);
        }
      } catch {
        // Error updating IndexedDB - highWaterMark still updated in memory
      }
    }
  }
);

// ============================================================================
// SSE Stream Action Atoms
// ============================================================================

/**
 * Action atom for processing an incoming SSE message.
 *
 * This atom handles the race condition where messages may arrive before
 * the IndexedDB session entry is created. It reads the current session ID
 * from Jotai state (always fresh, no stale closures) and either:
 * 1. Appends to IndexedDB if session exists
 * 2. Queues in pendingMessagesAtom if session doesn't exist yet
 *
 * @param message - The CloudMessage to process
 */
export const processIncomingMessageAtom = atom(null, async (get, set, message: CloudMessage) => {
  if (typeof window === 'undefined') return;

  const sessionId = get(currentDbSessionIdAtom);

  if (sessionId) {
    // Session ID is set, try to append to IndexedDB
    const store = getSessionStore();
    const currentData = get(store.item(sessionId));

    if (currentData) {
      // IndexedDB entry exists, append directly
      // Check if message already exists (by timestamp)
      const existingIndex = currentData.messages.findIndex(m => m.ts === message.ts);

      let updatedMessages: CloudMessage[];
      if (existingIndex !== -1) {
        // Update existing message (for partial messages)
        updatedMessages = [...currentData.messages];
        updatedMessages[existingIndex] = message;
      } else {
        // Append new message
        updatedMessages = [...currentData.messages, message];
      }

      const updatedData: IndexedDbSessionData = {
        ...currentData,
        messages: updatedMessages,
        updatedAt: new Date().toISOString(),
      };

      try {
        await set(store.setMany, [[sessionId, updatedData]]);
      } catch {
        // Error appending to IndexedDB - message still in memory
      }
    } else {
      // Session ID set but IndexedDB entry not ready yet - queue the message
      set(pendingMessagesAtom, prev => [...prev, message]);
    }
  } else {
    // No session ID yet - queue the message
    set(pendingMessagesAtom, prev => [...prev, message]);
  }
});

/**
 * Action atom for appending a message to a session in IndexedDB.
 *
 * Used by useCloudAgentStream to persist SSE messages as they arrive.
 * Handles deduplication by timestamp (updates existing message if ts matches).
 *
 * @param payload - Session ID and message to append
 * @returns true if message was appended, false if session doesn't exist in IndexedDB
 */
export const appendMessageToSessionAtom = atom(
  null,
  async (
    get,
    set,
    payload: {
      sessionId: string;
      message: CloudMessage;
    }
  ): Promise<boolean> => {
    if (typeof window === 'undefined') return false;

    const { sessionId, message } = payload;

    try {
      const store = getSessionStore();
      const currentData = get(store.item(sessionId));
      if (!currentData) {
        // Session doesn't exist in IndexedDB yet - caller should queue message
        return false;
      }

      // Check if message already exists (by timestamp)
      const existingIndex = currentData.messages.findIndex(m => m.ts === message.ts);

      let updatedMessages: CloudMessage[];
      if (existingIndex !== -1) {
        // Update existing message (for partial messages)
        updatedMessages = [...currentData.messages];
        updatedMessages[existingIndex] = message;
      } else {
        // Append new message
        updatedMessages = [...currentData.messages, message];
      }

      const updatedData: IndexedDbSessionData = {
        ...currentData,
        messages: updatedMessages,
        updatedAt: new Date().toISOString(),
      };

      await set(store.setMany, [[sessionId, updatedData]]);
      return true;
    } catch {
      return false;
    }
  }
);

/**
 * Action atom for updating the cloudAgentSessionId in IndexedDB.
 *
 * Used when a resumed CLI session receives its cloud-agent session ID.
 *
 * @param payload - Session ID and cloud agent session ID
 */
export const updateCloudAgentSessionIdAtom = atom(
  null,
  async (
    get,
    set,
    payload: {
      sessionId: string;
      cloudAgentSessionId: string;
    }
  ): Promise<void> => {
    if (typeof window === 'undefined') return;

    const { sessionId, cloudAgentSessionId } = payload;

    try {
      const store = getSessionStore();
      const currentData = get(store.item(sessionId));
      if (!currentData) return;

      // Only update if not already set
      if (!currentData.cloudAgentSessionId) {
        const updatedData: IndexedDbSessionData = {
          ...currentData,
          cloudAgentSessionId,
          updatedAt: new Date().toISOString(),
        };
        await set(store.setMany, [[sessionId, updatedData]]);
      }
    } catch {
      // Error updating cloudAgentSessionId in IndexedDB
    }
  }
);

/**
 * Action atom for checking if a session exists in IndexedDB.
 *
 * Used by useCloudAgentStream to determine if a session_created event
 * is for a new session or a resumed CLI session.
 *
 * @param sessionId - The session ID to check
 * @returns The session data if found, null otherwise
 */
export const getSessionFromStoreAtom = atom(null, (get, _set, sessionId: string) => {
  if (typeof window === 'undefined') return null;

  try {
    const store = getSessionStore();
    return get(store.item(sessionId)) ?? null;
  } catch {
    return null;
  }
});

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
    } catch {
      // Error deleting from IndexedDB
    }
  }
);

// ============================================================================
// Utility Functions
// ============================================================================

// Note: extractRepoFromGitUrl has been moved to utils/git-utils.ts
// and is re-exported at the top of this file for backwards compatibility

/**
 * Convert database message format to CloudMessage format
 *
 * Database messages (from R2 ui_messages blob) have a different structure
 * than the CloudMessage type used for streaming/display.
 *
 * CLI messages use:
 * - type: 'say' with say: 'user_feedback' for user messages
 * - type: 'say' with other say values for assistant messages
 * - type: 'ask' for system messages asking for input
 *
 * @param dbMessages - Messages from the database/R2
 * @returns Array of CloudMessage objects
 */
export function convertToCloudMessages(dbMessages: Array<Record<string, unknown>>): CloudMessage[] {
  if (!Array.isArray(dbMessages)) {
    return [];
  }

  const shouldParseTextMetadata = (ask?: string, say?: string) =>
    ask === 'tool' ||
    ask === 'use_mcp_tool' ||
    ask === 'command' ||
    say === 'api_req_started' ||
    say === 'tool';

  const parseTextMetadata = (rawText?: string): Record<string, unknown> | undefined => {
    if (!rawText) return undefined;
    const trimmed = rawText.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined;
    try {
      const parsed = JSON.parse(rawText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
    return undefined;
  };

  return dbMessages
    .map((msg): CloudMessage | null => {
      // Get timestamp
      const ts = msg.ts as number | undefined;
      const timestampStr = msg.timestamp as string | undefined;
      const timestamp = ts || (timestampStr ? new Date(timestampStr).getTime() : Date.now());

      // Get message content
      const text = (msg.text as string) || (msg.content as string) || '';
      const content = (msg.content as string) || (msg.text as string) || '';
      const say = msg.say as string | undefined;
      const ask = msg.ask as string | undefined;
      // Preserve the partial value from DB (default to false if not present)
      const partial = (msg.partial as boolean | undefined) ?? false;
      const rawMetadata = msg.metadata;
      const parsedStringMetadata =
        typeof rawMetadata === 'string' ? parseTextMetadata(rawMetadata) : undefined;
      let metadata =
        rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)
          ? (rawMetadata as Record<string, unknown>)
          : parsedStringMetadata;

      if (!metadata && shouldParseTextMetadata(ask, say)) {
        const rawText =
          typeof msg.text === 'string' ? msg.text : (msg.content as string | undefined);
        metadata = parseTextMetadata(rawText);
      }

      // Determine message type from various formats
      const rawType = msg.type as string | undefined;
      const rawRole = msg.role as string | undefined;

      let messageType: 'user' | 'assistant' | 'system';

      // Handle CLI extension format (type: 'say' | 'ask')
      if (rawType === 'say') {
        // CLI 'say' messages - check the say field for user_feedback
        if (say === 'user_feedback') {
          messageType = 'user';
        } else {
          messageType = 'assistant';
        }
      } else if (rawType === 'ask') {
        // CLI 'ask' messages - these are assistant messages asking for input
        messageType = 'assistant';
      } else if (rawType === 'user' || rawRole === 'user') {
        messageType = 'user';
      } else if (rawType === 'assistant' || rawRole === 'assistant') {
        messageType = 'assistant';
      } else if (rawType === 'system' || rawRole === 'system') {
        messageType = 'system';
      } else {
        // Default to assistant for unknown types
        messageType = 'assistant';
      }

      return {
        ts: timestamp,
        type: messageType,
        say,
        ask,
        text,
        content,
        partial,
        metadata,
      };
    })
    .filter((msg): msg is CloudMessage => msg !== null);
}

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

// ============================================================================
// IndexedDB Cleanup
// ============================================================================

/** Default max age for IndexedDB sessions: 60 minutes */
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Derived atom that reads all entries from the IndexedDB session store.
 * Used by the cleanup atom to find old sessions.
 */
export const indexedDbEntriesAtom = atom(get => {
  if (typeof window === 'undefined') {
    return [] as [string, IndexedDbSessionData][];
  }
  const store = getSessionStore();
  return get(store.entries);
});

/**
 * Action atom for cleaning up old sessions from IndexedDB.
 *
 * Deletes sessions where updatedAt is older than the specified max age.
 * Excludes the current active session from cleanup.
 *
 * Uses jotai-minidb's entries and delete atoms for reactive cleanup.
 *
 * @param maxAgeMs - Maximum age in milliseconds (default: 60 minutes)
 * @returns Number of sessions deleted
 */
export const cleanupOldSessionsAtom = atom(
  null,
  async (get, set, maxAgeMs: number = DEFAULT_MAX_AGE_MS): Promise<number> => {
    if (typeof window === 'undefined') {
      return 0;
    }

    const currentSessionId = get(currentDbSessionIdAtom);
    const cutoffTime = Date.now() - maxAgeMs;
    let deletedCount = 0;

    try {
      const store = getSessionStore();
      const entries = get(store.entries);

      // Find sessions to delete
      const sessionsToDelete: string[] = [];

      for (const [sessionId, session] of entries) {
        // Skip the current active session
        if (sessionId === currentSessionId) {
          continue;
        }

        const updatedAt = new Date(session.updatedAt).getTime();

        if (updatedAt < cutoffTime) {
          sessionsToDelete.push(sessionId);
        }
      }

      // Delete old sessions using jotai-minidb's delete atom
      for (const sessionId of sessionsToDelete) {
        try {
          await set(store.delete, sessionId);
          deletedCount++;
        } catch {
          // Silently ignore deletion errors for cleanup
        }
      }
    } catch {
      // Cleanup failed - will retry on next run
    }

    return deletedCount;
  }
);
