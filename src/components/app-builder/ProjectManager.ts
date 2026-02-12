/**
 * ProjectManager
 *
 * Thin orchestrator class for App Builder project lifecycle.
 * Composes specialized modules for state, streaming, preview, and deployments.
 *
 * Module composition:
 * - store.ts: State management and subscriber notifications
 * - messages.ts: Message creation and version tracking
 * - streaming.ts: WebSocket-based streaming coordination (V2 API)
 * - preview-polling.ts: Preview status polling and build triggers
 * - deployments.ts: Production deployment logic
 * - logging.ts: Prefixed console logging
 */

import { type TRPCClient } from '@trpc/client';
import type { RootRouter } from '@/routers/root-router';
import type { CloudMessage } from '@/components/cloud-agent/types';
import type { DeployProjectResult, ProjectWithMessages } from '@/lib/app-builder/types';
import type { Images } from '@/lib/images-schema';
import { createLogger, type Logger } from './project-manager/logging';
import { createProjectStore, createInitialState } from './project-manager/store';
import type { ProjectStore, V2StreamingCoordinator } from './project-manager/types';
import { startPreviewPolling, type PreviewPollingState } from './project-manager/preview-polling';
import { createStreamingCoordinator } from './project-manager/streaming';
import { deploy as deployProject } from './project-manager/deployments';

// =============================================================================
// Type Definitions
// =============================================================================

type AppTRPCClient = TRPCClient<RootRouter>;

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
  /** GitHub repo name if migrated (e.g., "owner/repo"), null if not migrated */
  gitRepoFullName: string | null;
};

export type ProjectManagerConfig = {
  project: ProjectWithMessages;
  trpcClient: AppTRPCClient;
  organizationId: string | null;
};

export type DeployResult = DeployProjectResult;

// =============================================================================
// ProjectManager Class
// =============================================================================

export class ProjectManager {
  readonly projectId: string;
  readonly organizationId: string | null;

  private store: ProjectStore;
  private previewPollingState: PreviewPollingState | null = null;
  private trpcClient: AppTRPCClient;
  private logger: Logger;
  private streamingCoordinator: V2StreamingCoordinator;
  /** Whether this manager has been destroyed. Used by React to detect Strict Mode re-mounts. */
  destroyed = false;

  private pendingInitialStreamingStart = false;
  private pendingReconnect = false;
  private hasStartedInitialStreaming = false;
  /** The cloud agent session ID from the project, used for reconnection */
  private cloudAgentSessionId: string | null;

  constructor(config: ProjectManagerConfig) {
    const { project, trpcClient, organizationId } = config;

    this.projectId = project.id;
    this.organizationId = organizationId;
    this.trpcClient = trpcClient;
    this.logger = createLogger(project.id);
    this.cloudAgentSessionId = project.session_id ?? null;

    // Initialize store with initial state
    const initialState = createInitialState(
      project.messages,
      project.deployment_id ?? null,
      project.model_id ?? null,
      project.git_repo_full_name ?? null
    );
    this.store = createProjectStore(initialState);

    // Initialize streaming coordinator with V2 WebSocket support
    this.streamingCoordinator = createStreamingCoordinator({
      projectId: this.projectId,
      organizationId: this.organizationId,
      trpcClient: this.trpcClient,
      store: this.store,
      onStreamComplete: () => this.startPreviewPollingIfNeeded(),
      cloudAgentSessionId: this.cloudAgentSessionId,
      sessionPrepared: project.sessionPrepared,
    });

    // Determine what to do based on session state
    if (project.sessionInitiated === false) {
      // New project - session prepared but not initiated
      // Defer the actual start until React has subscribed (see subscribe method)
      this.pendingInitialStreamingStart = true;
    } else if (this.cloudAgentSessionId) {
      // Existing project with session - reconnect to WebSocket for live updates
      this.pendingReconnect = true;
    } else {
      // Existing project with no session ID - just start preview polling
      this.startPreviewPollingIfNeeded();
    }
  }

