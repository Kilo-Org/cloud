/**
 * ProjectManager — closure-based orchestrator for App Builder project lifecycle.
 *
 * Composes session objects (V1/V2) for streaming and message handling,
 * and specialized modules for state, preview, and deployments.
 */

import type {
  DeployProjectResult,
  ProjectSessionInfo,
  ProjectWithMessages,
} from '@/lib/app-builder/types';
import type { Images } from '@/lib/images-schema';
import type { TRPCClient } from '@trpc/client';
import type { RootRouter } from '@/routers/root-router';
import { createLogger } from './project-manager/logging';
import { createProjectStore, createInitialState } from './project-manager/store';
import type { ProjectState, ProjectStore, AppBuilderSession } from './project-manager/types';
import { startPreviewPolling, type PreviewPollingState } from './project-manager/preview-polling';
import { deploy as deployProject } from './project-manager/deployments';
import { createV1Session } from './project-manager/sessions/v1/v1-session';
import { createV2Session } from './project-manager/sessions/v2/v2-session';

type AppTRPCClient = TRPCClient<RootRouter>;

export type { ProjectState };

export type ProjectManagerConfig = {
  project: ProjectWithMessages;
  trpcClient: AppTRPCClient;
  organizationId: string | null;
};

export type DeployResult = DeployProjectResult;

export type ProjectManager = {
  readonly projectId: string;
  destroyed: boolean;
  subscribe: (listener: () => void) => () => void;
  getState: () => ProjectState;
  sendMessage: (message: string, images?: Images, model?: string) => void;
  interrupt: () => void;
  setCurrentIframeUrl: (url: string | null) => void;
  setGitRepoFullName: (repoFullName: string) => void;
  deploy: () => Promise<DeployResult>;
  destroy: () => void;
};

