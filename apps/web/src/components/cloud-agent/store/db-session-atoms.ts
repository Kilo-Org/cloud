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

export type OrgContext = {
  organizationId: string;
};

export type StoredResumeConfig = {
  mode: string;
  model: string;
  envVars?: Record<string, string>;
  setupCommands?: string[];
};

export type IndexedDbSessionData = {
  /** Local session ID (UUID) - used as the key in IndexedDB */
  sessionId: string;

  /** Cloud agent session ID (agent_xxx format) - set when connected to cloud */
  cloudAgentSessionId: string | null;

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

  gitUrl: string | null;

  /** Repository in owner/repo format */
  repository: string | null;

  orgContext: OrgContext | null;

  /** Whether org context has been confirmed by user */
  orgContextConfirmed: boolean;

  resumeConfig: StoredResumeConfig | null;

  createdAt: string;

  updatedAt: string;

  lastMode: string | null;

  lastModel: string | null;
};

let _sessionStore: MiniDb<IndexedDbSessionData> | null = null;

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

export type ResumeStrategy = 'sendMessageStream' | 'initiateFromKilocodeSession';

export type LoadSessionResult = {
  session: DbSessionDetails;
  messages: CloudMessage[];
  resumeStrategy: ResumeStrategy;
};

export const dbSessionsAtom = atom<DbSession[]>([]);

export const sessionsLoadingAtom = atom(false);

export const sessionsErrorAtom = atom<string | null>(null);

/**
 * Current database session ID (UUID from cli_sessions table)
 * This differs from currentLocalSessionIdAtom which holds the cloud-agent session ID
 */
export const currentDbSessionIdAtom = atom<string | null>(null);

export const cloudAgentSessionIdAtom = atom<string | null>(null);

export const sessionStaleAtom = atom(false);

export const sessionsNextCursorAtom = atom<string | null>(null);

/**
 * Queue for messages that arrive before IndexedDB session entry is created.
 * This handles the race condition where SSE messages arrive between
 * session_created event and completion of createNewSessionInIndexedDbAtom.
 */
export const pendingMessagesAtom = atom<CloudMessage[]>([]);

export const recentSessionsAtom = atom(get => {
  const isLoading = get(sessionsLoadingAtom);
  if (isLoading) return [];
  return get(dbSessionsAtom);
});

export const hasMoreSessionsAtom = atom(get => {
  return get(sessionsNextCursorAtom) !== null;
});

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

export const setSessionsLoadingAtom = atom(null, (_get, set, loading: boolean) => {
  set(sessionsLoadingAtom, loading);
});

export const setSessionsErrorAtom = atom(null, (_get, set, error: string | null) => {
  set(sessionsErrorAtom, error);
  set(sessionsLoadingAtom, false);
});

export const clearSessionStaleAtom = atom(null, (_get, set) => {
  set(sessionStaleAtom, false);
});

export const linkCloudAgentSessionAtom = atom(null, (_get, set, cloudAgentSessionId: string) => {
  set(cloudAgentSessionIdAtom, cloudAgentSessionId);
});

export const setCurrentDbSessionIdAtom = atom(null, (_get, set, sessionId: string | null) => {
  set(currentDbSessionIdAtom, sessionId);
});

