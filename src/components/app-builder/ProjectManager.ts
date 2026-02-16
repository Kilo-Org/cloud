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
 * - usePreviewEvents.ts: SSE-based real-time preview events
 * - deployments.ts: Production deployment logic
 * - logging.ts: Prefixed console logging
 */

import { type TRPCClient } from '@trpc/client';
import type { RootRouter } from '@/routers/root-router';
import type { DeployProjectResult, ProjectWithMessages } from '@/lib/app-builder/types';
import type { Images } from '@/lib/images-schema';
import { createLogger, type Logger } from './project-manager/logging';
import { createProjectStore, createInitialState } from './project-manager/store';
import type {
  ProjectStore,
  V2StreamingCoordinator,
  PreviewStatus,
  ProjectState,
} from './project-manager/types';
import { startPreviewEvents } from './project-manager/usePreviewEvents';
import type { PreviewEventsHandle } from './project-manager/types';
import { createStreamingCoordinator } from './project-manager/streaming';
import { deploy as deployProject } from './project-manager/deployments';

export type { PreviewStatus, ProjectState };

// =============================================================================
// Type Definitions
// =============================================================================

type AppTRPCClient = TRPCClient<RootRouter>;

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
  private previewEventsHandle: PreviewEventsHandle | null = null;
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
      onStreamComplete: () => this.handleStreamComplete(),
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
      // Existing project with no session ID - just start SSE events
      this.startPreviewEventsIfNeeded();
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
          // Start SSE events immediately for real-time updates
          setTimeout(() => {
            this.startPreviewEventsIfNeeded();
          }, 100);
          this.streamingCoordinator.startInitialStreaming();
        }
      });
    } else if (this.pendingReconnect && this.cloudAgentSessionId) {
      this.pendingReconnect = false;
      // Reconnect to existing session for live updates
      queueMicrotask(() => {
        if (!this.destroyed && this.cloudAgentSessionId) {
          this.startPreviewEventsIfNeeded();
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

  /**
   * Resume from sleeping state: trigger a build and start polling.
   * Called when the user clicks "Resume" in the SleepingState UI.
   */
  resumeFromSleep(): void {
    if (this.destroyed) return;
    this.store.setState({ previewStatus: 'building' });
    this.triggerBuild();
    // The previous SSE handle may still be alive (container-stopped doesn't
    // call stop()). Tear it down so startPreviewEventsIfNeeded can reconnect.
    if (this.previewEventsHandle) {
      this.previewEventsHandle.stop();
      this.previewEventsHandle = null;
    }
    this.startPreviewEventsIfNeeded();
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

    // Stop SSE events
    if (this.previewEventsHandle) {
      this.previewEventsHandle.stop();
      this.previewEventsHandle = null;
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Called when the LLM finishes a streaming turn.
   * Triggers a build (wakes a sleeping container). SSE events handle status updates.
   */
  private handleStreamComplete(): void {
    if (this.destroyed) return;
    // Avoid flicker: keep showing the running iframe while the build starts
    const currentStatus = this.store.getState().previewStatus;
    if (currentStatus !== 'running') {
      this.store.setState({ previewStatus: 'building' });
    }
    this.triggerBuild();
    this.startPreviewEventsIfNeeded();
  }

  /**
   * Trigger a build via tRPC (fire-and-forget).
   * SSE events will deliver status updates in real time.
   */
  private triggerBuild(): void {
    const buildPromise = this.organizationId
      ? this.trpcClient.organizations.appBuilder.triggerBuild.mutate({
          projectId: this.projectId,
          organizationId: this.organizationId,
        })
      : this.trpcClient.appBuilder.triggerBuild.mutate({
          projectId: this.projectId,
        });

    buildPromise.catch(() => {
      if (!this.destroyed) {
        this.store.setState({ previewStatus: 'error' });
      }
    });
  }

  private startPreviewEventsIfNeeded(): void {
    // Prevent duplicate SSE connections
    if (this.previewEventsHandle || this.destroyed) {
      return;
    }

    this.logger.log('Starting SSE events');
    this.previewEventsHandle = startPreviewEvents({
      projectId: this.projectId,
      organizationId: this.organizationId,
      trpcClient: this.trpcClient,
      store: this.store,
      isDestroyed: () => this.destroyed,
    });
  }
}