export function createProjectManager(config: ProjectManagerConfig): ProjectManager {
  const { project, trpcClient, organizationId } = config;

  const projectId = project.id;
  const logger = createLogger(projectId);
  let destroyed = false;
  let cloudAgentSessionId = project.session_id ?? null;
  let previewPollingState: PreviewPollingState | null = null;
  let pendingInitialStreamingStart = false;
  let pendingReconnect = false;
  let hasStartedInitialStreaming = false;
  let sessionUnsubscribes: Array<() => void> = [];

  const initialState = createInitialState(
    project.deployment_id ?? null,
    project.model_id ?? null,
    project.git_repo_full_name ?? null
  );
  const store: ProjectStore = createProjectStore(initialState);

  // --- Session building ---

  function createStaticSession(info: ProjectSessionInfo): AppBuilderSession {
    if (info.worker_version === 'v2') {
      return createV2Session({ info, initialMessages: [] });
    }
    return createV1Session({ info, initialMessages: [] });
  }

  function getActiveSession(): AppBuilderSession | undefined {
    const sessions = store.getState().sessions;
    return sessions[sessions.length - 1];
  }

  function subscribeToSession(session: AppBuilderSession): void {
    const unsubscribe = session.subscribe(() => {
      const active = getActiveSession();
      const isStreaming = active?.getState().isStreaming ?? false;
      store.setState({ isStreaming });
    });
    sessionUnsubscribes.push(unsubscribe);
  }

  /**
   * Builds sessions from backend project data.
   * Ended sessions are static (no streaming). The active session (last or
   * the one without ended_at) gets streaming capabilities.
   */
  function buildSessions(proj: ProjectWithMessages): AppBuilderSession[] {
    const sessionInfos = proj.sessions;
    if (sessionInfos.length === 0) return [];

    const activeInfo =
      sessionInfos.find(s => s.ended_at === null) ?? sessionInfos[sessionInfos.length - 1];

    const sessions: AppBuilderSession[] = [];

    for (const info of sessionInfos) {
      const isActive = info.id === activeInfo?.id;

      if (!isActive) {
        sessions.push(createStaticSession(info));
      } else if (info.worker_version === 'v2') {
        sessions.push(
          createV2Session({
            info,
            initialMessages: [],
            projectId,
            organizationId,
            trpcClient,
            cloudAgentSessionId: proj.session_id ?? null,
            onStreamComplete: () => startPreviewPollingIfNeeded(),
          })
        );
      } else {
        sessions.push(
          createV1Session({
            info,
            initialMessages: proj.messages,
            projectId,
            organizationId,
            trpcClient,
            cloudAgentSessionId: proj.session_id ?? null,
            sessionPrepared: proj.sessionPrepared,
            onStreamComplete: () => startPreviewPollingIfNeeded(),
            onUpgradeDetected: handleUpgradeDetected,
          })
        );
      }
    }

    return sessions;
  }

  // --- Upgrade detection ---

  function handleUpgradeDetected(newSessionId: string): void {
    logger.log('V1→V2 upgrade detected', { newSessionId });

    const currentActive = getActiveSession();
    currentActive?.destroy();

    const v2Info: ProjectSessionInfo = {
      id: newSessionId,
      cloud_agent_session_id: newSessionId,
      worker_version: 'v2',
      created_at: new Date().toISOString(),
      ended_at: null,
      reason: 'upgraded',
    };

    const v2Session = createV2Session({
      info: v2Info,
      initialMessages: [],
      projectId,
      organizationId,
      trpcClient,
      cloudAgentSessionId: newSessionId,
      onStreamComplete: () => startPreviewPollingIfNeeded(),
    });

    subscribeToSession(v2Session);

    const currentSessions = store.getState().sessions;
    store.setState({
      sessions: [...currentSessions, v2Session],
      isStreaming: true,
    });
    cloudAgentSessionId = newSessionId;

    v2Session.connectToExistingSession(newSessionId);
  }

  // --- Preview polling ---

  function startPreviewPollingIfNeeded(): void {
    if (previewPollingState?.isPolling || destroyed) return;

    logger.log('Starting preview polling');
    previewPollingState = startPreviewPolling({
      projectId,
      organizationId,
      trpcClient,
      store,
      isDestroyed: () => destroyed,
    });
  }

  // --- Initialize sessions ---

  const sessions = buildSessions(project);
  store.setState({ sessions });

  for (const session of sessions) {
    subscribeToSession(session);
  }

  if (project.sessionInitiated === false) {
    pendingInitialStreamingStart = true;
  } else if (cloudAgentSessionId) {
    pendingReconnect = true;
  } else {
    startPreviewPollingIfNeeded();
  }

  // --- Public API ---

  function subscribe(listener: () => void): () => void {
    const unsubscribe = store.subscribe(listener);

    // Deferred start: wait for React's first subscription before streaming
    if (pendingInitialStreamingStart && !hasStartedInitialStreaming) {
      hasStartedInitialStreaming = true;
      queueMicrotask(() => {
        if (!destroyed) {
          setTimeout(() => startPreviewPollingIfNeeded(), 100);
          getActiveSession()?.startInitialStreaming();
        }
      });
    } else if (pendingReconnect && cloudAgentSessionId) {
      pendingReconnect = false;
      const sessionIdForReconnect = cloudAgentSessionId;
      queueMicrotask(() => {
        if (!destroyed) {
          startPreviewPollingIfNeeded();
          getActiveSession()?.connectToExistingSession(sessionIdForReconnect);
        }
      });
    }

    return unsubscribe;
  }

  function getState(): ProjectState {
    return store.getState();
  }

  function sendMessage(message: string, images?: Images, model?: string): void {
    const activeSession = getActiveSession();
    if (!activeSession) {
      logger.logWarn('Cannot send message: no active session');
      return;
    }

    if (model) {
      store.setState({ model });
    }

    const effectiveModel = model ?? store.getState().model;
    void activeSession.sendMessage(message, images, effectiveModel);
  }

  function interrupt(): void {
    const activeSession = getActiveSession();
    if (!activeSession) return;

    void activeSession.interrupt();

    store.setState({ isStreaming: false, isInterrupting: true });

    const handleComplete = () => {
      if (!destroyed) {
        store.setState({ isInterrupting: false });
      }
    };

    if (organizationId) {
      void trpcClient.organizations.appBuilder.interruptSession
        .mutate({ projectId, organizationId })
        .catch((err: Error) => logger.logError('Failed to interrupt session', err))
        .finally(handleComplete);
    } else {
      void trpcClient.appBuilder.interruptSession
        .mutate({ projectId })
        .catch((err: Error) => logger.logError('Failed to interrupt session', err))
        .finally(handleComplete);
    }
  }

  function setCurrentIframeUrl(url: string | null): void {
    store.setState({ currentIframeUrl: url });
  }

  function setGitRepoFullName(repoFullName: string): void {
    store.setState({ gitRepoFullName: repoFullName });
  }

  async function deploy(): Promise<DeployResult> {
    if (destroyed) {
      throw new Error('Cannot deploy: ProjectManager is destroyed');
    }
    logger.log('Deploying project');
    return deployProject({ projectId, organizationId, trpcClient, store });
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;

    for (const unsub of sessionUnsubscribes) {
      unsub();
    }
    sessionUnsubscribes = [];

    for (const session of store.getState().sessions) {
      session.destroy();
    }

    if (previewPollingState) {
      previewPollingState.stop();
      previewPollingState = null;
    }
  }

  return {
    projectId,
    get destroyed() {
      return destroyed;
    },
    set destroyed(value: boolean) {
      destroyed = value;
    },
    subscribe,
    getState,
    sendMessage,
    interrupt,
    setCurrentIframeUrl,
    setGitRepoFullName,
    deploy,
    destroy,
  };
}
