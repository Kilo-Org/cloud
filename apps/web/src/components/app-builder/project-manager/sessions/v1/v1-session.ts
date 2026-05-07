/**
 * V1 Session Factory — composes a V1 session store + streaming coordinator
 * into a self-contained V1Session conforming to the AppBuilderSession union.
 */

import type { CloudMessage } from '@/components/cloud-agent/types';
import type { Images } from '@/lib/images-schema';
import type { SessionDisplayInfo } from '@/lib/app-builder/types';
import type { AppTRPCClient } from '../../types';
import type { V1Session } from '../types';
import { createV1SessionStore } from './store';
import {
  createV1StreamingCoordinator,
  type V1StreamingCoordinator,
  type SessionChangedUserMessage,
} from './streaming';
import { createLogger } from '../../logging';

export type CreateV1SessionConfig = {
  info: SessionDisplayInfo;
  initialMessages: CloudMessage[];
  // Only needed for active sessions:
  projectId?: string;
  organizationId?: string | null;
  trpcClient?: AppTRPCClient;
  onSessionChanged?: (newSessionId: string, userMessage: SessionChangedUserMessage) => void;
};

/**
 * For active sessions (has projectId/trpcClient), creates streaming coordinator.
 * For ended sessions, all streaming methods are no-ops.
 */
export function createV1Session(config: CreateV1SessionConfig): V1Session {
  const { info, initialMessages, projectId, organizationId, trpcClient, onSessionChanged } = config;
  const cloudAgentSessionId = info.cloud_agent_session_id;
  const logger = projectId ? createLogger(projectId) : null;

  const store = createV1SessionStore(initialMessages);

  let streaming: V1StreamingCoordinator | null = null;
  if (projectId && trpcClient) {
    streaming = createV1StreamingCoordinator({
      projectId,
      organizationId: organizationId ?? null,
      trpcClient,
      store,
      cloudAgentSessionId: cloudAgentSessionId ?? null,
      onSessionChanged,
    });
  }

  async function sendMessage(
    text: string,
    images: Images | undefined,
    model: string
  ): Promise<void> {
    if (!streaming) return;
    streaming.sendMessage(text, images, model);
  }

  async function interrupt(): Promise<void> {
    if (!streaming) return;
    streaming.interrupt();
  }

  function startInitialStreaming(): void {
    streaming?.startInitialStreaming();
  }

  function connectToExistingSession(sessionId: string): void {
    streaming?.connectToExistingSession(sessionId);
  }

  let messagesLoaded = false;

  function loadMessages(): void {
    if (messagesLoaded || !cloudAgentSessionId || !projectId || !trpcClient) return;
    messagesLoaded = true;

    void (async () => {
      try {
        const result = organizationId
          ? await trpcClient.organizations.appBuilder.getLegacySessionMessages.query({
              projectId,
              organizationId,
              cloudAgentSessionId,
            })
          : await trpcClient.appBuilder.getLegacySessionMessages.query({
              projectId,
              cloudAgentSessionId,
            });
        store.setState({ messages: result.messages });
      } catch (err) {
        messagesLoaded = false;
        logger?.logError('Failed to load historical messages for legacy v1 session', err);
      }
    })();
  }

  function destroy(): void {
    streaming?.destroy();
    streaming = null;
  }

  return {
    type: 'v1',
    info,
    getState: store.getState,
    subscribe: store.subscribe,
    sendMessage,
    interrupt,
    startInitialStreaming,
    connectToExistingSession,
    loadMessages,
    destroy,
  };
}
