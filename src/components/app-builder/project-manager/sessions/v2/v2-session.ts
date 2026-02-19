/**
 * V2 Session Factory — composes a V2 session store + streaming coordinator
 * into a self-contained V2Session conforming to the AppBuilderSession union.
 */

import type { StoredMessage } from '@/components/cloud-agent-next/types';
import type { Images } from '@/lib/images-schema';
import type { ProjectSessionInfo } from '@/lib/app-builder/types';
import type { AppTRPCClient } from '../../types';
import type { V2Session } from '../types';
import { createV2SessionStore } from './store';
import { createV2StreamingCoordinator, type V2StreamingCoordinator } from './streaming';

export type CreateV2SessionConfig = {
  info: ProjectSessionInfo;
  initialMessages: StoredMessage[];
  // Only needed for active sessions:
  projectId?: string;
  organizationId?: string | null;
  trpcClient?: AppTRPCClient;
  cloudAgentSessionId?: string | null;
  onStreamComplete?: () => void;
};

/**
 * For active sessions (has projectId/trpcClient), creates streaming coordinator.
 * For ended sessions, all streaming methods are no-ops.
 */
export function createV2Session(config: CreateV2SessionConfig): V2Session {
  const {
    info,
    initialMessages,
    projectId,
    organizationId,
    trpcClient,
    cloudAgentSessionId,
    onStreamComplete,
  } = config;

  const store = createV2SessionStore(initialMessages);

  let streaming: V2StreamingCoordinator | null = null;
  if (projectId && trpcClient) {
    streaming = createV2StreamingCoordinator({
      projectId,
      organizationId: organizationId ?? null,
      trpcClient,
      store,
      cloudAgentSessionId: cloudAgentSessionId ?? null,
      onStreamComplete,
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

  function destroy(): void {
    streaming?.destroy();
    streaming = null;
  }

  return {
    type: 'v2',
    info,
    getState: store.getState,
    subscribe: store.subscribe,
    sendMessage,
    interrupt,
    startInitialStreaming,
    connectToExistingSession,
    destroy,
  };
}