/**
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
      title: string;
      orgContext?: OrgContext | null;
      mode?: 'architect' | 'code' | 'ask' | 'debug' | 'orchestrator';
      model?: string;
    }
  ): Promise<void> => {
    const { kiloSessionId, cloudAgentSessionId, repository, title, orgContext, mode, model } =
      payload;

    set(currentDbSessionIdAtom, kiloSessionId);
    set(cloudAgentSessionIdAtom, cloudAgentSessionId);

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
      loadedFromDbAt: null,
      title,
      gitUrl: null,
      repository,
      orgContext: orgContext ?? null,
      orgContextConfirmed: true, // New session - context is implicit (either org or personal)
      resumeConfig,
      createdAt: now,
      updatedAt: now,
      lastMode: mode ?? null,
      lastModel: model ?? null,
    };

    if (typeof window !== 'undefined') {
      try {
        const store = getSessionStore();
        await set(store.setMany, [[kiloSessionId, sessionData]]);

        const pendingMessages = get(pendingMessagesAtom);
        if (pendingMessages.length > 0) {
          const currentData = get(store.item(kiloSessionId));
          if (currentData) {
            const updatedData: IndexedDbSessionData = {
              ...currentData,
              messages: [...currentData.messages, ...pendingMessages],
              updatedAt: new Date().toISOString(),
            };
            await set(store.setMany, [[kiloSessionId, updatedData]]);
          }

          set(pendingMessagesAtom, []);
        }
      } catch {
        // Error saving to IndexedDB - session will still work in memory
      }
    }

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

export const resetDbSessionAtom = atom(null, (_get, set) => {
  set(currentDbSessionIdAtom, null);
  set(cloudAgentSessionIdAtom, null);
  set(sessionStaleAtom, false);
});

export const currentIndexedDbSessionAtom = atom<IndexedDbSessionData | null>(null);

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

    let existingData: IndexedDbSessionData | null = null;
    if (typeof window !== 'undefined') {
      try {
        const store = getSessionStore();
        existingData = get(store.item(session.session_id)) ?? null;
      } catch {
        // Error reading from IndexedDB - will create fresh session data
      }
    }

    const repository = extractRepoFromGitUrl(session.git_url);

    // Determine if we need org context prompt
    // For sessions with version >= 2, the organization_id field is reliable:
    // - If organization_id is set, we know it's an org session
    // - If organization_id is null, we know it's a personal session
    // For older sessions (version < 2), we need to prompt if not confirmed
    const knowsOrgContextFromDb = session.version >= 2;
    const needsOrgContextPrompt =
      !knowsOrgContextFromDb && (!existingData || !existingData.orgContextConfirmed);

    let sessionData: IndexedDbSessionData;

    const dbUpdatedAtMs = new Date(session.updated_at).getTime();

    if (existingData) {
      sessionData = {
        ...existingData,
        cloudAgentSessionId: session.cloud_agent_session_id ?? existingData.cloudAgentSessionId,
        title: session.title ?? existingData.title,
        gitUrl: session.git_url ?? existingData.gitUrl,
        repository: repository ?? existingData.repository,
        messages: messages,
        // CRITICAL: Set highWaterMark to DB's updated_at. After loading from DB,
        // the DB's timestamp becomes our sync reference point. Don't use Math.max
        // because that can keep an old value that causes false staleness reports.
        highWaterMark: dbUpdatedAtMs,
        loadedFromDbAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastMode: session.last_mode ?? existingData.lastMode,
        lastModel: session.last_model ?? existingData.lastModel,
      };
    } else {
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
          orgContextConfirmed: knowsOrgContextFromDb,
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

    if (typeof window !== 'undefined') {
      try {
        const store = getSessionStore();
        await set(store.setMany, [[session.session_id, sessionData]]);
      } catch {
        // Error saving to IndexedDB - session will still work in memory
      }
    }

    set(currentIndexedDbSessionAtom, sessionData);

    set(sessionStaleAtom, false);

    set(currentDbSessionIdAtom, session.session_id);
    set(cloudAgentSessionIdAtom, session.cloud_agent_session_id);

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

    const currentSession = get(currentIndexedDbSessionAtom);

    const performStalenessCheck = (highWaterMark: number): boolean => {
      // If we don't have a highWaterMark (0), we can't determine staleness
      // This happens on first load - don't mark as stale
      if (!highWaterMark) {
        return false;
      }

      // Convert DB's updated_at to milliseconds for comparison
      const dbUpdatedAtMs = new Date(dbUpdatedAt).getTime();

      // Use a 2-second tolerance to handle timestamp precision differences
      const TOLERANCE_MS = 2000;
      return dbUpdatedAtMs > highWaterMark + TOLERANCE_MS;
    };

    if (currentSession && currentSession.sessionId === sessionId) {
      const isStale = performStalenessCheck(currentSession.highWaterMark);

      if (isStale) {
        set(sessionStaleAtom, true);
      }

      return isStale;
    }

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

    const currentSession = get(currentIndexedDbSessionAtom);
    if (currentSession && currentSession.sessionId === sessionId) {
      const updatedSession: IndexedDbSessionData = {
        ...currentSession,
        resumeConfig,
        updatedAt: new Date().toISOString(),
      };
      set(currentIndexedDbSessionAtom, updatedSession);
    }

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

    const currentSession = get(currentIndexedDbSessionAtom);
    if (currentSession && currentSession.sessionId === sessionId) {
      if (timestampMs > currentSession.highWaterMark) {
        const updatedSession: IndexedDbSessionData = {
          ...currentSession,
          highWaterMark: timestampMs,
          updatedAt: new Date().toISOString(),
        };
        set(currentIndexedDbSessionAtom, updatedSession);
      }
    }

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

/**
 * Action atom for processing an incoming SSE message.
 *
 * This atom handles the race condition where messages may arrive before
 * the IndexedDB session entry is created. It reads the current session ID
 * from Jotai state (always fresh, no stale closures) and either:
 * 1. Appends to IndexedDB if session exists
 * 2. Queues in pendingMessagesAtom if session doesn't exist yet
 */
