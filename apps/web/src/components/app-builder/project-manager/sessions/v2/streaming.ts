/**
 * V2 Streaming Module
 *
 * Coordinates V2 WebSocket-based streaming for App Builder sessions.
 * This module manages the V2 WebSocket coordinator (cloud-agent-next) and provides
 * methods for sending messages, interrupting, and managing session lifecycle.
 *
 * This is purely V2 — messages arrive via EventProcessor from the WebSocket,
 * so no optimistic message insertion is needed on send.
 */

import {
  createWebSocketManager,
  type ConnectionState,
  type WebSocketManagerConfig,
} from '@/lib/cloud-agent-next/websocket-manager';
import type { CloudAgentEvent, StreamError } from '@/lib/cloud-agent-next/event-types';
import {
  createEventProcessor,
  type EventProcessor,
  type EventProcessorCallbacks,
} from '@/lib/cloud-agent-next/processor';
import { CLOUD_AGENT_NEXT_WS_URL } from '@/lib/constants';
import type { StoredMessage } from '@/components/cloud-agent-next/types';
import type { V2SessionStore } from './store';
import type { AppTRPCClient } from '../../types';
import type { Images } from '@/lib/images-schema';
import type { WorkerVersion } from '@/lib/app-builder/types';
import { createLogger } from '../../logging';

type SendMessageResponse = { sessionId: string; workerVersion: WorkerVersion };

export type SessionChangedUserMessage = { text: string; images?: Images };

export type V2StreamingConfig = {
  projectId: string;
  organizationId: string | null;
  trpcClient: AppTRPCClient;
  store: V2SessionStore;
  cloudAgentSessionId: string | null;
  onStreamComplete?: () => void;
  /** Called when the backend creates a new session (upgrade or GitHub migration) */
  onSessionChanged?: (
    newSessionId: string,
    workerVersion: WorkerVersion,
    userMessage: SessionChangedUserMessage
  ) => void;
};

export type V2StreamingCoordinator = {
  sendMessage: (message: string, images?: Images, model?: string) => void;
  interrupt: () => void;
  startInitialStreaming: () => void;
  connectToExistingSession: (sessionId: string) => void;
  destroy: () => void;
};

/**
 * Creates a V2 streaming coordinator for managing WebSocket-based streaming.
 *
 * The flow for sending messages:
 * 1. Call tRPC sendMessage mutation — returns cloudAgentSessionId
 * 2. Connect to WebSocket with the session ID to receive events
 * 3. EventProcessor updates the V2SessionStore via updateMessages
 *
 * For initial streaming (new projects): calls startSession tRPC mutation to
 * initiate the prepared session, then connects to the WebSocket.
 */
