/**
 * V1 Streaming Module
 *
 * Coordinates V1 WebSocket-based streaming for App Builder sessions.
 * This module wraps the V1 WebSocket streaming coordinator and provides
 * methods for sending messages, interrupting, and managing session lifecycle.
 *
 * This is purely V1 — no V2 or auto-upgrade logic.
 * Auto-upgrade detection is signaled via the onUpgradeDetected callback,
 * allowing ProjectManager to handle the upgrade externally.
 */

import {
  createV1WebSocketStreamingCoordinator,
  type V1WebSocketStreamingConfig,
  type V1WebSocketStreamingCoordinator,
} from './websocket-streaming';
import type { V1SessionStore } from './store';
import type { AppTRPCClient } from '../../types';
import type { Images } from '@/lib/images-schema';
import { addUserMessage, addErrorMessage } from './messages';
import { formatStreamError, createLogger } from '../../logging';

export type V1StreamingConfig = {
  projectId: string;
  organizationId: string | null;
  trpcClient: AppTRPCClient;
  store: V1SessionStore;
  /** The cloud agent session ID from the project (if already initiated) */
  cloudAgentSessionId: string | null;
  /** Whether the session has been prepared (false for legacy sessions) */
  sessionPrepared: boolean | null;
  onStreamComplete?: () => void;
  /** Called when the backend returns a different session ID, signaling an upgrade */
  onUpgradeDetected?: (newSessionId: string) => void;
};

export type V1StreamingCoordinator = {
  sendMessage: (message: string, images?: Images, model?: string) => void;
  interrupt: () => void;
  startInitialStreaming: () => void;
  connectToExistingSession: (sessionId: string) => void;
  destroy: () => void;
};

/**
 * Creates a V1 streaming coordinator for managing WebSocket-based streaming.
 *
 * The flow:
 * 1. Call tRPC mutation (startSession or sendMessage) — returns cloudAgentSessionId
 * 2. Connect to WebSocket with the session ID to receive events
 *
 * For legacy (unprepared) sessions, uses prepareLegacySession mutation instead.
 */