  // ===========================================================================
  // React Integration (useSyncExternalStore pattern)
  // ===========================================================================

  /**
   * Subscribe to state changes. Returns an unsubscribe function.
   * Compatible with React's useSyncExternalStore.
   */
  subscribe = (listener: () => void): (() => void) => {
    const unsubscribe = this.store.subscribe(listener);

    // Start pending initial streaming once React has subscribed
    // This ensures the first subscriber is registered before events arrive
    if (this.pendingInitialStreamingStart && !this.hasStartedInitialStreaming) {
      this.hasStartedInitialStreaming = true;
      // Use queueMicrotask to ensure subscribe() returns before streaming starts
      // This guarantees React's subscription setup is complete
      queueMicrotask(() => {
        if (!this.destroyed) {
          // Start preview polling immediately for faster initial display
          setTimeout(() => {
            this.startPreviewPollingIfNeeded();
          }, 100);
          this.streamingCoordinator.startInitialStreaming();
        }
      });
    } else if (this.pendingReconnect && this.cloudAgentSessionId) {
      this.pendingReconnect = false;
      // Reconnect to existing session for live updates
      queueMicrotask(() => {
        if (!this.destroyed && this.cloudAgentSessionId) {
          this.startPreviewPollingIfNeeded();
          // Connect to WebSocket but don't replay events (undefined fromId)
          void this.streamingCoordinator.connectToExistingSession(this.cloudAgentSessionId);
        }
      });
    }

    return unsubscribe;
  };

  /** Returns the current project state snapshot. */
  getState = (): ProjectState => {
    return this.store.getState();
  };

  // ===========================================================================
  // Public Actions
  // ===========================================================================

  /**
   * Send a user message to the AI assistant and start streaming the response.
   * @param message - The user's text message
   * @param images - Optional array of image attachments
   * @param model - Optional model override for this request
   */
  sendMessage(message: string, images?: Images, model?: string): void {
    this.streamingCoordinator.sendMessage(message, images, model);
  }

  /**
   * Update the current iframe URL (called from preview component via postMessage listener).
   * @param url - The current URL in the preview iframe, or null to clear
   */
  setCurrentIframeUrl(url: string | null): void {
    this.store.setState({ currentIframeUrl: url });
  }

  /** Interrupt the current streaming response. */
  interrupt(): void {
    this.streamingCoordinator.interrupt();
  }

  /** Update the GitHub repo full name after migration (e.g., "owner/repo"). */
  setGitRepoFullName(repoFullName: string): void {
    this.store.setState({ gitRepoFullName: repoFullName });
  }

  /**
   * Deploy the project to production.
   * @returns Promise resolving to deployment result with URL or error
   * @throws Error if manager is destroyed
   */
  async deploy(): Promise<DeployResult> {
    if (this.destroyed) {
      throw new Error('Cannot deploy: ProjectManager is destroyed');
    }

    this.logger.log('Deploying project');

    return deployProject({
      projectId: this.projectId,
      organizationId: this.organizationId,
      trpcClient: this.trpcClient,
      store: this.store,
    });
  }

  /**
   * Destroy the manager and clean up all resources.
   * Called automatically on component unmount.
   * Safe to call multiple times.
   */
  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;

    // Clean up streaming coordinator
    this.streamingCoordinator.destroy();

    // Stop preview polling
    if (this.previewPollingState) {
      this.previewPollingState.stop();
      this.previewPollingState = null;
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private startPreviewPollingIfNeeded(): void {
    // Prevent multiple concurrent polling loops
    if (this.previewPollingState?.isPolling || this.destroyed) {
      return;
    }

    this.logger.log('Starting preview polling');
    this.previewPollingState = startPreviewPolling({
      projectId: this.projectId,
      organizationId: this.organizationId,
      trpcClient: this.trpcClient,
      store: this.store,
      isDestroyed: () => this.destroyed,
    });
  }
}
