/**
 * Cloud Agent Stream Hook
 *
 * WebSocket-based streaming hook.
 * Uses:
 * - EventProcessor (src/lib/cloud-agent/processor) for event processing
 * - WebSocket manager (src/lib/cloud-agent/websocket-manager.ts) for connection lifecycle
 * - REST API for stream ticket (/api/cloud-agent/sessions/stream-ticket)
 * - tRPC endpoints (initiateFromKilocodeSessionV2, sendMessageV2)
 * - Atoms for direct message/part updates
 *
 * Requires cloudAgentSessionId to be provided by the caller (session must be prepared first).
 */

import { useAtomValue, useSetAtom } from 'jotai';
import { useCallback, useRef, useState, useEffect, useMemo } from 'react';
import { TRPCClientError } from '@trpc/client';
import { useRawTRPCClient } from '@/lib/trpc/utils';
import {
  createWebSocketManager,
  type ConnectionState,
  type WebSocketManagerConfig,
} from '@/lib/cloud-agent-next/websocket-manager';
import type { CloudAgentEvent, StreamError } from '@/lib/cloud-agent-next/event-types';
import { createEventProcessor, type EventProcessor } from '@/lib/cloud-agent-next/processor';
import type { EventProcessorCallbacks } from '@/lib/cloud-agent-next/processor';
import {
  currentSessionIdAtom,
  isStreamingAtom,
  errorAtom,
  updateMessageAtom,
  setPartAtom,
  deletePartAtom,
  sessionStatusAtom,
  updateChildSessionMessageAtom,
  updateChildSessionPartAtom,
  removeChildSessionPartAtom,
} from './store/atoms';
import {
  updateHighWaterMarkAtom,
  updateCloudAgentSessionIdAtom,
  getSessionFromStoreAtom,
  updateMessageInfoAtom,
  updatePartAtom,
} from './store/db-session-atoms';
import { CLOUD_AGENT_NEXT_WS_URL } from '@/lib/constants';

export type { ConnectionState };

export type UseCloudAgentStreamOptions = {
  /** Cloud-agent session ID (required - returned from prepareSession) */
  cloudAgentSessionId: string;
  /** Organization ID for org-scoped sessions */
  organizationId?: string;
  /** Callback when streaming completes */
  onComplete?: () => void;
  /** Callback when a new kilo session is created (session_created event with CLI session UUID) */
  onKiloSessionCreated?: (kiloSessionId: string) => void;
  /** Callback when session is confirmed initiated (first session_synced event) */
  onSessionInitiated?: () => void;
};

export type UseCloudAgentStreamReturn = {
  /** Start streaming for a prepared session (alias: initiateFromPreparedSession) */
  startStream: () => Promise<void>;
  /** Alias for startStream that accepts a cloudAgentSessionId parameter */
  initiateFromPreparedSession: (cloudAgentSessionId: string) => Promise<void>;
  /** Connect to an existing session's WebSocket stream without initiating execution */
  connectToExistingSession: (cloudAgentSessionId: string) => Promise<void>;
  /** Stop the WebSocket connection */
  stopStream: () => void;
  /** Cleanup function (alias for stopStream) */
  cleanup: () => void;
  /** Send a message to an existing session */
  sendMessage: (
    message: string,
    cloudAgentSessionId: string,
    mode: string,
    model: string
  ) => Promise<void>;
  /** Interrupt the current session */
  interruptSession: (cloudAgentSessionId: string) => Promise<void>;
  /** Whether streaming is active */
  isStreaming: boolean;
  /** Current WebSocket connection state */
  connectionState: ConnectionState;
  /** Current error message */
  error: string | null;
};

