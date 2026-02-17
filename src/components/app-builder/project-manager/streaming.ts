/**
 * Streaming Module
 *
 * Coordinates WebSocket-based streaming for App Builder using V2 mutations.
 * This module wraps the WebSocket streaming coordinator and provides
 * methods that handle the V2 mutation flow.
 */

import {
  createWebSocketStreamingCoordinator,
  type WebSocketStreamingConfig,
  type WebSocketStreamingCoordinator,
} from './websocket-streaming';
import type { StreamingConfig, V2StreamingCoordinator, Images } from './types';
import { addUserMessage, addErrorMessage } from './messages';
import { formatStreamError as formatStreamErrorFromLogging, createLogger } from './logging';

// Re-export formatStreamError from logging for convenience
export const formatStreamError = formatStreamErrorFromLogging;

/**
 * Extended configuration for the streaming coordinator factory.
 * Includes the project's cloud agent session ID for reconnection scenarios.
 */
export type StreamingCoordinatorConfig = StreamingConfig & {
  /** The cloud agent session ID from the project (if already initiated) */
  cloudAgentSessionId: string | null;
  /** Whether the session has been prepared (false for legacy sessions) */
  sessionPrepared: boolean | null;
};

/**
 * Creates a streaming coordinator for managing WebSocket-based streaming.
 *
 * The flow:
 * 1. Call tRPC mutation (startSession or sendMessage) - returns cloudAgentSessionId
 * 2. Connect to WebSocket with the session ID to receive events
 *
 * The coordinator handles:
 * - Sending user messages via mutations
 * - Starting initial streaming sessions for new projects
 * - Reconnecting to existing sessions with event replay
 * - Interrupting active streams
 * - Managing WebSocket lifecycle
 */
