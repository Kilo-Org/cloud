/**
 * CloudChatContainer - Business logic and state management
 *
 * Contains all hooks, effects, state, and business logic.
 * Renders CloudChatPresentation with all necessary props.
 */

'use client';

import { useEffect, useCallback, useState, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { useTRPC, useRawTRPCClient } from '@/lib/trpc/utils';
import {
  staticMessagesAtom,
  dynamicMessagesAtom,
  isStreamingAtom,
  errorAtom,
  currentSessionIdAtom,
  sessionConfigAtom,
  totalCostAtom,
  getChildSessionMessagesAtom,
} from './store/atoms';
import { buildSessionConfig, needsResumeConfiguration } from './session-config';
import {
  currentDbSessionIdAtom,
  cloudAgentSessionIdAtom,
  sessionStaleAtom,
  loadSessionToIndexedDbAtom,
  checkStalenessWithHighWaterMarkAtom,
  currentIndexedDbSessionAtom,
  cleanupOldSessionsAtom,
  isOldSessionFormat,
  parseStoredMessages,
  type ResumeStrategy,
  type DbSessionDetails,
  type IndexedDbSessionData,
} from './store/db-session-atoms';
import { useCloudAgentStream } from './useCloudAgentStream';
import { useAutoScroll } from './hooks/useAutoScroll';
import { useCelebrationSound } from '@/hooks/useCelebrationSound';
import { useSidebarSessions } from './hooks/useSidebarSessions';
import { useOrganizationModels } from './hooks/useOrganizationModels';
import { useSessionDeletion } from './hooks/useSessionDeletion';
import { useResumeConfigModal } from './hooks/useResumeConfigModal';
import { useSessionConfigCommand } from './hooks/useSessionConfigCommand';
import { useOrgContextCommand } from './hooks/useOrgContextCommand';
import { usePreparedSession } from './hooks/usePreparedSession';
import { buildPrepareSessionRepoParams } from './utils/git-utils';
import { useSlashCommandSets } from '@/hooks/useSlashCommandSets';
import { CloudChatPresentation } from './CloudChatPresentation';
import type { ResumeConfig } from './ResumeConfigModal';
import type { AgentMode, SessionStartConfig } from './types';

type CloudChatContainerProps = {
  organizationId?: string;
};

/**
 * Discriminated union for resume config lifecycle
 * Prevents impossible states and makes persistence status explicit
 */
type ResumeConfigState =
  | { status: 'none' }
  | { status: 'pending'; config: ResumeConfig }
  | { status: 'persisting'; config: ResumeConfig }
  | { status: 'persisted'; config: ResumeConfig }
  | { status: 'failed'; config: ResumeConfig; error: Error };

export function CloudChatContainer({ organizationId }: CloudChatContainerProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();

  // Read from Jotai atoms
  const staticMessages = useAtomValue(staticMessagesAtom);
  const dynamicMessages = useAtomValue(dynamicMessagesAtom);
  const isStreaming = useAtomValue(isStreamingAtom);
  const error = useAtomValue(errorAtom);
  const currentSessionId = useAtomValue(currentSessionIdAtom);
  const sessionConfig = useAtomValue(sessionConfigAtom);
  const totalCost = useAtomValue(totalCostAtom);

  // Write to atoms
  const setError = useSetAtom(errorAtom);
  const setSessionConfig = useSetAtom(sessionConfigAtom);

  // Child session messages getter
  const getChildSessionMessages = useAtomValue(getChildSessionMessagesAtom);

  // DB session atoms
  const currentDbSessionId = useAtomValue(currentDbSessionIdAtom);
  const isStale = useAtomValue(sessionStaleAtom);

  // IndexedDB session atoms
  const currentIndexedDbSession = useAtomValue(currentIndexedDbSessionAtom);
  const loadSessionToIndexedDb = useSetAtom(loadSessionToIndexedDbAtom);
  const checkStalenessWithHighWaterMark = useSetAtom(checkStalenessWithHighWaterMarkAtom);
  const cleanupOldSessions = useSetAtom(cleanupOldSessionsAtom);

  // Command hooks for modal handlers
  const { applyResumeConfig } = useSessionConfigCommand();
  const { prepareSession } = usePreparedSession({
    organizationId,
    kiloSessionId: currentDbSessionId ?? undefined,
  });
  const { applyOrgContext } = useOrgContextCommand(organizationId);

  // Cleanup old IndexedDB sessions on mount
  useEffect(() => {
    void cleanupOldSessions();
  }, [cleanupOldSessions]);

  // Cloud agent session ID
  const cloudAgentSessionId = useAtomValue(cloudAgentSessionIdAtom);

  // Resume strategy tracking
  const [_resumeStrategy, setResumeStrategy] = useState<ResumeStrategy | null>(null);

  // Track the session loaded from DB
  const [loadedDbSession, setLoadedDbSession] = useState<DbSessionDetails | null>(null);

  // Track whether org context modal was dismissed
  const [orgContextDismissedForSession, setOrgContextDismissedForSession] = useState<string | null>(
    null
  );

  // Single source of truth for resume config lifecycle
  const [resumeConfigState, setResumeConfigState] = useState<ResumeConfigState>({ status: 'none' });

  // Resume config modal hook
  const {
    showResumeModal,
    pendingResumeSession,
    pendingGitState,
    streamResumeConfig,
    reopenResumeModal,
    handleResumeConfirm: handleResumeConfirmFromHook,
    handleResumeClose,
    clearResumeConfig,
  } = useResumeConfigModal({
    currentDbSessionId,
    currentIndexedDbSession,
    loadedDbSession,
    persistedResumeConfig:
      resumeConfigState.status === 'persisted' ? resumeConfigState.config : null,
  });

  // Wrap the modal confirm handler to set discriminated union state
  const handleResumeConfirm = useCallback(
    async (config: ResumeConfig) => {
      await handleResumeConfirmFromHook(config);
      setResumeConfigState({ status: 'pending', config });
    },
    [handleResumeConfirmFromHook]
  );

  // Org context modal state
  const [needsOrgContextPrompt, setNeedsOrgContextPrompt] = useState(false);
  const [pendingSessionForOrgContext, setPendingSessionForOrgContext] =
    useState<IndexedDbSessionData | null>(null);

  // Derive org context modal visibility
  const showOrgContextModal =
    needsOrgContextPrompt &&
    pendingSessionForOrgContext !== null &&
    orgContextDismissedForSession !== currentDbSessionId;

  // Fetch organization models
  const { modelOptions, isLoadingModels, defaultModel } = useOrganizationModels(organizationId);

  // Mobile sheet state
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);

  // Input toolbar state for mode/model selection
  // These persist between messages and update sessionConfig when changed
  const [inputMode, setInputMode] = useState<AgentMode>('build');
  const [inputModel, setInputModel] = useState<string>('');

  // Auto-scroll behavior
  const { messagesEndRef, scrollContainerRef, showScrollButton, handleScroll, scrollToBottom } =
    useAutoScroll(dynamicMessages);

  // Slash commands
  const { availableCommands } = useSlashCommandSets();

  // Celebration sound
  const { play: playCelebrationSound, soundEnabled, setSoundEnabled } = useCelebrationSound();

  // Toggle sound handler
  const handleToggleSound = useCallback(() => {
    setSoundEnabled(prev => !prev);
  }, [setSoundEnabled]);

  // Callback to update URL when a new kilo session is created
  const handleKiloSessionCreated = useCallback((kiloSessionId: string) => {
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('sessionId', kiloSessionId);
      window.history.replaceState(window.history.state, '', url.toString());
    }
  }, []);

  // Track whether the session has been initiated
  const [isSessionInitiated, setIsSessionInitiated] = useState(false);

  // Legacy sessions may have cloudAgentSessionId without prepared state in the DO
  const [needsLegacyPrepare, setNeedsLegacyPrepare] = useState(false);
  const [preflightComplete, setPreflightComplete] = useState(false);
  const preflightedCloudAgentSessionRef = useRef<string | null>(null);

  // Track whether we've already triggered auto-initiation
  const [autoInitiatedSessionId, setAutoInitiatedSessionId] = useState<string | null>(null);

  // Callback when session is confirmed initiated
  const handleSessionInitiated = useCallback(() => {
    setIsSessionInitiated(true);
  }, []);

  // Sidebar sessions (scoped to organization when in org context, personal-only when undefined)
  // Pass null for personal chat to filter out org sessions, or the org ID for org chat
  const { sessions, refetchSessions } = useSidebarSessions({
    organizationId: organizationId ?? null,
  });

  // Callback for stream completion
  const handleStreamComplete = useCallback(() => {
    playCelebrationSound();
    refetchSessions();
  }, [playCelebrationSound, refetchSessions]);

  // Stream hook (V2 WebSocket-based)
  const {
    sendMessage: sendMessageV2,
    initiateFromPreparedSession,
    connectToExistingSession,
    interruptSession,
    cleanup,
    connectionState,
  } = useCloudAgentStream({
    cloudAgentSessionId: cloudAgentSessionId ?? '',
    organizationId,
    onComplete: handleStreamComplete,
    onKiloSessionCreated: handleKiloSessionCreated,
    onSessionInitiated: handleSessionInitiated,
  });

  // Wrapper for sendMessage that doesn't use sessionIdOverride
  const sendMessage = useCallback(
    (
      prompt: string,
      sessionIdOverride: string | null,
      mode: SessionStartConfig['mode'],
      model: string
    ) => {
      // Use the session ID override if provided, otherwise fall back to current session
      const sessionId = sessionIdOverride || cloudAgentSessionId || '';
      void sendMessageV2(prompt, sessionId, mode, model);
    },
    [sendMessageV2, cloudAgentSessionId]
  );

  // Effect to populate sessionConfig when resumeConfig is loaded from IndexedDB
  useEffect(() => {
    if (
      currentIndexedDbSession?.resumeConfig &&
      currentIndexedDbSession.repository &&
      !sessionConfig?.model
    ) {
      setSessionConfig(
        buildSessionConfig({
          sessionId:
            currentIndexedDbSession.cloudAgentSessionId || currentIndexedDbSession.sessionId,
          repository: currentIndexedDbSession.repository,
          resumeConfig: {
            mode: currentIndexedDbSession.resumeConfig.mode,
            model: currentIndexedDbSession.resumeConfig.model,
          },
        })
      );
    }
  }, [currentIndexedDbSession, sessionConfig, setSessionConfig]);

  // Sync input toolbar state from sessionConfig
  // Only sync when sessionConfig changes (new session loaded or initial config)
  useEffect(() => {
    if (sessionConfig?.mode) {
      setInputMode(sessionConfig.mode as AgentMode);
    }
    if (sessionConfig?.model) {
      setInputModel(sessionConfig.model);
    }
  }, [sessionConfig?.mode, sessionConfig?.model]);

  // Handle input mode change - update local state and persist to sessionConfig
  const handleInputModeChange = useCallback(
    (mode: AgentMode) => {
      setInputMode(mode);
      // Update sessionConfig to persist the change
      if (sessionConfig) {
        setSessionConfig({
          ...sessionConfig,
          mode,
        });
      }
    },
    [sessionConfig, setSessionConfig]
  );

  // Handle input model change - update local state and persist to sessionConfig
  const handleInputModelChange = useCallback(
    (model: string) => {
      setInputModel(model);
      // Update sessionConfig to persist the change
      if (sessionConfig) {
        setSessionConfig({
          ...sessionConfig,
          model,
        });
      }
    },
    [sessionConfig, setSessionConfig]
  );

  // Get sessionId from URL params
  const sessionIdFromParams = searchParams?.get('sessionId');

  // Track if we're currently loading from DB
  const [isLoadingFromDb, setIsLoadingFromDb] = useState(false);
  const loadedDbSessionIdRef = useRef<string | null>(null);

  // tRPC queries for DB session loading (V2 table)
  // Use getWithRuntimeState to fetch both DB metadata and DO runtime state in a single call
  const { refetch: refetchSession } = useQuery(
    trpc.cliSessionsV2.getWithRuntimeState.queryOptions(
      { session_id: sessionIdFromParams || currentDbSessionId || '' },
      { enabled: false }
    )
  );

  const { refetch: refetchMessages } = useQuery(
    trpc.cliSessionsV2.getSessionMessages.queryOptions(
      { session_id: sessionIdFromParams || currentDbSessionId || '' },
      { enabled: false }
    )
  );

  // Load session from database when sessionId parameter is present
  // Uses getWithRuntimeState to fetch both DB metadata and DO runtime state in a single call
  useEffect(() => {
    if (
      !sessionIdFromParams ||
      isLoadingFromDb ||
      loadedDbSessionIdRef.current === sessionIdFromParams ||
      isStreaming
    ) {
      return;
    }

    const loadFromDb = async () => {
      setIsLoadingFromDb(true);
      setPreflightComplete(false);
      try {
        const [sessionResult, messagesResult] = await Promise.all([
          refetchSession(),
          refetchMessages(),
        ]);

        if (sessionResult.data) {
          const sessionData = sessionResult.data;
          const runtimeState = sessionData.runtimeState;

          // Convert V2 session to DbSessionDetails format
          // Include mode/model from runtime state if available
          const session: DbSessionDetails = {
            session_id: sessionData.session_id,
            title: sessionData.title,
            cloud_agent_session_id: sessionData.cloud_agent_session_id,
            organization_id: sessionData.organization_id,
            created_at: new Date(sessionData.created_at),
            updated_at: new Date(sessionData.updated_at),
            // Include mode/model from DO runtime state so needsResumeConfigModal works correctly
            last_mode: runtimeState?.mode,
            last_model: runtimeState?.model,
          };

          // Check if session has been initiated - prefer DO state, fallback to message check
          const hasMessages = Boolean(
            messagesResult.data &&
              Array.isArray(messagesResult.data.messages) &&
              messagesResult.data.messages.length > 0
          );
          const isInitiated = runtimeState?.initiatedAt ? true : hasMessages;
          setIsSessionInitiated(isInitiated);

          // Check if this is a legacy session (has cloud_agent_session_id but no preparedAt in DO)
          if (sessionData.cloud_agent_session_id) {
            if (!runtimeState || !runtimeState.preparedAt) {
              setNeedsLegacyPrepare(true);
            } else {
              setNeedsLegacyPrepare(false);
            }
            // Mark preflight tracking ref so we don't re-run
            preflightedCloudAgentSessionRef.current = sessionData.cloud_agent_session_id;
          }

          // Parse messages from R2 blob
          const dbMessages =
            messagesResult.data && Array.isArray(messagesResult.data.messages)
              ? messagesResult.data.messages
              : [];
          const cloudMessages = parseStoredMessages(dbMessages as Array<Record<string, unknown>>);

          const result = await loadSessionToIndexedDb({
            session,
            messages: cloudMessages,
          });

          setResumeStrategy(result.resumeStrategy);
          loadedDbSessionIdRef.current = sessionIdFromParams;
          setLoadedDbSession(session);

          // Apply runtime state from DO (mode, model, repository)
          if (runtimeState) {
            if (runtimeState.mode) {
              setInputMode(runtimeState.mode as AgentMode);
            }
            if (runtimeState.model) {
              setInputModel(runtimeState.model);
            }
            // Update sessionConfig with mode/model/repository from cloud-agent DO
            if (runtimeState.mode && runtimeState.model) {
              setSessionConfig(prev => ({
                sessionId: sessionData.cloud_agent_session_id ?? sessionData.session_id,
                mode: runtimeState.mode as AgentMode,
                model: runtimeState.model as string,
                repository: runtimeState.githubRepo ?? prev?.repository ?? '',
              }));
            }
          }

          if (result.needsOrgContextPrompt) {
            setPendingSessionForOrgContext(result.sessionData);
            setNeedsOrgContextPrompt(true);
          } else {
            setNeedsOrgContextPrompt(false);
          }
        } else {
          toast.error('Session not found');
        }
      } catch (err) {
        console.error('Failed to load session from database:', err);
        toast.error('Failed to load session');
        // On error, mark legacy prepare needed if we have a cloudAgentSessionId
        // This ensures the old fallback behavior still works
        if (cloudAgentSessionId) {
          setNeedsLegacyPrepare(true);
        }
      } finally {
        setIsLoadingFromDb(false);
        setPreflightComplete(true);
      }
    };

    void loadFromDb();
  }, [
    sessionIdFromParams,
    isLoadingFromDb,
    isStreaming,
    cloudAgentSessionId,
    refetchSession,
    refetchMessages,
    loadSessionToIndexedDb,
    setIsLoadingFromDb,
    setIsSessionInitiated,
    setResumeStrategy,
    setLoadedDbSession,
    setPendingSessionForOrgContext,
    setNeedsOrgContextPrompt,
    setSessionConfig,
  ]);

  // Auto-initiate web sessions created via prepareSession
  useEffect(() => {
    if (
      !cloudAgentSessionId ||
      !preflightComplete ||
      needsLegacyPrepare ||
      isSessionInitiated ||
      isStreaming ||
      isLoadingFromDb ||
      showOrgContextModal ||
      showResumeModal
    ) {
      return;
    }

    if (autoInitiatedSessionId === cloudAgentSessionId) {
      return;
    }

    // Mark as initiated before calling to prevent race conditions
    setAutoInitiatedSessionId(cloudAgentSessionId);

    // Auto-initiate the prepared session
    void initiateFromPreparedSession(cloudAgentSessionId);
  }, [
    cloudAgentSessionId,
    preflightComplete,
    needsLegacyPrepare,
    isSessionInitiated,
    isStreaming,
    isLoadingFromDb,
    showOrgContextModal,
    showResumeModal,
    initiateFromPreparedSession,
    autoInitiatedSessionId,
  ]);

  // Track which sessions we've already connected to (for existing sessions)
  const connectedExistingSessionRef = useRef<string | null>(null);

  // Connect to WebSocket for already-initiated sessions (e.g., when loading a previously started session)
  useEffect(() => {
    // Only connect if session was previously initiated (has blob URLs)
    if (!isSessionInitiated) {
      return;
    }

    // Need a cloudAgentSessionId to connect
    if (!cloudAgentSessionId) {
      return;
    }

    // Don't connect while loading or streaming
    if (isLoadingFromDb || isStreaming) {
      return;
    }

    // Don't connect if already connected or connecting to THIS session
    // (check currentSessionId to ensure we're connected to the right session)
    if (
      (connectionState.status === 'connected' || connectionState.status === 'connecting') &&
      currentSessionId === cloudAgentSessionId
    ) {
      return;
    }

    // Don't reconnect to the same session
    if (connectedExistingSessionRef.current === cloudAgentSessionId) {
      return;
    }

    // Mark as connected before calling to prevent race conditions
    connectedExistingSessionRef.current = cloudAgentSessionId;

    // Connect to the existing session's WebSocket stream with error handling
    const doConnect = async () => {
      try {
        await connectToExistingSession(cloudAgentSessionId);
      } catch (err) {
        console.error('Failed to connect to existing session:', err);
        setError('Failed to connect to session. Please try refreshing the page.');
        // Reset tracking so user can retry
        connectedExistingSessionRef.current = null;
      }
    };
    void doConnect();
  }, [
    cloudAgentSessionId,
    currentSessionId,
    isSessionInitiated,
    isStreaming,
    isLoadingFromDb,
    connectionState.status,
    connectToExistingSession,
    setError,
  ]);

  // Track previous session ID to detect session switches
  const prevDbSessionIdRef = useRef<string | null>(null);

  // Reset auto-initiation and connection tracking when session changes
  useEffect(() => {
    // Only reset if we're switching from one session to another
    if (prevDbSessionIdRef.current !== null && currentDbSessionId !== prevDbSessionIdRef.current) {
      // Disconnect old WebSocket to prevent events from old session updating UI
      cleanup();
      setAutoInitiatedSessionId(null);
      setResumeConfigState({ status: 'none' });
      connectedExistingSessionRef.current = null;
    }
    prevDbSessionIdRef.current = currentDbSessionId;
  }, [currentDbSessionId, cleanup]);

  // Apply resume config when state transitions to 'pending'
  useEffect(() => {
    if (resumeConfigState.status !== 'pending') return;
    if (!currentDbSessionId || !loadedDbSession) return;

    setResumeConfigState({ status: 'persisting', config: resumeConfigState.config });

    const apply = async () => {
      try {
        await applyResumeConfig({
          config: resumeConfigState.config,
          sessionId: currentDbSessionId,
          loadedDbSession,
        });
        setResumeConfigState({ status: 'persisted', config: resumeConfigState.config });
      } catch (error) {
        setResumeConfigState({
          status: 'failed',
          config: resumeConfigState.config,
          error: error instanceof Error ? error : new Error('Unknown error'),
        });
        clearResumeConfig();
        toast.error('Failed to save configuration. Please try again.');
      }
    };

    void apply();
  }, [
    resumeConfigState,
    currentDbSessionId,
    loadedDbSession,
    applyResumeConfig,
    clearResumeConfig,
  ]);

  // Periodic staleness check
  useEffect(() => {
    if (!currentDbSessionId || isStreaming) return;

    const checkStalenessNow = async () => {
      try {
        const result = await refetchSession();
        if (result.data) {
          const dbUpdatedAt = String(result.data.updated_at);
          await checkStalenessWithHighWaterMark({
            sessionId: currentDbSessionId,
            dbUpdatedAt,
          });
        }
      } catch (err) {
        console.debug('Staleness check failed:', err);
      }
    };

    const interval = setInterval(checkStalenessNow, 30_000);
    return () => clearInterval(interval);
  }, [currentDbSessionId, isStreaming, refetchSession, checkStalenessWithHighWaterMark]);

  // Function to refresh session from DB
  const handleRefreshSession = useCallback(async () => {
    if (!currentDbSessionId) return;

    setIsLoadingFromDb(true);
    try {
      const [sessRes, msgRes] = await Promise.all([refetchSession(), refetchMessages()]);

      if (sessRes.data) {
        const sessionData = sessRes.data;
        // Convert V2 session to DbSessionDetails format
        const session: DbSessionDetails = {
          session_id: sessionData.session_id,
          title: sessionData.title,
          cloud_agent_session_id: sessionData.cloud_agent_session_id,
          organization_id: sessionData.organization_id,
          created_at: new Date(sessionData.created_at),
          updated_at: new Date(sessionData.updated_at),
        };

        // Parse messages from R2 blob
        const dbMessages =
          msgRes.data && Array.isArray(msgRes.data.messages) ? msgRes.data.messages : [];
        const cloudMessages = parseStoredMessages(dbMessages as Array<Record<string, unknown>>);

        await loadSessionToIndexedDb({
          session,
          messages: cloudMessages,
        });

        toast.success('Session refreshed');
      }
    } catch (err) {
      console.error('Failed to refresh session:', err);
      toast.error('Failed to refresh session');
    } finally {
      setIsLoadingFromDb(false);
    }
  }, [currentDbSessionId, refetchSession, refetchMessages, loadSessionToIndexedDb]);

  // Handle new session
  const handleNewSession = () => {
    const basePath = organizationId ? `/organizations/${organizationId}/cloud-next` : '/cloud-next';
    router.push(basePath);
  };

  // Handle org context modal confirm
  const handleOrgContextConfirm = useCallback(
    async (orgContext: { organizationId: string } | null) => {
      if (!pendingSessionForOrgContext) return;

      try {
        const result = await applyOrgContext({
          orgContext,
          pendingSession: pendingSessionForOrgContext,
        });

        setNeedsOrgContextPrompt(false);
        setPendingSessionForOrgContext(null);

        if (!result.navigated && result.targetSessionForModal) {
          setLoadedDbSession(result.targetSessionForModal);
        }
      } catch (error) {
        console.error('Failed to apply org context:', error);
        toast.error('Failed to update organization context. Please try again.');
      }
    },
    [pendingSessionForOrgContext, applyOrgContext]
  );

  // Handle org context modal close
  const handleOrgContextClose = useCallback(() => {
    // Mark as dismissed for this session
    if (currentDbSessionId) {
      setOrgContextDismissedForSession(currentDbSessionId);
    }
    setPendingSessionForOrgContext(null);
    setNeedsOrgContextPrompt(false);
  }, [currentDbSessionId]);

  // Handle send message
  const handleSendMessage = useCallback(
    async (prompt: string) => {
      // Use cloudAgentSessionId (from IndexedDB for resumed sessions) or
      // currentSessionId (from stream for new sessions)
      let effectiveSessionId = cloudAgentSessionId || currentSessionId || null;

      // ChatInput is disabled while session is initializing, so we only need to handle
      // the case where we have a valid sessionConfig (already-initiated or CLI sessions)
      if (sessionConfig) {
        if (needsLegacyPrepare && effectiveSessionId && currentDbSessionId) {
          const resumeRepo = streamResumeConfig?.githubRepo || sessionConfig.repository;
          const gitUrl = currentIndexedDbSession?.gitUrl || loadedDbSession?.git_url || null;
          const repoParams = buildPrepareSessionRepoParams({ repo: resumeRepo, gitUrl });
          if (!repoParams) {
            setError('Cannot prepare session without a repository.');
            toast.error('Cannot prepare session without a repository.');
            return;
          }

          try {
            // For cloud-agent-next, use prepareSession with new modes
            // Note: This re-creates the session in the new format
            let result: { cloudAgentSessionId: string };
            if (organizationId) {
              result = await trpcClient.organizations.cloudAgentNext.prepareSession.mutate({
                organizationId,
                prompt,
                mode: inputMode,
                model: inputModel,
                ...repoParams,
                envVars: streamResumeConfig?.envVars,
                setupCommands: streamResumeConfig?.setupCommands,
              });
            } else {
              result = await trpcClient.cloudAgentNext.prepareSession.mutate({
                prompt,
                mode: inputMode,
                model: inputModel,
                ...repoParams,
                envVars: streamResumeConfig?.envVars,
                setupCommands: streamResumeConfig?.setupCommands,
              });
            }

            setNeedsLegacyPrepare(false);
            void initiateFromPreparedSession(result.cloudAgentSessionId);
            return;
          } catch (err) {
            console.error('Failed to prepare existing session:', err);
            setError('Failed to prepare session. Please try again.');
            toast.error('Failed to prepare session. Please try again.');
            return;
          }
        }

        if (!effectiveSessionId) {
          const resumeRepo = streamResumeConfig?.githubRepo || sessionConfig.repository;
          const gitUrl = currentIndexedDbSession?.gitUrl || loadedDbSession?.git_url || null;
          const repoParams = buildPrepareSessionRepoParams({ repo: resumeRepo, gitUrl });
          if (!repoParams) {
            setError('Cannot prepare session without a repository.');
            toast.error('Cannot prepare session without a repository.');
            return;
          }

          try {
            effectiveSessionId = await prepareSession({
              prompt,
              mode: inputMode,
              model: inputModel,
              ...repoParams,
              envVars: streamResumeConfig?.envVars,
              setupCommands: streamResumeConfig?.setupCommands,
            });
            await initiateFromPreparedSession(effectiveSessionId);
            return;
          } catch (err) {
            console.error('Failed to prepare session for resume:', err);
            setError('Failed to prepare session. Please try again.');
            toast.error('Failed to prepare session. Please try again.');
            return;
          }
        }

        // Use inputMode and inputModel from toolbar state for the message
        sendMessage(prompt, effectiveSessionId, inputMode, inputModel);
      }
    },
    [
      sendMessage,
      sessionConfig,
      cloudAgentSessionId,
      currentSessionId,
      needsLegacyPrepare,
      currentDbSessionId,
      streamResumeConfig,
      prepareSession,
      trpcClient,
      initiateFromPreparedSession,
      organizationId,
      setError,
      currentIndexedDbSession,
      loadedDbSession,
      inputMode,
      inputModel,
    ]
  );

  // Handle stop execution
  const handleStopExecution = useCallback(() => {
    if (currentSessionId) {
      void interruptSession(currentSessionId);
    }
  }, [interruptSession, currentSessionId]);

  // Handle dismiss error
  const handleDismissError = () => {
    setError(null);
  };

  // Session deletion hook
  const { handleDeleteSession } = useSessionDeletion({
    organizationId,
    currentDbSessionId,
    cleanup,
    refetchSessions,
  });

  // Handle session selection
  const handleSelectSession = useCallback(
    (sessionId: string) => {
      const basePath = organizationId
        ? `/organizations/${organizationId}/cloud-next`
        : '/cloud-next';
      router.push(`${basePath}/chat?sessionId=${sessionId}`);
    },
    [organizationId, router]
  );

  // Check if session needs resume config
  // Don't show the banner while preflight is running for V2 sessions (those with cloudAgentSessionId)
  // because mode/model is being fetched from the cloud-agent DO
  const isPreflightPending = Boolean(cloudAgentSessionId && !preflightComplete);
  const needsResumeConfig =
    !isPreflightPending &&
    needsResumeConfiguration({
      currentDbSessionId,
      resumeConfig: resumeConfigState.status === 'persisted' ? resumeConfigState.config : null,
      streamResumeConfig,
      sessionConfig,
    });

  // Check if the current session uses the old V1 format
  const isOldSession = currentIndexedDbSession
    ? isOldSessionFormat(currentIndexedDbSession)
    : false;

  return (
    <CloudChatPresentation
      organizationId={organizationId}
      staticMessages={staticMessages}
      dynamicMessages={dynamicMessages}
      sessions={sessions}
      currentSessionId={currentSessionId}
      currentDbSessionId={currentDbSessionId}
      cloudAgentSessionId={cloudAgentSessionId}
      sessionConfig={sessionConfig}
      totalCost={totalCost}
      error={error}
      isStreaming={isStreaming}
      isLoadingFromDb={isLoadingFromDb}
      isStale={isStale}
      isSessionInitiated={isSessionInitiated}
      showScrollButton={showScrollButton}
      mobileSheetOpen={mobileSheetOpen}
      soundEnabled={soundEnabled}
      showOrgContextModal={showOrgContextModal}
      showResumeModal={showResumeModal}
      pendingSessionForOrgContext={pendingSessionForOrgContext}
      pendingResumeSession={pendingResumeSession}
      pendingGitState={pendingGitState}
      needsResumeConfig={needsResumeConfig}
      resumeConfigPersisting={resumeConfigState.status === 'persisting'}
      resumeConfigFailed={resumeConfigState.status === 'failed'}
      resumeConfigError={
        resumeConfigState.status === 'failed' ? resumeConfigState.error.message : null
      }
      modelOptions={modelOptions}
      isLoadingModels={isLoadingModels}
      defaultModel={defaultModel}
      availableCommands={availableCommands}
      scrollContainerRef={scrollContainerRef}
      messagesEndRef={messagesEndRef}
      streamResumeConfig={streamResumeConfig}
      onSendMessage={handleSendMessage}
      onStopExecution={handleStopExecution}
      onRefresh={handleRefreshSession}
      onNewSession={handleNewSession}
      onSelectSession={handleSelectSession}
      onDeleteSession={handleDeleteSession}
      onDismissError={handleDismissError}
      onOrgContextConfirm={handleOrgContextConfirm}
      onOrgContextClose={handleOrgContextClose}
      onResumeConfirm={handleResumeConfirm}
      onResumeClose={handleResumeClose}
      onReopenResumeModal={reopenResumeModal}
      onScroll={handleScroll}
      onScrollToBottom={scrollToBottom}
      onToggleSound={handleToggleSound}
      onMenuClick={() => setMobileSheetOpen(true)}
      onMobileSheetOpenChange={setMobileSheetOpen}
      inputMode={inputMode}
      inputModel={inputModel}
      onInputModeChange={handleInputModeChange}
      onInputModelChange={handleInputModelChange}
      isOldSession={isOldSession}
      getChildMessages={getChildSessionMessages}
    />
  );
}
