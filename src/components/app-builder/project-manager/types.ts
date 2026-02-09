/**
 * Shared types for ProjectManager modules.
 * These types define the contracts between modules.
 */

import type { TRPCClient } from '@trpc/client';
import type { RootRouter } from '@/routers/root-router';
import type { CloudMessage } from '@/components/cloud-agent/types';
import type { AppBuilderProject, DeployProjectResult } from '@/lib/app-builder/types';
import type { Images } from '@/lib/images-schema';

// =============================================================================
// TRPC Client Type
// =============================================================================

export type AppTRPCClient = TRPCClient<RootRouter>;

// =============================================================================
// State Types
// =============================================================================

export type PreviewStatus = 'idle' | 'building' | 'running' | 'error';

export type ProjectState = {
  messages: CloudMessage[];
  isStreaming: boolean;
  isInterrupting: boolean;
  previewUrl: string | null;
  previewStatus: PreviewStatus;
  deploymentId: string | null;
  model: string;
  /** Current URL the user is viewing in the preview iframe (tracked via postMessage) */
  currentIframeUrl: string | null;
};

// =============================================================================
// Store Types
// =============================================================================

export type StateListener = () => void;

export type ProjectStore = {
  getState: () => ProjectState;
  setState: (partial: Partial<ProjectState>) => void;
  subscribe: (listener: StateListener) => () => void;
  updateMessages: (updater: (messages: CloudMessage[]) => CloudMessage[]) => void;
};

// =============================================================================
// Configuration Types
// =============================================================================

export type ProjectManagerConfig = {
  project: AppBuilderProject;
  messages: CloudMessage[];
  trpcClient: AppTRPCClient;
  organizationId: string | null;
};

// =============================================================================
// Preview Polling Types
// =============================================================================

export type PreviewPollingConfig = {
  projectId: string;
  organizationId: string | null;
  trpcClient: AppTRPCClient;
  store: ProjectStore;
  isDestroyed: () => boolean;
};

export type PreviewPollingState = {
  isPolling: boolean;
  stop: () => void;
};

// =============================================================================
// Streaming Types
// =============================================================================

export type StreamingConfig = {
  projectId: string;
  organizationId: string | null;
  trpcClient: AppTRPCClient;
  store: ProjectStore;
  onStreamComplete?: () => void;
};

export type StreamingCoordinator = {
  sendMessage: (message: string, images?: Images, model?: string) => void;
  interrupt: () => void;
  startInitialStreaming: () => void;
  destroy: () => void;
};

/**
 * Extended streaming coordinator with V2-specific methods.
 * Used for WebSocket-based streaming with the V2 API.
 */
export type V2StreamingCoordinator = StreamingCoordinator & {
  /**
   * Connect to WebSocket stream for an existing session.
   * Used for reconnection or replaying messages.
   * @param cloudAgentSessionId - The cloud agent session ID to connect to
   * @param fromId - Event ID to replay from (0 to replay all events)
   */
  connectToExistingSession: (cloudAgentSessionId: string, fromId?: number) => Promise<void>;
};

// =============================================================================
// Deployment Types
// =============================================================================

export type DeployResult = DeployProjectResult;

export type DeploymentConfig = {
  projectId: string;
  organizationId: string | null;
  trpcClient: AppTRPCClient;
  store: ProjectStore;
};

// =============================================================================
// Re-exports for convenience
// =============================================================================

export type { CloudMessage, StreamEvent } from '@/components/cloud-agent/types';
export type { Images } from '@/lib/images-schema';