export function createStreamingCoordinator(
  config: StreamingCoordinatorConfig
): V2StreamingCoordinator {
  const { projectId, organizationId, trpcClient, store, onStreamComplete, sessionPrepared } =
    config;

  const logger = createLogger(projectId);

  // Internal state
  let destroyed = false;
  let wsCoordinator: WebSocketStreamingCoordinator | null = null;
  // Track if we've prepared a legacy session (false for legacy sessions that need preparation)
  let isSessionPrepared = sessionPrepared ?? true;
  // Mutex for legacy session preparation to prevent race conditions
  let legacyPreparationInProgress = false;
  // AbortController for in-flight operations
  let currentAbortController: AbortController | null = null;

  /**
   * Creates and initializes the WebSocket coordinator lazily.
   */
  function getOrCreateWsCoordinator() {
    if (wsCoordinator && !destroyed) {
      return wsCoordinator;
    }

    const wsConfig: WebSocketStreamingConfig = {
      projectId,
      organizationId,
      trpcClient,
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
          throw new Error(error.error || `Failed to get stream ticket: ${response.status}`);
        }

        const data = (await response.json()) as { ticket: string; expiresAt: number };
        return data;
      },
    };

    wsCoordinator = createWebSocketStreamingCoordinator(wsConfig);
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
  /**
   * Extract pathname from a full URL, returning '/' on failure.
   */
  function getPreviewPath(): string | undefined {
    const currentIframeUrl = store.getState().currentIframeUrl;
    if (!currentIframeUrl) return undefined;
    try {
      return new URL(currentIframeUrl).pathname;
    } catch {
      return undefined;
    }
  }

  async function callSendMessage(
    message: string,
    images?: Images,
    model?: string
  ): Promise<string> {
    const previewPath = getPreviewPath();
    if (organizationId) {
      const result = await trpcClient.organizations.appBuilder.sendMessage.mutate({
        projectId,
        organizationId,
        message,
        images,
        model,
        previewPath,
      });
      return result.cloudAgentSessionId;
    } else {
      const result = await trpcClient.appBuilder.sendMessage.mutate({
        projectId,
        message,
        images,
        model,
        previewPath,
      });
      return result.cloudAgentSessionId;
    }
  }

  /**
   * Calls prepareLegacySession mutation for legacy sessions.
   * This:
   * 1. Backfills the Durable Object with session metadata
   * 2. Initiates the session to execute the first message
   *
   * @param model - The model to use for the session
   * @param prompt - The user's message to send
   * @returns The cloudAgentSessionId for WebSocket connection
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
    // Mark session as prepared so we don't call this again
    isSessionPrepared = true;
    return sessionId;
  }

  /**
   * Sends a user message.
   *
   * Flow for prepared sessions:
   * 1. Add user message to store immediately for optimistic UI
   * 2. Call sendMessage mutation - returns cloudAgentSessionId
   * 3. Connect to WebSocket to receive response events
   *
   * Flow for legacy sessions:
   * 1. Add user message to store immediately for optimistic UI
   * 2. Call prepareLegacySession mutation - prepares DO and initiates session with the message
   * 3. Connect to WebSocket to receive response events
   */
  function sendMessage(message: string, images?: Images, model?: string): void {
    if (destroyed) {
      logger.logWarn('Cannot send message: Streaming coordinator is destroyed');
      return;
    }

    // Prevent concurrent legacy session preparation
    if (!isSessionPrepared && legacyPreparationInProgress) {
      logger.logWarn('Cannot send message: Legacy session preparation already in progress');
      return;
    }

    logger.log('Sending message', {
      messageLength: message.length,
      hasImages: !!images,
      model,
      isSessionPrepared,
    });

    // Abort any in-flight operation
    currentAbortController?.abort();
    currentAbortController = new AbortController();
    const abortSignal = currentAbortController.signal;

    // Update state with streaming flag and optional new model
    store.setState(model ? { isStreaming: true, model } : { isStreaming: true });

    // Add user message to state immediately (optimistic update)
    addUserMessage(store, message, images);

    // Call mutation and connect to WebSocket
    void (async () => {
      try {
        let sessionId: string;

        if (!isSessionPrepared) {
          // Lock legacy preparation to prevent race conditions
          legacyPreparationInProgress = true;
          try {
            // For legacy sessions: prepareLegacySession both prepares the DO and initiates the session
            // The message is consumed by initiateFromKilocodeSessionV2 inside prepareLegacySession
            // NOTE: Legacy session preparation doesn't support images (they would need to be stored in DO)
            const effectiveModel = model || store.getState().model;
            sessionId = await callPrepareLegacySession(effectiveModel, message);
            logger.log('prepareLegacySession returned', { sessionId });
          } finally {
            legacyPreparationInProgress = false;
          }
        } else {
          // For prepared sessions: just send the message normally
          sessionId = await callSendMessage(message, images, model);
          logger.log('sendMessage returned', { sessionId });
        }

        // Check if destroyed or aborted during async operation
        if (destroyed || abortSignal.aborted) {
          logger.log('Operation cancelled during message send');
          return;
        }

        // Connect to WebSocket to receive events
        const coordinator = getOrCreateWsCoordinator();
        await coordinator.connectToStream(sessionId);
      } catch (err) {
        // Don't log or update state if operation was aborted
        if (abortSignal.aborted) {
          return;
        }
        logger.logError('Failed to send message', err);
        store.setState({ isStreaming: false });
        addErrorMessage(store, formatStreamError(err));
      }
    })();
  }

  /**
   * Starts the initial streaming session for a new project.
   *
   * Flow:
   * 1. Call startSession mutation - returns cloudAgentSessionId
   * 2. Connect to WebSocket to receive initial AI response events
   */
  function startInitialStreaming(): void {
    if (destroyed) {
      logger.logWarn('Cannot start initial streaming: Streaming coordinator is destroyed');
      return;
    }

    if (!isSessionPrepared) {
      logger.logWarn('Cannot start initial streaming: Session is not prepared');
      return;
    }

    logger.log('Starting initial streaming');

    // Abort any in-flight operation
    currentAbortController?.abort();
    currentAbortController = new AbortController();
    const abortSignal = currentAbortController.signal;

    store.setState({ isStreaming: true });

    // Call mutation and connect to WebSocket
    void (async () => {
      try {
        const sessionId = await callStartSession();
        logger.log('startSession returned', { sessionId });

        // Check if destroyed or aborted during async operation
        if (destroyed || abortSignal.aborted) {
          logger.log('Operation cancelled during initial streaming start');
          return;
        }

        // Connect to WebSocket to receive events
        const coordinator = getOrCreateWsCoordinator();
        await coordinator.connectToStream(sessionId);
      } catch (err) {
        // Don't log or update state if operation was aborted
        if (abortSignal.aborted) {
          return;
        }
        logger.logError('Failed to start initial streaming', err);
        store.setState({ isStreaming: false });
        addErrorMessage(store, formatStreamError(err));
      }
    })();
  }

  /**
   * Connects to an existing session to replay events.
   * Used for reconnection when loading an existing project.
   *
   * @param sessionId - The cloud agent session ID to connect to
   * @param fromId - Event ID to replay from (0 to replay all events, undefined for new events only)
   */
  async function connectToExistingSession(sessionId: string, fromId?: number): Promise<void> {
    if (destroyed) {
      logger.logWarn('Cannot connect to existing session: Streaming coordinator is destroyed');
      return;
    }

    logger.log('Connecting to existing session', { sessionId, fromId });
    store.setState({ isStreaming: true });

    try {
      const coordinator = getOrCreateWsCoordinator();
      await coordinator.connectToStream(sessionId, fromId);
    } catch (err) {
      logger.logError('Failed to connect to existing session', err);
      store.setState({ isStreaming: false });
      addErrorMessage(store, formatStreamError(err));
    }
  }

  /**
   * Interrupts the current stream.
   */
  function interrupt(): void {
    if (destroyed) {
      return;
    }

    logger.log('Interrupting session');

    // Interrupt via WebSocket coordinator
    wsCoordinator?.interrupt();

    store.setState({ isStreaming: false, isInterrupting: true });

    // Call the interrupt API
    const handleInterruptComplete = () => {
      store.setState({ isInterrupting: false });
    };

    if (organizationId) {
      void trpcClient.organizations.appBuilder.interruptSession
        .mutate({
          projectId,
          organizationId,
        })
        .catch((err: Error) => {
          logger.logError('Failed to interrupt session', err);
        })
        .finally(handleInterruptComplete);
    } else {
      void trpcClient.appBuilder.interruptSession
        .mutate({
          projectId,
        })
        .catch((err: Error) => {
          logger.logError('Failed to interrupt session', err);
        })
        .finally(handleInterruptComplete);
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

    // Abort any in-flight operations
    currentAbortController?.abort();
    currentAbortController = null;

    wsCoordinator?.destroy();
    wsCoordinator = null;
  }

  return {
    sendMessage,
    startInitialStreaming,
    interrupt,
    destroy,
    connectToExistingSession,
  };
}