export function useCloudAgentStream({
  cloudAgentSessionId: cloudAgentSessionIdProp,
  organizationId,
  onComplete,
  onKiloSessionCreated,
  onSessionInitiated,
}: UseCloudAgentStreamOptions): UseCloudAgentStreamReturn {
  const trpcClient = useRawTRPCClient();

  // Atoms for direct message/part updates (in-memory state for UI)
  const updateMessage = useSetAtom(updateMessageAtom);
  const setPart = useSetAtom(setPartAtom);
  const deletePart = useSetAtom(deletePartAtom);
  const setSessionStatus = useSetAtom(sessionStatusAtom);

  // Atoms for child session message updates
  const updateChildSessionMessage = useSetAtom(updateChildSessionMessageAtom);
  const updateChildSessionPart = useSetAtom(updateChildSessionPartAtom);
  const removeChildSessionPart = useSetAtom(removeChildSessionPartAtom);

  // Common atoms
  const setCurrentSessionId = useSetAtom(currentSessionIdAtom);
  const setIsStreaming = useSetAtom(isStreamingAtom);
  const setError = useSetAtom(errorAtom);
  const isStreaming = useAtomValue(isStreamingAtom);

  // DB session atoms for IndexedDB persistence
  const updateHighWaterMarkAction = useSetAtom(updateHighWaterMarkAtom);
  const updateCloudAgentSessionIdAction = useSetAtom(updateCloudAgentSessionIdAtom);
  const getSessionFromStore = useSetAtom(getSessionFromStoreAtom);
  const updateMessageInfoAction = useSetAtom(updateMessageInfoAtom);
  const updatePartAction = useSetAtom(updatePartAtom);

  const [connectionState, setConnectionState] = useState<ConnectionState>({
    status: 'disconnected',
  });
  const [localError, setLocalError] = useState<string | null>(null);

  const wsManagerRef = useRef<ReturnType<typeof createWebSocketManager> | null>(null);
  const notifiedKiloSessionIdsRef = useRef<Set<string>>(new Set());
  const sessionInitiatedFiredRef = useRef<Set<string>>(new Set());
  const cloudAgentSessionIdRef = useRef<string | null>(cloudAgentSessionIdProp ?? null);
  const organizationIdRef = useRef<string | undefined>(organizationId);

  // Refs for callbacks to avoid stale closures in processor
  const onCompleteRef = useRef(onComplete);
  const onKiloSessionCreatedRef = useRef(onKiloSessionCreated);
  const onSessionInitiatedRef = useRef(onSessionInitiated);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    onKiloSessionCreatedRef.current = onKiloSessionCreated;
  }, [onKiloSessionCreated]);

  useEffect(() => {
    onSessionInitiatedRef.current = onSessionInitiated;
  }, [onSessionInitiated]);

  useEffect(() => {
    cloudAgentSessionIdRef.current = cloudAgentSessionIdProp ?? null;
  }, [cloudAgentSessionIdProp]);

  useEffect(() => {
    organizationIdRef.current = organizationId;
  }, [organizationId]);

  /**
   * Create the event processor with callbacks wired to Jotai atoms and IndexedDB.
   */
  const processorRef = useRef<EventProcessor | null>(null);

  const callbacks: EventProcessorCallbacks = useMemo(
    () => ({
      onMessageUpdated: (sessionId, messageId, message, parentSessionId) => {
        if (parentSessionId === null) {
          // Root session message
          updateMessage({ messageId, info: message.info, parts: message.parts });

          // First message.updated for this session confirms it has been initiated
          if (onSessionInitiatedRef.current && !sessionInitiatedFiredRef.current.has(sessionId)) {
            sessionInitiatedFiredRef.current.add(sessionId);
            onSessionInitiatedRef.current();
          }
        } else {
          // Child session message
          updateChildSessionMessage({
            childSessionId: sessionId,
            messageId,
            info: message.info,
            parts: message.parts,
          });
        }
      },

      onMessageCompleted: (sessionId, messageId, message, parentSessionId) => {
        if (parentSessionId === null) {
          // Root session - store completed message and persist to IndexedDB
          updateMessage({ messageId, info: message.info, parts: message.parts });
          void updateMessageInfoAction({ sessionId, messageId, info: message.info });
          for (const part of message.parts) {
            void updatePartAction({ sessionId, messageId, part });
          }
        } else {
          // Child session - store completed message in atoms
          updateChildSessionMessage({
            childSessionId: sessionId,
            messageId,
            info: message.info,
            parts: message.parts,
          });
        }
      },

      onPartUpdated: (sessionId, messageId, partId, part, parentSessionId) => {
        // The processor already handles delta accumulation internally,
        // so the part passed here has the full accumulated text
        if (parentSessionId === null) {
          setPart({ messageId, part });
        } else {
          updateChildSessionPart({ childSessionId: sessionId, messageId, part });
        }
      },

      onPartRemoved: (sessionId, messageId, partId, parentSessionId) => {
        if (parentSessionId === null) {
          deletePart({ messageId, partId });
        } else {
          removeChildSessionPart({ childSessionId: sessionId, messageId, partId });
        }
      },

      onSessionStatusChanged: status => {
        setSessionStatus(status);

        // Handle streaming state based on status
        if (status.type === 'idle') {
          setIsStreaming(false);
          onCompleteRef.current?.();
        } else if (status.type === 'busy') {
          setIsStreaming(true);
        }
        // 'retry' status keeps streaming active
      },

      onSessionCreated: async sessionInfo => {
        if (typeof window === 'undefined') return;

        const kiloSessionId = sessionInfo.id;
        const cloudAgentSessionId = cloudAgentSessionIdRef.current;

        if (!kiloSessionId || !cloudAgentSessionId) return;

        // Link session IDs in IndexedDB if session exists
        const existingSession = getSessionFromStore(kiloSessionId);
        if (existingSession) {
          await updateCloudAgentSessionIdAction({
            sessionId: kiloSessionId,
            cloudAgentSessionId,
          });
        }

        // Notify parent component about the new kilo session ID (for URL update)
        // Only for root sessions (no parentID)
        const hasParentID = sessionInfo.parentID;
        if (
          onKiloSessionCreatedRef.current &&
          !hasParentID &&
          !notifiedKiloSessionIdsRef.current.has(kiloSessionId)
        ) {
          notifiedKiloSessionIdsRef.current.add(kiloSessionId);
          onKiloSessionCreatedRef.current(kiloSessionId);
        }
      },

      onSessionUpdated: async sessionInfo => {
        // Update high water mark from session's updated time
        if (sessionInfo.time?.updated) {
          await updateHighWaterMarkAction({
            sessionId: sessionInfo.id,
            timestamp: sessionInfo.time.updated,
          });
        }
      },

      onError: (error, _sessionId) => {
        setError(error);
        setLocalError(error);
        setIsStreaming(false);
      },

      onStreamingChanged: streaming => {
        setIsStreaming(streaming);
        if (!streaming) {
          onCompleteRef.current?.();
        }
      },
    }),
    [
      updateMessage,
      updateMessageInfoAction,
      setPart,
      updatePartAction,
      deletePart,
      setSessionStatus,
      setIsStreaming,
      getSessionFromStore,
      updateCloudAgentSessionIdAction,
      updateHighWaterMarkAction,
      updateChildSessionMessage,
      updateChildSessionPart,
      removeChildSessionPart,
      setError,
    ]
  );

  // Create processor lazily on first use, recreate if callbacks change
  const getProcessor = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.clear();
    }
    processorRef.current = createEventProcessor({ callbacks });
    return processorRef.current;
  }, [callbacks]);

  const handleEvent = useCallback(
    (event: CloudAgentEvent) => {
      if (!processorRef.current) {
        getProcessor();
      }
      processorRef.current?.processEvent(event);
    },
    [getProcessor]
  );

  // Cleanup processor on unmount
  useEffect(() => {
    return () => {
      processorRef.current?.clear();
      processorRef.current = null;
    };
  }, []);

  // Cleanup WebSocket on unmount
  useEffect(() => {
    return () => {
      if (wsManagerRef.current) {
        wsManagerRef.current.disconnect();
        wsManagerRef.current = null;
      }
    };
  }, []);

  const formatStreamError = useCallback((err: unknown): string => {
    if (err instanceof TRPCClientError) {
      const code = err.data?.code || err.shape?.code;
      const httpStatus = err.data?.httpStatus || err.shape?.data?.httpStatus;

      if (code === 'PAYMENT_REQUIRED' || httpStatus === 402) {
        return 'Insufficient credits. Please add at least $1 to continue using Cloud Agent.';
      }
      if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') {
        return 'You are not authorized to use the Cloud Agent.';
      }
      if (code === 'NOT_FOUND') {
        return 'Cloud Agent service is unavailable right now. Please try again.';
      }
      return 'Cloud Agent encountered an error. Please retry in a moment.';
    }
    if (err instanceof Error) {
      if (err.message.includes('ECONNREFUSED') || err.message.includes('fetch failed')) {
        return 'Lost connection to Cloud Agent. Please retry in a moment.';
      }
      return 'Cloud Agent connection failed. Please retry in a moment.';
    }
    return 'Cloud Agent error. Please retry in a moment.';
  }, []);

  const formatWsError = useCallback((error: StreamError): string => {
    switch (error.code) {
      case 'WS_SESSION_NOT_FOUND':
        return 'Session not found. The session may have been deleted.';
      case 'WS_EXECUTION_NOT_FOUND':
        return 'Execution not found. The execution may have completed or been deleted.';
      case 'WS_AUTH_ERROR':
        return 'Authentication failed. Please sign in again.';
      case 'WS_PROTOCOL_ERROR':
        return 'Received invalid message from server.';
      case 'WS_DUPLICATE_CONNECTION':
        return 'Another connection is already streaming this execution.';
      case 'WS_INTERNAL_ERROR':
      default:
        return error.message || 'An unexpected error occurred.';
    }
  }, []);

  const handleWsError = useCallback(
    (error: StreamError) => {
      const errorMessage = formatWsError(error);
      setError(errorMessage);
      setLocalError(errorMessage);

      // Stop streaming for terminal errors
      if (
        error.code === 'WS_SESSION_NOT_FOUND' ||
        error.code === 'WS_EXECUTION_NOT_FOUND' ||
        error.code === 'WS_AUTH_ERROR'
      ) {
        setIsStreaming(false);
      }
    },
    [formatWsError, setError, setIsStreaming]
  );

  /**
   * Get a stream ticket for WebSocket authentication.
   * Uses the cloud-agent-next REST API endpoint with cli_sessions_v2.
   */
  const getTicket = useCallback(async (targetCloudAgentSessionId: string): Promise<string> => {
    const body: { cloudAgentSessionId: string; organizationId?: string } = {
      cloudAgentSessionId: targetCloudAgentSessionId,
    };
    if (organizationIdRef.current) {
      body.organizationId = organizationIdRef.current;
    }

    const response = await fetch('/api/cloud-agent-next/sessions/stream-ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errorData = (await response.json()) as { error?: string };
      throw new Error(errorData.error || 'Failed to get stream ticket');
    }
    const result = (await response.json()) as { ticket: string };
    return result.ticket;
  }, []);

  /**
   * Build WebSocket URL for connecting to the stream.
   * Always uses NEXT_PUBLIC_CLOUD_AGENT_NEXT_WS_URL with cloudAgentSessionId query param.
   */
  const buildWsUrl = useCallback((targetCloudAgentSessionId: string): string => {
    if (!CLOUD_AGENT_NEXT_WS_URL) {
      throw new Error('NEXT_PUBLIC_CLOUD_AGENT_NEXT_WS_URL is not configured');
    }
    const url = new URL('/stream', CLOUD_AGENT_NEXT_WS_URL);
    url.searchParams.set('cloudAgentSessionId', targetCloudAgentSessionId);
    return url.toString();
  }, []);

  const connectWebSocket = useCallback(
    async (targetCloudAgentSessionId: string) => {
      if (wsManagerRef.current) {
        wsManagerRef.current.disconnect();
        wsManagerRef.current = null;
      }

      const ticket = await getTicket(targetCloudAgentSessionId);
      const url = buildWsUrl(targetCloudAgentSessionId);

      const config: WebSocketManagerConfig = {
        url,
        ticket,
        onEvent: handleEvent,
        onError: handleWsError,
        onStateChange: state => {
          setConnectionState(state);

          if (state.status === 'error') {
            setLocalError(state.error);
            setError(state.error);
            if (!state.retryable) {
              setIsStreaming(false);
            }
          }
        },
        // Provide ticket refresh callback for 401 handling
        onRefreshTicket: async () => {
          return getTicket(targetCloudAgentSessionId);
        },
      };

      wsManagerRef.current = createWebSocketManager(config);
      wsManagerRef.current.connect();
    },
    [getTicket, buildWsUrl, handleEvent, handleWsError, setError, setIsStreaming]
  );

  /**
   * Start streaming for a prepared session.
   */
  const startStream = useCallback(async () => {
    const sessionIdToUse = cloudAgentSessionIdRef.current;

    if (!sessionIdToUse) {
      const errorMessage = 'No cloudAgentSessionId available. Session must be prepared first.';
      setLocalError(errorMessage);
      setError(errorMessage);
      return;
    }

    setLocalError(null);
    setError(null);
    setIsStreaming(true);

    try {
      let result: { cloudAgentSessionId: string };

      // Use cloudAgentNext endpoints with new modes ('plan' | 'build')
      if (organizationIdRef.current) {
        result = await trpcClient.organizations.cloudAgentNext.initiateFromPreparedSession.mutate(
          {
            cloudAgentSessionId: sessionIdToUse,
            organizationId: organizationIdRef.current,
          },
          { context: { skipBatch: true } }
        );
      } else {
        result = await trpcClient.cloudAgentNext.initiateFromPreparedSession.mutate(
          {
            cloudAgentSessionId: sessionIdToUse,
          },
          { context: { skipBatch: true } }
        );
      }

      cloudAgentSessionIdRef.current = result.cloudAgentSessionId;
      setCurrentSessionId(result.cloudAgentSessionId);
      await connectWebSocket(result.cloudAgentSessionId);
    } catch (err) {
      const errorMessage = formatStreamError(err);
      setLocalError(errorMessage);
      setError(errorMessage);
      setIsStreaming(false);
    }
  }, [
    trpcClient,
    connectWebSocket,
    formatStreamError,
    setError,
    setIsStreaming,
    setCurrentSessionId,
  ]);

  /**
   * Initiate a prepared session.
   * This is an alias for startStream that accepts a cloudAgentSessionId parameter.
   */
  const initiateFromPreparedSession = useCallback(
    async (cloudAgentSessionId: string) => {
      cloudAgentSessionIdRef.current = cloudAgentSessionId;
      await startStream();
    },
    [startStream]
  );

  /**
   * Connect to an existing session's WebSocket stream without initiating execution.
   * Use this when loading a previously started session to receive ongoing events.
   */
  const connectToExistingSession = useCallback(
    async (cloudAgentSessionId: string) => {
      cloudAgentSessionIdRef.current = cloudAgentSessionId;
      setCurrentSessionId(cloudAgentSessionId);
      await connectWebSocket(cloudAgentSessionId);
    },
    [connectWebSocket, setCurrentSessionId]
  );

  const stopStream = useCallback(() => {
    if (wsManagerRef.current) {
      wsManagerRef.current.disconnect();
      wsManagerRef.current = null;
    }
    setIsStreaming(false);
    setConnectionState({ status: 'disconnected' });
  }, [setIsStreaming]);

  /**
   * Cleanup function - alias for stopStream.
   */
  const cleanup = useCallback(() => {
    stopStream();
  }, [stopStream]);

  /**
   * Interrupt the current session.
   * Calls the appropriate tRPC endpoint based on organization context.
   */
  const interruptSession = useCallback(
    async (cloudAgentSessionId: string) => {
      try {
        // Use cloudAgentNext endpoints
        if (organizationIdRef.current) {
          await trpcClient.organizations.cloudAgentNext.interruptSession.mutate(
            {
              organizationId: organizationIdRef.current,
              sessionId: cloudAgentSessionId,
            },
            { context: { skipBatch: true } }
          );
        } else {
          await trpcClient.cloudAgentNext.interruptSession.mutate(
            {
              sessionId: cloudAgentSessionId,
            },
            { context: { skipBatch: true } }
          );
        }

        // Clean up WebSocket connection
        stopStream();

        // Session status will be updated via session.status event
        // No need to manually add a system message - UI handles interrupted state
      } catch (error) {
        console.error('Failed to interrupt session:', error);
        setError('Failed to stop execution');
      }
    },
    [trpcClient, stopStream, setError]
  );

  /**
   * Send a message to an existing session.
   * Caller must provide cloudAgentSessionId, mode and model explicitly.
   * Uses organization-scoped endpoint when organizationId is set.
   */
  const sendMessage = useCallback(
    async (message: string, cloudAgentSessionId: string, mode: string, model: string) => {
      setLocalError(null);
      setError(null);
      setIsStreaming(true);

      // Use provided cloudAgentSessionId, falling back to ref for backward compatibility
      const activeCloudAgentSessionId = cloudAgentSessionId || cloudAgentSessionIdRef.current;
      if (!activeCloudAgentSessionId) {
        const errorMessage = 'No cloudAgentSessionId available. Call startStream first.';
        setLocalError(errorMessage);
        setError(errorMessage);
        setIsStreaming(false);
        return;
      }

      // Update ref to match the session we're sending to
      cloudAgentSessionIdRef.current = activeCloudAgentSessionId;

      try {
        let result: { cloudAgentSessionId: string };

        // Use cloudAgentNext endpoints with new modes ('plan' | 'build')
        if (organizationIdRef.current) {
          result = await trpcClient.organizations.cloudAgentNext.sendMessage.mutate(
            {
              cloudAgentSessionId: activeCloudAgentSessionId,
              prompt: message,
              mode: mode as 'plan' | 'build',
              model,
              organizationId: organizationIdRef.current,
            },
            { context: { skipBatch: true } }
          );
        } else {
          result = await trpcClient.cloudAgentNext.sendMessage.mutate(
            {
              cloudAgentSessionId: activeCloudAgentSessionId,
              prompt: message,
              mode: mode as 'plan' | 'build',
              model,
            },
            { context: { skipBatch: true } }
          );
        }

        cloudAgentSessionIdRef.current = result.cloudAgentSessionId;

        const currentState = wsManagerRef.current?.getState();
        if (!wsManagerRef.current || !currentState || currentState.status === 'disconnected') {
          await connectWebSocket(result.cloudAgentSessionId);
        }
      } catch (err) {
        const errorMessage = formatStreamError(err);
        setLocalError(errorMessage);
        setError(errorMessage);
        setIsStreaming(false);
      }
    },
    [trpcClient, connectWebSocket, formatStreamError, setError, setIsStreaming]
  );

  return {
    startStream,
    initiateFromPreparedSession,
    connectToExistingSession,
    stopStream,
    cleanup,
    sendMessage,
    interruptSession,
    isStreaming,
    connectionState,
    error: localError,
  };
}
