import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { type DbSessionDetails, type IndexedDbSessionData } from '../store/db-session-atoms';
import { extractRepoFromGitUrl } from '../utils/git-utils';
import type { ResumeConfig, StreamResumeConfig } from '../types';
import { minimax_m21_free_slackbot_model } from '@/lib/providers/minimax';

// Re-export StreamResumeConfig for backwards compatibility
export type { StreamResumeConfig };

/**
 * Build streamResumeConfig from available sources.
 * Priority: local resumeConfig > IndexedDB stored config
 *
 * Exported for testing.
 */
export function buildStreamResumeConfig(params: {
  resumeConfig: ResumeConfig | null;
  pendingResumeSession: DbSessionDetails | null;
  currentIndexedDbSession: IndexedDbSessionData | null;
}): StreamResumeConfig | null {
  const { resumeConfig, pendingResumeSession, currentIndexedDbSession } = params;

  // Local state takes priority (just configured in modal)
  if (resumeConfig && pendingResumeSession) {
    const repository = extractRepoFromGitUrl(pendingResumeSession.git_url) || '';
    return {
      mode: resumeConfig.mode,
      model: resumeConfig.model,
      envVars: resumeConfig.envVars,
      setupCommands: resumeConfig.setupCommands,
      githubRepo: repository,
    };
  }

  // Fall back to IndexedDB stored config
  if (currentIndexedDbSession?.resumeConfig && currentIndexedDbSession.repository) {
    return {
      mode: currentIndexedDbSession.resumeConfig.mode as StreamResumeConfig['mode'],
      model: currentIndexedDbSession.resumeConfig.model,
      envVars: currentIndexedDbSession.resumeConfig.envVars,
      setupCommands: currentIndexedDbSession.resumeConfig.setupCommands,
      githubRepo: currentIndexedDbSession.repository,
    };
  }

  return null;
}

/**
 * Determine if the resume config modal needs to be shown for a session.
 *
 * The modal is needed when:
 * 1. A session is loaded from DB
 * 2. It's either a CLI session (no cloud_agent_session_id) OR a legacy web session
 *    that has cloud_agent_session_id but no last_model
 * 3. No resume config is stored in IndexedDB yet
 *
 * Exported for testing.
 */
export function needsResumeConfigModal(params: {
  loadedDbSession: DbSessionDetails | null;
  currentIndexedDbSession: IndexedDbSessionData | null;
}): boolean {
  const { loadedDbSession, currentIndexedDbSession } = params;

  if (!loadedDbSession) return false;

  if (
    loadedDbSession.last_model === minimax_m21_free_slackbot_model.public_id &&
    !currentIndexedDbSession?.resumeConfig
  )
    return true;

  const isCliSession = !loadedDbSession.cloud_agent_session_id;

  // Sessions from cli_sessions_v2 table store mode/model in the cloud-agent DO,
  // so they don't need the resume config modal.
  // Only CLI sessions (no cloud_agent_session_id) need the modal to configure mode/model.
  return isCliSession && !currentIndexedDbSession?.resumeConfig;
}

type UseResumeConfigModalOptions = {
  /** Current DB session ID (UUID from cli_sessions table) */
  currentDbSessionId: string | null;
  /** Current session data from IndexedDB */
  currentIndexedDbSession: IndexedDbSessionData | null;
  /**
   * Session just loaded from database (source of truth for modal visibility).
   * When set, the hook derives whether to show the modal based on:
   * - session.cloud_agent_session_id being null (CLI session needing config)
   * - user not having dismissed the modal for this session
   */
  loadedDbSession: DbSessionDetails | null;
  /**
   * Resume config that has been successfully persisted to IndexedDB.
   * Used to build streamResumeConfig only after persistence succeeds.
   * This prevents enabling chat input while persistence is pending or if it failed.
   */
  persistedResumeConfig: ResumeConfig | null;
};

type UseResumeConfigModalReturn = {
  /** Whether the resume config modal is open */
  showResumeModal: boolean;
  /** The session being configured (null if modal closed) */
  pendingResumeSession: DbSessionDetails | null;
  /** Git state for the pending session */
  pendingGitState: { branch?: string } | null;
  /** Config for useCloudAgentStream (from modal or IndexedDB) */
  streamResumeConfig: StreamResumeConfig | null;
  /** The confirmed config from modal (for needsResumeConfig check) */
  resumeConfig: ResumeConfig | null;
  /** Reopen the modal (for "Configure now" banner) */
  reopenResumeModal: () => void;
  /** Handle modal confirmation */
  handleResumeConfirm: (config: ResumeConfig) => Promise<void>;
  /** Handle modal close/cancel */
  handleResumeClose: () => void;
  /** Clear resume config (used when persistence fails) */
  clearResumeConfig: () => void;
};