export function createV1StreamingCoordinator(config: V1StreamingConfig): V1StreamingCoordinator {
  const { projectId, organizationId, trpcClient, store, onStreamComplete, onUpgradeDetected } =
    config;

  const logger = createLogger(projectId);

  // Internal state
  let destroyed = false;
  let wsCoordinator: V1WebSocketStreamingCoordinator | null = null;
  let isSessionPrepared = config.sessionPrepared ?? true;
  let legacyPreparationInProgress = false;
  let currentAbortController: AbortController | null = null;

  /**
   * Creates and initializes the V1 WebSocket coordinator lazily.
   */
  function getOrCreateWsCoordinator(): V1WebSocketStreamingCoordinator {
    if (destroyed) {
      throw new Error('Cannot create V1 WebSocket coordinator: streaming coordinator is destroyed');
    }
    if (wsCoordinator) {
      return wsCoordinator;
    }

    const wsConfig: V1WebSocketStreamingConfig = {
      projectId,
      store,
      onStreamComplete,
      fetchStreamTicket: async (cloudAgentSessionId: string) => {
        const response = await fetch('/api/cloud-agent/sessions/stream-ticket', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            cloudAgentSessionId,
            ...(organizationId ? { organizationId } : {}),
          }),
        });

        if (!response.ok) {
          const error = await response.json().catch(() => ({ error: 'Unknown error' }));
          throw new Error(
            (error as { error?: string }).error ?? `Failed to get stream ticket: ${response.status}`
          );
        }

        return (await response.json()) as { ticket: string; expiresAt: number };
      },
    };

    wsCoordinator = createV1WebSocketStreamingCoordinator(wsConfig);
    return wsCoordinator;
  }

  /**
   * Calls the appropriate mutation to start a session.
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

  /**
   * Calls the appropriate mutation to send a message.
   */
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

  /**
   * Calls prepareLegacySession mutation for legacy sessions.
   * This:
   * 1. Backfills the Durable Object with session metadata
   * 2. Initiates the session to execute the first message
   */
  async function callPrepareLegacySession(model: string, prompt: string): Promise<string> {
    logger.log('Preparing legacy session', { model, promptLength: prompt.length });
    let sessionId: string;
    if (organizationId) {
      const result = await trpcClient.organizations.appBuilder.prepareLegacySession.mutate({
        projectId,
        organizationId,
        model,
        prompt,
      });
      sessionId = result.cloudAgentSessionId;
    } else {
      const result = await trpcClient.appBuilder.prepareLegacySession.mutate({
        projectId,
        model,
        prompt,
      });
      sessionId = result.cloudAgentSessionId;
    }
    isSessionPrepared = true;
    return sessionId;
  }

  /**
   * Sends a user message.
   *
   * Flow for prepared sessions:
   * 1. Add user message to store immediately for optimistic UI
   * 2. Call sendMessage mutation — returns cloudAgentSessionId
   * 3. Connect to WebSocket to receive response events
   *
   * Flow for legacy sessions:
   * 1. Add user message to store immediately for optimistic UI
   * 2. Call prepareLegacySession mutation — prepares DO and initiates session with the message
   * 3. Connect to WebSocket to receive response events
   */
  function sendMessage(message: string, images?: Images, model?: string): void {
    if (destroyed) {
      logger.logWarn('Cannot send message: V1 streaming coordinator is destroyed');
      return;
    }

    if (!isSessionPrepared && legacyPreparationInProgress) {
      logger.logWarn('Cannot send message: Legacy session preparation already in progress');
      return;
    }

    logger.log('V1 sending message', {
      messageLength: message.length,
      hasImages: !!images,
      model,
      isSessionPrepared,
    });

    // Abort any in-flight operation
    currentAbortController?.abort();
    currentAbortController = new AbortController();
    const abortSignal = currentAbortController.signal;

    store.setState({ isStreaming: true });

    // Add user message to state immediately (optimistic update)
    addUserMessage(store, message, images);

    void (async () => {
      try {
        let sessionId: string;

        if (!isSessionPrepared) {
          legacyPreparationInProgress = true;
          try {
            // For legacy sessions: prepareLegacySession both prepares the DO and initiates the session
            // NOTE: Legacy session preparation doesn't support images
            sessionId = await callPrepareLegacySession(
              model ?? 'anthropic/claude-sonnet-4',
              message
            );
            logger.log('prepareLegacySession returned', { sessionId });
          } finally {
            legacyPreparationInProgress = false;
          }
        } else {
          sessionId = await callSendMessage(message, images, model);
          logger.log('sendMessage returned', { sessionId });
        }

        if (destroyed || abortSignal.aborted) {
          logger.log('Operation cancelled during message send');
          return;
        }

        // Detect auto-upgrade: if session ID changed, backend may have created a v2 session
        if (sessionId !== config.cloudAgentSessionId && onUpgradeDetected) {
          onUpgradeDetected(sessionId);
          return;
        }

        const coordinator = getOrCreateWsCoordinator();
        await coordinator.connectToStream(sessionId);
      } catch (err) {
        if (abortSignal.aborted) {
          return;
        }
        logger.logError('Failed to send V1 message', err);
        store.setState({ isStreaming: false });
        addErrorMessage(store, formatStreamError(err));
      }
    })();
  }

  /**
   * Starts the initial streaming session for a new project.
   */
  function startInitialStreaming(): void {
    if (destroyed) {
      logger.logWarn('Cannot start initial streaming: V1 streaming coordinator is destroyed');
      return;
    }

    if (!isSessionPrepared) {
      logger.logWarn('Cannot start initial streaming: Session is not prepared');
      return;
    }

    logger.log('Starting V1 initial streaming');

    currentAbortController?.abort();
    currentAbortController = new AbortController();
    const abortSignal = currentAbortController.signal;

    store.setState({ isStreaming: true });

    void (async () => {
      try {
        const sessionId = await callStartSession();
        logger.log('startSession returned', { sessionId });

        if (destroyed || abortSignal.aborted) {
          logger.log('Operation cancelled during initial streaming start');
          return;
        }

        const coordinator = getOrCreateWsCoordinator();
        await coordinator.connectToStream(sessionId);
      } catch (err) {
        if (abortSignal.aborted) {
          return;
        }
        logger.logError('Failed to start V1 initial streaming', err);
        store.setState({ isStreaming: false });
        addErrorMessage(store, formatStreamError(err));
      }
    })();
  }

  /**
   * Connects to an existing session to replay events.
   */
  function connectToExistingSession(sessionId: string): void {
    if (destroyed) {
      logger.logWarn('Cannot connect to existing session: V1 streaming coordinator is destroyed');
      return;
    }

    logger.log('Connecting to existing V1 session', { sessionId });
    store.setState({ isStreaming: true });

    void (async () => {
      try {
        const coordinator = getOrCreateWsCoordinator();
        await coordinator.connectToStream(sessionId);
      } catch (err) {
        logger.logError('Failed to connect to existing V1 session', err);
        store.setState({ isStreaming: false });
        addErrorMessage(store, formatStreamError(err));
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

    logger.log('Interrupting V1 session');

    wsCoordinator?.interrupt();

    store.setState({ isStreaming: false });

    // Call the interrupt API
    if (organizationId) {
      void trpcClient.organizations.appBuilder.interruptSession
        .mutate({ projectId, organizationId })
        .catch((err: Error) => {
          logger.logError('Failed to interrupt V1 session', err);
        });
    } else {
      void trpcClient.appBuilder.interruptSession.mutate({ projectId }).catch((err: Error) => {
        logger.logError('Failed to interrupt V1 session', err);
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

    wsCoordinator?.destroy();
    wsCoordinator = null;
  }

  return {
    sendMessage,
    interrupt,
    startInitialStreaming,
    connectToExistingSession,
    destroy,
  };
}
