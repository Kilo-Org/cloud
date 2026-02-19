/**
 * Shared types for ProjectManager modules.
 */

import type { TRPCClient } from '@trpc/client';
import type { RootRouter } from '@/routers/root-router';
import type { AppBuilderProject, DeployProjectResult } from '@/lib/app-builder/types';
import type { AppBuilderSession } from './sessions/types';

export type { AppBuilderSession, V1Session, V2Session } from './sessions/types';

export type AppTRPCClient = TRPCClient<RootRouter>;

export type PreviewStatus = 'idle' | 'building' | 'running' | 'error';

export type ProjectState = {
  /** Derived from active session — true if active session is streaming */
  isStreaming: boolean;
  isInterrupting: boolean;
  previewUrl: string | null;
  previewStatus: PreviewStatus;
  deploymentId: string | null;
  model: string;
  /** Current URL the user is viewing in the preview iframe (tracked via postMessage) */
  currentIframeUrl: string | null;
  /** GitHub repo name if migrated (e.g., "owner/repo"), null if not migrated */
  gitRepoFullName: string | null;
  /** Session objects — each owns its own messages and streaming state */
  sessions: AppBuilderSession[];
};

export type StateListener = () => void;

export type ProjectStore = {
  getState: () => ProjectState;
  setState: (partial: Partial<ProjectState>) => void;
  subscribe: (listener: StateListener) => () => void;
};

export type ProjectManagerConfig = {
  project: AppBuilderProject;
  trpcClient: AppTRPCClient;
  organizationId: string | null;
};

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

export type DeployResult = DeployProjectResult;

export type DeploymentConfig = {
  projectId: string;
  organizationId: string | null;
  trpcClient: AppTRPCClient;
  store: ProjectStore;
};

export type { CloudMessage, StreamEvent } from '@/components/cloud-agent/types';
export type { Images } from '@/lib/images-schema';