export function createV2StreamingCoordinator(config: V2StreamingConfig): V2StreamingCoordinator {
  const { projectId, organizationId, trpcClient, store, onStreamComplete, onSessionChanged } =
    config;

  const logger = createLogger(projectId);

  // Internal state
  let destroyed = false;
  let wsManager: ReturnType<typeof createWebSocketManager> | null = null;
  let connectionState: ConnectionState = { status: 'disconnected' };
  let processor: EventProcessor | null = null;
  let currentCloudSessionId: string | null = null;
  let currentAbortController: AbortController | null = null;

  // ---------------------------------------------------------------------------
  // WebSocket + EventProcessor
  // ---------------------------------------------------------------------------

  /** Returns the appropriate message updater for parent vs child session messages. */
  function messageUpdater(
    sessionId: string,
    parentSessionId: string | null
  ): (updater: (msgs: StoredMessage[]) => StoredMessage[]) => void {
    return parentSessionId !== null
      ? updater => store.updateChildSessionMessages(sessionId, updater)
      : store.updateMessages;
  }

  function createProcessorCallbacks(): EventProcessorCallbacks {
    return {
      onMessageUpdated: (sessionId, messageId, message, parentSessionId) => {
        const update = messageUpdater(sessionId, parentSessionId);
        const storedMsg: StoredMessage = { info: message.info, parts: message.parts };
        update(messages => {
          const idx = messages.findIndex(m => m.info.id === messageId);
          if (idx >= 0) {
            const updated = [...messages];
            updated[idx] = storedMsg;
            return updated;
          }
          // Replace optimistic user message when the real one arrives from server
          // (only applies to parent session messages)
          if (parentSessionId === null && message.info.role === 'user') {
            const optimisticIdx = messages.findIndex(
              m => m.info.role === 'user' && m.info.id.startsWith('optimistic-')
            );
            if (optimisticIdx >= 0) {
              const updated = [...messages];
              updated[optimisticIdx] = storedMsg;
              return updated;
            }
          }
          const updated = [...messages, storedMsg];
          if (parentSessionId !== null) {
            updated.sort((a, b) => a.info.time.created - b.info.time.created);
          }
          return updated;
        });
      },

      onMessageCompleted: (sessionId, messageId, message, parentSessionId) => {
        const update = messageUpdater(sessionId, parentSessionId);
        const storedMsg: StoredMessage = { info: message.info, parts: message.parts };
        update(messages => {
          const idx = messages.findIndex(m => m.info.id === messageId);
          if (idx >= 0) {
            const updated = [...messages];
            updated[idx] = storedMsg;
            return updated;
          }
          const updated = [...messages, storedMsg];
          if (parentSessionId !== null) {
            updated.sort((a, b) => a.info.time.created - b.info.time.created);
          }
          return updated;
        });
      },

      onPartUpdated: (sessionId, messageId, _partId, part, parentSessionId) => {
        messageUpdater(
          sessionId,
          parentSessionId
        )(messages => {
          const idx = messages.findIndex(m => m.info.id === messageId);
          if (idx < 0) return messages;
          const msg = messages[idx];
          const partIdx = msg.parts.findIndex(p => p.id === part.id);
          const newParts = [...msg.parts];
          if (partIdx >= 0) {
            newParts[partIdx] = part;
          } else {
            newParts.push(part);
          }
          const updated = [...messages];
          updated[idx] = { ...msg, parts: newParts };
          return updated;
        });
      },

      onPartRemoved: (sessionId, messageId, partId, parentSessionId) => {
        messageUpdater(
          sessionId,
          parentSessionId
        )(messages => {
          const idx = messages.findIndex(m => m.info.id === messageId);
          if (idx < 0) return messages;
          const msg = messages[idx];
          const newParts = msg.parts.filter(p => p.id !== partId);
          const updated = [...messages];
          updated[idx] = { ...msg, parts: newParts };
          return updated;
        });
      },

      onSessionStatusChanged: status => {
        if (status.type === 'idle') {
          store.setState({ isStreaming: false });
          onStreamComplete?.();
        } else if (status.type === 'busy') {
          store.setState({ isStreaming: true });
        }
      },

      onSessionCreated: async () => {
        // No-op for app builder V2 sessions
      },

      onSessionUpdated: async () => {
        // No-op for app builder V2 sessions
      },

      onError: (error, _sessionId) => {
        logger.logError('V2 EventProcessor error', new Error(error));
        store.setState({ isStreaming: false });
      },

      onStreamingChanged: streaming => {
        store.setState({ isStreaming: streaming });
        // onStreamComplete is called from onSessionStatusChanged (idle) — not here,
        // to avoid triggering preview polling twice per stream completion.
      },

      onQuestionAsked: (requestId, callId) => {
        store.setQuestionRequestId(callId, requestId);
      },
    };
  }

  function getOrCreateProcessor(): EventProcessor {
    if (!processor) {
      processor = createEventProcessor({ callbacks: createProcessorCallbacks() });
    }
    return processor;
  }

  function handleEvent(event: CloudAgentEvent): void {
    getOrCreateProcessor().processEvent(event);
  }

  function handleStreamError(error: StreamError): void {
    logger.logError('V2 WebSocket stream error', new Error(error.message));
    if (error.code === 'WS_SESSION_NOT_FOUND' || error.code === 'WS_AUTH_ERROR') {
      wsManager?.disconnect();
    }
  }

  function updateConnectionState(state: ConnectionState): void {
    connectionState = state;
    if (state.status === 'error' || state.status === 'disconnected') {
      // Force-complete all in-flight messages so they don't appear stuck in streaming state
      processor?.forceCompleteAll();
      store.setState({ isStreaming: false });
      if (state.status === 'disconnected') {
        onStreamComplete?.();
      }
    }
  }

  async function fetchStreamTicket(cloudAgentSessionId: string): Promise<{ ticket: string }> {
    const response = await fetch('/api/cloud-agent-next/sessions/stream-ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cloudAgentSessionId,
        ...(organizationId ? { organizationId } : {}),
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(
        (error as { error?: string }).error ?? `Failed to get V2 stream ticket: ${response.status}`
      );
    }

    return (await response.json()) as { ticket: string };
  }

  async function connectWs(cloudAgentSessionId: string): Promise<void> {
    if (destroyed) return;

    // If already connected to the same session, reuse
    if (currentCloudSessionId === cloudAgentSessionId && wsManager) {
      const status = connectionState.status;
      if (status === 'connected' || status === 'connecting' || status === 'reconnecting') {
        return;
      }
    }

    // Disconnect existing connection
    if (wsManager) {
      wsManager.disconnect();
      wsManager = null;
    }

    // Reset processor for new connection
    if (processor) {
      processor.clear();
      processor = null;
    }

    currentCloudSessionId = cloudAgentSessionId;

    const { ticket } = await fetchStreamTicket(cloudAgentSessionId);

    if (!CLOUD_AGENT_NEXT_WS_URL) {
      throw new Error('NEXT_PUBLIC_CLOUD_AGENT_NEXT_WS_URL is not configured');
    }

    const url = new URL('/stream', CLOUD_AGENT_NEXT_WS_URL);
    url.searchParams.set('cloudAgentSessionId', cloudAgentSessionId);

    const wsConfig: WebSocketManagerConfig = {
      url: url.toString(),
      ticket,
      onEvent: handleEvent,
      onStateChange: updateConnectionState,
      onError: handleStreamError,
      onRefreshTicket: async () => {
        const result = await fetchStreamTicket(cloudAgentSessionId);
        return result.ticket;
      },
    };

    wsManager = createWebSocketManager(wsConfig);
    wsManager.connect();
  }

  // ---------------------------------------------------------------------------
  // tRPC mutations
  // ---------------------------------------------------------------------------

  /**
   * Calls the appropriate mutation to initiate a prepared session.
   * Returns the cloudAgentSessionId for WebSocket connection.
   */
  async function callStartSession(): Promise<string> {
    if (organizationId) {
      const result = await trpcClient.organizations.appBuilder.startSession.mutate({
        projectId,
        organizationId,
      });
      return result.cloudAgentSessionId;
    } else {
      const result = await trpcClient.appBuilder.startSession.mutate({
        projectId,
      });
      return result.cloudAgentSessionId;
    }
  }

  async function callSendMessage(
    message: string,
    images?: Images,
    model?: string
  ): Promise<SendMessageResponse> {
    if (organizationId) {
      const result = await trpcClient.organizations.appBuilder.sendMessage.mutate({
        projectId,
        organizationId,
        message,
        images,
        model,
      });
      return { sessionId: result.cloudAgentSessionId, workerVersion: result.workerVersion };
    } else {
      const result = await trpcClient.appBuilder.sendMessage.mutate({
        projectId,
        message,
        images,
        model,
      });
      return { sessionId: result.cloudAgentSessionId, workerVersion: result.workerVersion };
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Sends a user message.
   *
   * V2 flow:
   * 1. Call sendMessage mutation — returns cloudAgentSessionId
   * 2. Connect to WebSocket to receive response events
   *
   * No optimistic message insertion — V2 messages arrive via the EventProcessor.
   */
  function sendMessage(message: string, images?: Images, model?: string): void {
    if (destroyed) {
      logger.logWarn('Cannot send message: V2 streaming coordinator is destroyed');
      return;
    }

    logger.log('V2 sending message', {
      messageLength: message.length,
      hasImages: !!images,
      model,
    });

    // Abort any in-flight operation
    currentAbortController?.abort();
    currentAbortController = new AbortController();
    const abortSignal = currentAbortController.signal;

    store.setState({ isStreaming: true });

    void (async () => {
      try {
        const response = await callSendMessage(message, images, model);
        const { sessionId, workerVersion } = response;
        logger.log('V2 sendMessage returned', { sessionId, workerVersion });

        if (destroyed || abortSignal.aborted) {
          logger.log('Operation cancelled during V2 message send');
          return;
        }

        // Detect session change: backend created a new session (upgrade or GitHub migration).
        // V2 has no optimistic message — pass the user message to the new session.
        if (sessionId !== config.cloudAgentSessionId && onSessionChanged) {
          store.setState({ isStreaming: false });
          onSessionChanged(sessionId, workerVersion, { text: message, images });
          return;
        }

        await connectWs(sessionId);
      } catch (err) {
        if (abortSignal.aborted) {
          return;
        }
        logger.logError('Failed to send V2 message', err);
        store.setState({ isStreaming: false });
      }
    })();
  }

  /**
   * Starts the initial streaming session for a newly created project.
   * Calls startSession tRPC mutation to initiate the prepared session,
   * then connects to the WebSocket for streaming events.
   */
  function startInitialStreaming(): void {
    if (destroyed) {
      logger.logWarn('Cannot start initial streaming: V2 streaming coordinator is destroyed');
      return;
    }

    logger.log('Starting V2 initial streaming');

    currentAbortController?.abort();
    currentAbortController = new AbortController();
    const abortSignal = currentAbortController.signal;

    store.setState({ isStreaming: true });

    void (async () => {
      try {
        const sessionId = await callStartSession();
        logger.log('V2 startSession returned', { sessionId });

        if (destroyed || abortSignal.aborted) {
          logger.log('Operation cancelled during V2 initial streaming start');
          return;
        }

        await connectWs(sessionId);
      } catch (err) {
        if (abortSignal.aborted) {
          return;
        }
        logger.logError('Failed to start V2 initial streaming', err);
        store.setState({ isStreaming: false });
      }
    })();
  }

  /**
   * Connects to an existing V2 session's WebSocket stream.
   */
  function connectToExistingSession(sessionId: string): void {
    if (destroyed) {
      logger.logWarn('Cannot connect to existing session: V2 streaming coordinator is destroyed');
      return;
    }

    logger.log('Connecting to existing V2 session', { sessionId });
    store.setState({ isStreaming: true });

    void (async () => {
      try {
        await connectWs(sessionId);
      } catch (err) {
        logger.logError('Failed to connect to existing V2 session', err);
        store.setState({ isStreaming: false });
      }
    })();
  }

  /**
   * Interrupts the current stream.
   * Only disconnects WebSocket and updates local state.
   * The tRPC interruptSession call is handled by ProjectManager.
   */
  function interrupt(): void {
    if (destroyed) {
      return;
    }

    logger.log('Interrupting V2 session');

    // Disconnect WebSocket
    if (wsManager) {
      wsManager.disconnect();
      wsManager = null;
    }
    currentCloudSessionId = null;

    // Force-complete all in-flight messages so they don't appear stuck in streaming state
    processor?.forceCompleteAll();

    store.setState({ isStreaming: false });
  }

  /**
   * Destroys the coordinator and cleans up resources.
   */
  function destroy(): void {
    if (destroyed) {
      return;
    }

    destroyed = true;

    currentAbortController?.abort();
    currentAbortController = null;
    currentCloudSessionId = null;

    if (processor) {
      processor.clear();
      processor = null;
    }

    if (wsManager) {
      wsManager.disconnect();
      wsManager = null;
    }
  }

  return {
    sendMessage,
    interrupt,
    startInitialStreaming,
    connectToExistingSession,
    destroy,
  };
}