export const processIncomingMessageAtom = atom(null, async (get, set, message: CloudMessage) => {
  if (typeof window === 'undefined') return;

  const sessionId = get(currentDbSessionIdAtom);

  if (sessionId) {
    const store = getSessionStore();
    const currentData = get(store.item(sessionId));

    if (currentData) {
      const existingIndex = currentData.messages.findIndex(m => m.ts === message.ts);

      let updatedMessages: CloudMessage[];
      if (existingIndex !== -1) {
        // Update existing message (for partial messages)
        updatedMessages = [...currentData.messages];
        updatedMessages[existingIndex] = message;
      } else {
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
      set(pendingMessagesAtom, prev => [...prev, message]);
    }
  } else {
    set(pendingMessagesAtom, prev => [...prev, message]);
  }
});

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

      const existingIndex = currentData.messages.findIndex(m => m.ts === message.ts);

      let updatedMessages: CloudMessage[];
      if (existingIndex !== -1) {
        // Update existing message (for partial messages)
        updatedMessages = [...currentData.messages];
        updatedMessages[existingIndex] = message;
      } else {
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

export const getSessionFromStoreAtom = atom(null, (get, _set, sessionId: string) => {
  if (typeof window === 'undefined') return null;

  try {
    const store = getSessionStore();
    return get(store.item(sessionId)) ?? null;
  } catch {
    return null;
  }
});

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
      const ts = msg.ts as number | undefined;
      const timestampStr = msg.timestamp as string | undefined;
      const timestamp = ts || (timestampStr ? new Date(timestampStr).getTime() : Date.now());

      const text = (msg.text as string) || (msg.content as string) || '';
      const content = (msg.content as string) || (msg.text as string) || '';
      const say = msg.say as string | undefined;
      const ask = msg.ask as string | undefined;
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

      const rawType = msg.type as string | undefined;
      const rawRole = msg.role as string | undefined;

      let messageType: 'user' | 'assistant' | 'system';

      if (rawType === 'say') {
        if (say === 'user_feedback') {
          messageType = 'user';
        } else {
          messageType = 'assistant';
        }
      } else if (rawType === 'ask') {
        messageType = 'assistant';
      } else if (rawType === 'user' || rawRole === 'user') {
        messageType = 'user';
      } else if (rawType === 'assistant' || rawRole === 'assistant') {
        messageType = 'assistant';
      } else if (rawType === 'system' || rawRole === 'system') {
        messageType = 'system';
      } else {
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
 * Note: Visual truncation should be handled via CSS (e.g., `truncate` class)
 * rather than JavaScript string manipulation for responsive behavior.
 */
export function getSessionDisplayTitle(session: DbSession): string {
  if (session.title) {
    return session.title;
  }

  const repo = extractRepoFromGitUrl(session.git_url);
  if (repo) return repo;

  return `Session ${session.session_id.substring(0, 8)}`;
}

const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;

export const indexedDbEntriesAtom = atom(get => {
  if (typeof window === 'undefined') {
    return [] as [string, IndexedDbSessionData][];
  }
  const store = getSessionStore();
  return get(store.entries);
});

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

      const sessionsToDelete: string[] = [];

      for (const [sessionId, session] of entries) {
        if (sessionId === currentSessionId) {
          continue;
        }

        const updatedAt = new Date(session.updatedAt).getTime();

        if (updatedAt < cutoffTime) {
          sessionsToDelete.push(sessionId);
        }
      }

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