/**
 * Hook to manage the ResumeConfigModal state and logic.
 *
 * The modal visibility is DERIVED from state, not set imperatively:
 * - Shows when loadedDbSession is a CLI session (cloud_agent_session_id is null)
 * - AND user hasn't dismissed it for this session
 * - AND there's no stored resumeConfig in IndexedDB
 *
 * Handles:
 * - Derived modal visibility based on loadedDbSession
 * - Building streamResumeConfig for useCloudAgentStream
 * - Persisting config to IndexedDB on confirm
 * - Updating sessionConfig atom for UI
 * - Resetting state when switching sessions
 */
export function useResumeConfigModal({
  currentDbSessionId,
  currentIndexedDbSession,
  loadedDbSession,
  persistedResumeConfig,
}: UseResumeConfigModalOptions): UseResumeConfigModalReturn {
  // Track if user has dismissed the modal for the current session
  const [dismissedSessionId, setDismissedSessionId] = useState<string | null>(null);

  // Track if user has explicitly re-opened the modal (from "Configure now" banner)
  const [forceShowModal, setForceShowModal] = useState(false);

  // Pending git state for the modal (not currently used but kept for API compatibility)
  const [pendingGitState, setPendingGitState] = useState<{ branch?: string } | null>(null);

  // Confirmed config from modal
  const [resumeConfig, setResumeConfig] = useState<ResumeConfig | null>(null);

  // Track previous session ID to detect session switches
  const prevDbSessionIdRef = useRef<string | null>(null);

  // Reset dismissed state when switching sessions
  useEffect(() => {
    const isSessionSwitch =
      prevDbSessionIdRef.current !== null && currentDbSessionId !== prevDbSessionIdRef.current;

    if (isSessionSwitch) {
      setDismissedSessionId(null);
      setForceShowModal(false);
      setResumeConfig(null);
      setPendingGitState(null);
    }

    prevDbSessionIdRef.current = currentDbSessionId;
  }, [currentDbSessionId]);

  // DERIVE modal visibility from state - uses the extracted needsResumeConfigModal function
  // Modal shows when:
  // 1. The session needs resume configuration (CLI session or legacy without model)
  // 2. User hasn't dismissed the modal for this session
  // 3. OR user explicitly reopened with "Configure now"
  const sessionNeedsConfig = needsResumeConfigModal({
    loadedDbSession,
    currentIndexedDbSession,
  });

  const showResumeModal =
    (sessionNeedsConfig && dismissedSessionId !== currentDbSessionId) || forceShowModal;

  // The pending session is the loaded session when modal should show
  const pendingResumeSession = showResumeModal ? loadedDbSession : null;

  // Build resumeConfig for useCloudAgentStream
  // IMPORTANT: Uses persistedResumeConfig (not transient resumeConfig) to ensure
  // config has been successfully saved before enabling chat input
  const streamResumeConfig = useMemo<StreamResumeConfig | null>(
    () =>
      buildStreamResumeConfig({
        resumeConfig: persistedResumeConfig,
        pendingResumeSession: loadedDbSession, // Use loadedDbSession for repo extraction
        currentIndexedDbSession,
      }),
    [persistedResumeConfig, loadedDbSession, currentIndexedDbSession]
  );

  // Reopen the modal (for "Configure now" banner)
  const reopenResumeModal = useCallback(() => {
    setForceShowModal(true);
    setDismissedSessionId(null);
  }, []);

  // Handle modal confirmation - captures config and closes modal
  const handleResumeConfirm = useCallback(async (config: ResumeConfig) => {
    setForceShowModal(false);
    setResumeConfig(config);
  }, []);

  // Handle modal close/cancel
  const handleResumeClose = useCallback(() => {
    setForceShowModal(false);
    // Mark as dismissed for this session so modal doesn't auto-show again
    if (currentDbSessionId) {
      setDismissedSessionId(currentDbSessionId);
    }
  }, [currentDbSessionId]);

  // Clear resume config (used when persistence fails to allow retry)
  const clearResumeConfig = useCallback(() => {
    setResumeConfig(null);
  }, []);

  return {
    showResumeModal,
    pendingResumeSession,
    pendingGitState,
    streamResumeConfig,
    resumeConfig,
    reopenResumeModal,
    handleResumeConfirm,
    handleResumeClose,
    clearResumeConfig,
  };
}
