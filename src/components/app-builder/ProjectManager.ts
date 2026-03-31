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
  SessionDisplayInfo,
  WorkerVersion,
} from '@/lib/app-builder/types';
import type { Images } from '@/lib/images-schema';
import type { TRPCClient } from '@trpc/client';
import type { RootRouter } from '@/routers/root-router';
import type { CloudMessage } from '@/components/cloud-agent/types';
import type { StoredMessage } from '@/components/cloud-agent-next/types';
import type { UserMessage, TextPart } from '@/types/opencode.gen';
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
  /** Enter "pending new session" mode — clears the chat area for a new message */
  requestNewSession: () => void;
  /** Cancel pending new session mode, returning to the current session view */
  cancelNewSession: () => void;
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

  function toDisplayInfo(info: ProjectSessionInfo): SessionDisplayInfo {
    return {
      id: info.id,
      cloud_agent_session_id: info.cloud_agent_session_id,
      ended_at: info.ended_at,
      title: info.title,
    };
  }

  function createStaticSession(info: ProjectSessionInfo): AppBuilderSession {
    // Pass streaming config so ended sessions can load messages via WebSocket replay
    const streamingConfig = {
      info: toDisplayInfo(info),
      initialMessages: [] as never[],
      projectId,
      organizationId,
      trpcClient,
    };
    if (info.worker_version === 'v2') {
      return createV2Session(streamingConfig);
    }
    return createV1Session({ ...streamingConfig, sessionPrepared: true });
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
            info: toDisplayInfo(info),
            initialMessages: [],
            projectId,
            organizationId,
            trpcClient,
            onStreamComplete: () => startPreviewPollingIfNeeded(),
            onSessionChanged: handleSessionChanged,
          })
        );
      } else {
        sessions.push(
          createV1Session({
            info: toDisplayInfo(info),
            initialMessages: proj.messages,
            projectId,
            organizationId,
            trpcClient,
            sessionPrepared: info.prepared,
            onStreamComplete: () => startPreviewPollingIfNeeded(),
            onSessionChanged: handleSessionChanged,
          })
        );
      }
    }

    return sessions;
  }

  // --- Session change detection (upgrade or GitHub migration) ---

  function handleSessionChanged(
    newSessionId: string,
    workerVersion: WorkerVersion,
    userMessage: { text: string; images?: Images }
  ): void {
    logger.log('Session changed', { newSessionId, workerVersion });

    const currentActive = getActiveSession();
    if (currentActive) {
      currentActive.info.ended_at = new Date().toISOString();
      currentActive.destroy();
    }

    const newInfo: SessionDisplayInfo = {
      id: newSessionId,
      cloud_agent_session_id: newSessionId,
      ended_at: null,
      title: null,
    };

    const newSession =
      workerVersion === 'v2'
        ? createV2Session({
            info: newInfo,
            initialMessages: [makeOptimisticV2UserMessage(newSessionId, userMessage.text)],
            projectId,
            organizationId,
            trpcClient,
            onStreamComplete: () => startPreviewPollingIfNeeded(),
            onSessionChanged: handleSessionChanged,
          })
        : createV1Session({
            info: newInfo,
            initialMessages: [makeOptimisticV1UserMessage(userMessage.text, userMessage.images)],
            projectId,
            organizationId,
            trpcClient,
            sessionPrepared: true,
            onStreamComplete: () => startPreviewPollingIfNeeded(),
            onSessionChanged: handleSessionChanged,
          });

    subscribeToSession(newSession);

    const currentSessions = store.getState().sessions;
    store.setState({
      sessions: [...currentSessions, newSession],
      isStreaming: true,
    });
    cloudAgentSessionId = newSessionId;

    newSession.connectToExistingSession(newSessionId);
  }

  function makeOptimisticV1UserMessage(text: string, images?: Images): CloudMessage {
    return {
      ts: Date.now(),
      type: 'user',
      text,
      partial: false,
      images,
    };
  }

  function makeOptimisticV2UserMessage(sessionId: string, text: string): StoredMessage {
    const messageId = `optimistic-${Date.now()}`;
    const now = Date.now();
    const info: UserMessage = {
      id: messageId,
      sessionID: sessionId,
      role: 'user',
      time: { created: now },
      agent: '',
      model: { providerID: '', modelID: '' },
    };
    const textPart: TextPart = {
      id: `${messageId}-text`,
      sessionID: sessionId,
      messageID: messageId,
      type: 'text',
      text,
    };
    return { info, parts: [textPart] };
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

  // Determine if the active session needs initial streaming from the backend session info.
  // `initiated` lives on ProjectSessionInfo (routing data), not on SessionDisplayInfo.
  const activeProjectSessionInfo =
    project.sessions.find(s => s.ended_at === null) ??
    project.sessions[project.sessions.length - 1];

  if (activeProjectSessionInfo?.initiated === false) {
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
    if (store.getState().pendingNewSession) {
      sendMessageAsNewSession(message, images, model);
      return;
    }

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

  /**
   * Sends the first message of a user-initiated new session.
   * Calls sendMessage tRPC mutation with forceNewSession:true, then delegates
   * to handleSessionChanged to create the new session object and begin streaming.
   */
  function sendMessageAsNewSession(message: string, images?: Images, model?: string): void {
    if (destroyed) {
      logger.logWarn('Cannot start new session: ProjectManager is destroyed');
      return;
    }

    if (model) {
      store.setState({ model });
    }

    const effectiveModel = model ?? store.getState().model;

    store.setState({ pendingNewSession: false, isStreaming: true });

    const mutationPromise = organizationId
      ? trpcClient.organizations.appBuilder.sendMessage.mutate({
          projectId,
          organizationId,
          message,
          images,
          model: effectiveModel,
          forceNewSession: true,
        })
      : trpcClient.appBuilder.sendMessage.mutate({
          projectId,
          message,
          images,
          model: effectiveModel,
          forceNewSession: true,
        });

    void mutationPromise
      .then(result => {
        if (destroyed) return;
        handleSessionChanged(result.cloudAgentSessionId, result.workerVersion, {
          text: message,
          images,
        });
      })
      .catch((err: Error) => {
        if (destroyed) return;
        logger.logError('Failed to start new session', err);
        store.setState({ isStreaming: false });
      });
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

  function requestNewSession(): void {
    if (destroyed) return;
    const currentActive = getActiveSession();
    if (currentActive) {
      currentActive.info.ended_at = new Date().toISOString();
    }
    store.setState({ pendingNewSession: true });
  }

  function cancelNewSession(): void {
    if (destroyed) return;
    const currentActive = getActiveSession();
    if (currentActive) {
      currentActive.info.ended_at = null;
    }
    store.setState({ pendingNewSession: false });
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
    requestNewSession,
    cancelNewSession,
  };
}
