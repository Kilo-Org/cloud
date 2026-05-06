/**
 * V1 Streaming Module
 *
 * V1 App Builder sessions are legacy. Historical messages are loaded from R2,
 * while any new message is sent through the App Builder upgrade path so the
 * backend creates a cloud-agent-next session.
 */

import type { V1SessionStore } from './store';
import type { AppTRPCClient } from '../../types';
import type { Images } from '@/lib/images-schema';
import { addUserMessage, addErrorMessage, removeLastUserMessage } from './messages';
import { formatStreamError, createLogger } from '../../logging';

type SendMessageResponse = { sessionId: string; workerVersion: 'v2' };

export type SessionChangedUserMessage = { text: string; images?: Images };

export type V1StreamingConfig = {
  projectId: string;
  organizationId: string | null;
  trpcClient: AppTRPCClient;
  store: V1SessionStore;
  cloudAgentSessionId: string | null;
  onSessionChanged?: (newSessionId: string, userMessage: SessionChangedUserMessage) => void;
};

export type V1StreamingCoordinator = {
  sendMessage: (message: string, images?: Images, model?: string) => void;
  interrupt: () => void;
  startInitialStreaming: () => void;
  connectToExistingSession: (sessionId: string) => void;
  destroy: () => void;
};

export function createV1StreamingCoordinator(config: V1StreamingConfig): V1StreamingCoordinator {
  const { projectId, organizationId, trpcClient, store, cloudAgentSessionId, onSessionChanged } =
    config;
  const logger = createLogger(projectId);

  let destroyed = false;
  let currentAbortController: AbortController | null = null;

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
    }

    const result = await trpcClient.appBuilder.sendMessage.mutate({
      projectId,
      message,
      images,
      model,
    });
    return { sessionId: result.cloudAgentSessionId, workerVersion: result.workerVersion };
  }

  function sendMessage(message: string, images?: Images, model?: string): void {
    if (destroyed) {
      logger.logWarn('Cannot send message: V1 streaming coordinator is destroyed');
      return;
    }

    logger.log('Sending legacy App Builder message through upgrade path', {
      messageLength: message.length,
      hasImages: !!images,
      model,
    });

    currentAbortController?.abort();
    currentAbortController = new AbortController();
    const abortSignal = currentAbortController.signal;

    store.setState({ isStreaming: true });
    addUserMessage(store, message, images);

    void (async () => {
      try {
        const { sessionId, workerVersion } = await callSendMessage(message, images, model);
        logger.log('sendMessage returned', { sessionId, workerVersion });

        if (destroyed || abortSignal.aborted) {
          logger.log('Operation cancelled during message send');
          return;
        }

        // The backend always upgrades legacy (v1) sessions to cloud-agent-next, so
        // the returned sessionId must differ from the v1 sessionId we sent from, and
        // the ProjectManager-provided onSessionChanged handler must be wired up so
        // the optimistic user message can be moved to the new session.
        if (!onSessionChanged) {
          logger.logError('Legacy v1 session sent message without an onSessionChanged handler', {
            sessionId,
            workerVersion,
          });
          store.setState({ isStreaming: false });
          addErrorMessage(store, formatStreamError(new Error('Session upgrade misconfigured')));
          return;
        }

        if (sessionId === cloudAgentSessionId) {
          logger.logError('Backend did not upgrade legacy v1 session as expected', {
            sessionId,
            workerVersion,
          });
          store.setState({ isStreaming: false });
          addErrorMessage(store, formatStreamError(new Error('Session upgrade failed')));
          return;
        }

        removeLastUserMessage(store);
        store.setState({ isStreaming: false });
        onSessionChanged(sessionId, { text: message, images });
      } catch (err) {
        if (abortSignal.aborted) return;
        logger.logError('Failed to send legacy App Builder message', err);
        store.setState({ isStreaming: false });
        addErrorMessage(store, formatStreamError(err));
      }
    })();
  }

  function startInitialStreaming(): void {
    if (destroyed) {
      logger.logWarn('Cannot start initial streaming: V1 streaming coordinator is destroyed');
      return;
    }

    logger.logWarn('Cannot start initial streaming for legacy App Builder session');
  }

  function connectToExistingSession(sessionId: string): void {
    if (destroyed) {
      logger.logWarn('Cannot connect to existing session: V1 streaming coordinator is destroyed');
      return;
    }

    logger.log('Skipping legacy V1 WebSocket replay; messages are loaded from R2', { sessionId });
  }

  function interrupt(): void {
    if (destroyed) return;

    logger.log('Interrupting V1 session');
    currentAbortController?.abort();
    store.setState({ isStreaming: false });
  }

  function destroy(): void {
    if (destroyed) return;

    destroyed = true;
    currentAbortController?.abort();
    currentAbortController = null;
  }

  return {
    sendMessage,
    interrupt,
    startInitialStreaming,
    connectToExistingSession,
    destroy,
  };
}
