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
import { formatStreamError, createLogger } from '../../logging';

export type V2StreamingConfig = {
  projectId: string;
  organizationId: string | null;
  trpcClient: AppTRPCClient;
  store: V2SessionStore;
  cloudAgentSessionId: string | null;
  onStreamComplete?: () => void;
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
 * V2 does NOT use callStartSession — startInitialStreaming is a no-op.
 */
export function createV2StreamingCoordinator(config: V2StreamingConfig): V2StreamingCoordinator {
  const { projectId, organizationId, trpcClient, store, onStreamComplete } = config;

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

  function createProcessorCallbacks(): EventProcessorCallbacks {
    return {
      onMessageUpdated: (_sessionId, messageId, message, _parentSessionId) => {
        store.updateMessages(messages => {
          const idx = messages.findIndex(m => m.info.id === messageId);
          const storedMsg: StoredMessage = { info: message.info, parts: message.parts };
          if (idx >= 0) {
            const updated = [...messages];
            updated[idx] = storedMsg;
            return updated;
          }
          return [...messages, storedMsg];
        });
      },

      onMessageCompleted: (_sessionId, messageId, message, _parentSessionId) => {
        store.updateMessages(messages => {
          const idx = messages.findIndex(m => m.info.id === messageId);
          const storedMsg: StoredMessage = { info: message.info, parts: message.parts };
          if (idx >= 0) {
            const updated = [...messages];
            updated[idx] = storedMsg;
            return updated;
          }
          return [...messages, storedMsg];
        });
      },

      onPartUpdated: (_sessionId, messageId, _partId, part, _parentSessionId) => {
        store.updateMessages(messages => {
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

      onPartRemoved: (_sessionId, messageId, partId, _parentSessionId) => {
        store.updateMessages(messages => {
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
        if (!streaming) {
          onStreamComplete?.();
        }
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

  async function callSendMessage(
    message: string,
    images?: Images,
    model?: string
  ): Promise<string> {
    if (organizationId) {
      const result = await trpcClient.organizations.appBuilder.sendMessage.mutate({
        projectId,
        organizationId,
        message,
        images,
        model,
      });
      return result.cloudAgentSessionId;
    } else {
      const result = await trpcClient.appBuilder.sendMessage.mutate({
        projectId,
        message,
        images,
        model,
      });
      return result.cloudAgentSessionId;
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
        const sessionId = await callSendMessage(message, images, model);
        logger.log('V2 sendMessage returned', { sessionId });

        if (destroyed || abortSignal.aborted) {
          logger.log('Operation cancelled during V2 message send');
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
   * Starts the initial streaming session.
   * V2 does not use callStartSession — this is a no-op.
   */
  function startInitialStreaming(): void {
    // No-op for V2 sessions
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
    store.setState({ isStreaming: false });

    // Call the interrupt API
    if (organizationId) {
      void trpcClient.organizations.appBuilder.interruptSession
        .mutate({ projectId, organizationId })
        .catch((err: Error) => {
          logger.logError('Failed to interrupt V2 session', err);
        });
    } else {
      void trpcClient.appBuilder.interruptSession.mutate({ projectId }).catch((err: Error) => {
        logger.logError('Failed to interrupt V2 session', err);
      });
    }
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
