/**
 * V1 Session Factory — composes a V1 session store + streaming coordinator
 * into a self-contained V1Session conforming to the AppBuilderSession union.
 */

import type { CloudMessage } from '@/components/cloud-agent/types';
import type { Images } from '@/lib/images-schema';
import type { SessionDisplayInfo, WorkerVersion } from '@/lib/app-builder/types';
import type { AppTRPCClient } from '../../types';
import type { V1Session } from '../types';
import { createV1SessionStore } from './store';
import {
  createV1StreamingCoordinator,
  type V1StreamingCoordinator,
  type SessionChangedUserMessage,
} from './streaming';

export type CreateV1SessionConfig = {
  info: SessionDisplayInfo;
  initialMessages: CloudMessage[];
  // Only needed for active sessions:
  projectId?: string;
  organizationId?: string | null;
  trpcClient?: AppTRPCClient;
  sessionPrepared?: boolean | null;
  onStreamComplete?: () => void;
  onSessionChanged?: (
    newSessionId: string,
    workerVersion: WorkerVersion,
    userMessage: SessionChangedUserMessage
  ) => void;
};

/**
 * For active sessions (has projectId/trpcClient), creates streaming coordinator.
 * For ended sessions, all streaming methods are no-ops.
 */
export function createV1Session(config: CreateV1SessionConfig): V1Session {
  const {
    info,
    initialMessages,
    projectId,
    organizationId,
    trpcClient,
    sessionPrepared,
    onStreamComplete,
    onSessionChanged,
  } = config;
  const cloudAgentSessionId = info.cloud_agent_session_id;

  const store = createV1SessionStore(initialMessages);

  let streaming: V1StreamingCoordinator | null = null;
  if (projectId && trpcClient) {
    streaming = createV1StreamingCoordinator({
      projectId,
      organizationId: organizationId ?? null,
      trpcClient,
      store,
      cloudAgentSessionId: cloudAgentSessionId ?? null,
      sessionPrepared: sessionPrepared ?? null,
      onStreamComplete,
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
    if (messagesLoaded || !cloudAgentSessionId) return;
    messagesLoaded = true;
    connectToExistingSession(cloudAgentSessionId);
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
