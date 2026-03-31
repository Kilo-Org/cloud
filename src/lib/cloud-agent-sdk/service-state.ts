/**
 * ServiceState — manages all non-chat state: activity indicator, lifecycle
 * status, session info, questions, and autocommit tracking.
 *
 * Processes ServiceEvents from the normalizer and provides a reactive snapshot
 * of the current service state via subscribe().
 */
import type { QuestionInfo } from '@/types/opencode.gen';
import type { ServiceEvent } from './normalizer';
import type {
  SessionInfo,
  SessionActivity,
  AgentStatus,
  QuestionState,
  PermissionState,
  ServiceStateSnapshot,
  CloudStatus,
} from './types';

type ServiceStateConfig = {
  /** The root session ID we're tracking (to detect child sessions). */
  rootSessionId: string;
  onError?: (message: string) => void;
  onQuestionAsked?: (requestId: string, questions?: QuestionInfo[]) => void;
  onQuestionResolved?: (requestId: string) => void;
  onPermissionAsked?: (
    requestId: string,
    permission?: string,
    patterns?: string[],
    metadata?: Record<string, unknown>,
    always?: string[]
  ) => void;
  onPermissionResolved?: (requestId: string) => void;
  onBranchChanged?: (branch: string) => void;
  onSessionCreated?: (info: SessionInfo) => void;
  onSessionUpdated?: (info: SessionInfo) => void;
  /** Fired when async preparation completes (preparing step === 'ready'). */
  onPreparationReady?: () => void;
  /** Fired when async preparation fails (preparing step === 'failed'). */
  onPreparationFailed?: (message: string) => void;
};

type ServiceState = {
  process(event: ServiceEvent): void;
  getActivity(): SessionActivity;
  getStatus(): AgentStatus;
  getCloudStatus(): CloudStatus | null;
  getQuestion(): QuestionState | null;
  getPermission(): PermissionState | null;
  getSessionInfo(): SessionInfo | null;
  snapshot(): ServiceStateSnapshot;
  /** Set activity directly (for transport lifecycle events like connecting/disconnected). */
  setActivity(activity: SessionActivity): void;
  /** Set status directly (for transport lifecycle events like disconnected). */
  setStatus(status: AgentStatus): void;
  /** Set cloud infrastructure status directly. */
  setCloudStatus(cloudStatus: CloudStatus | null): void;
  subscribe(callback: () => void): () => void;
  reset(): void;
};

const INITIAL_ACTIVITY: SessionActivity = { type: 'connecting' };
const IDLE_STATUS: AgentStatus = { type: 'idle' };

function createServiceState(config: ServiceStateConfig): ServiceState {
  let activity: SessionActivity = INITIAL_ACTIVITY;
  let status: AgentStatus = IDLE_STATUS;
  let cloudStatus: CloudStatus | null = null;
  let sessionInfo: SessionInfo | null = null;
  let question: QuestionState | null = null;
  let permission: PermissionState | null = null;

  // Tracks whether we've received a terminal stopped event (error/interrupted/disconnected).
  // While terminated, session.error events are suppressed as aftershocks.
  let terminated = false;

  const subscribers = new Set<() => void>();

  function notify(): void {
    for (const cb of subscribers) {
      cb();
    }
  }

  function isRootSession(sessionId: string): boolean {
    return sessionId === config.rootSessionId;
  }

  function processSessionStatus(event: Extract<ServiceEvent, { type: 'session.status' }>): void {
    const { sessionId, status: sessionStatus } = event;

    if (sessionStatus.type === 'busy') {
      if (isRootSession(sessionId)) {
        activity = { type: 'busy' };
        status = IDLE_STATUS;
        terminated = false;
      }
      // Child session busy → no activity change
    } else if (sessionStatus.type === 'retry') {
      activity = {
        type: 'retrying',
        attempt: sessionStatus.attempt,
        message: sessionStatus.message,
      };
    } else if (sessionStatus.type === 'idle') {
      if (isRootSession(sessionId) && activity.type !== 'idle') {
        activity = { type: 'idle' };
      }
    }

    notify();
  }

  function processStopped(event: Extract<ServiceEvent, { type: 'stopped' }>): void {
    activity = { type: 'idle' };
    cloudStatus = null;

    switch (event.reason) {
      case 'complete':
        // Status stays as-is (idle, or committed if was committing)
        if (event.branch) config.onBranchChanged?.(event.branch);
        break;
      case 'interrupted':
        terminated = true;
        status = { type: 'interrupted' };
        break;
      case 'error':
        terminated = true;
        status = { type: 'error', message: 'Session terminated' };
        config.onError?.('Session terminated');
        break;
      case 'disconnected':
        terminated = true;
        status = { type: 'disconnected' };
        config.onError?.('Connection to agent lost');
        break;
    }

    notify();
  }

  function processSessionError(event: Extract<ServiceEvent, { type: 'session.error' }>): void {
    if (terminated) return;

    config.onError?.(event.error);
    status = { type: 'error', message: event.error };

    notify();
  }

  function processSessionCreated(event: Extract<ServiceEvent, { type: 'session.created' }>): void {
    // Only track root session info
    if (isRootSession(event.info.id)) {
      sessionInfo = event.info;
    }
    config.onSessionCreated?.(event.info);
    notify();
  }

  function processSessionUpdated(event: Extract<ServiceEvent, { type: 'session.updated' }>): void {
    if (isRootSession(event.info.id)) {
      sessionInfo = event.info;
    }
    config.onSessionUpdated?.(event.info);
    notify();
  }

  function processQuestionAsked(event: Extract<ServiceEvent, { type: 'question.asked' }>): void {
    question = {
      requestId: event.requestId,
      questions: event.questions,
    };
    config.onQuestionAsked?.(event.requestId, event.questions);
    notify();
  }

  function processQuestionResolved(requestId: string): void {
    question = null;
    config.onQuestionResolved?.(requestId);
    notify();
  }

  function processPermissionAsked(
    requestId: string,
    permissionType: string,
    patterns: string[],
    metadata: Record<string, unknown>,
    always: string[]
  ): void {
    permission = { requestId, permission: permissionType, patterns, metadata, always };
    config.onPermissionAsked?.(requestId, permissionType, patterns, metadata, always);
    notify();
  }

  function processPermissionResolved(requestId: string): void {
    permission = null;
    config.onPermissionResolved?.(requestId);
    notify();
  }

  function processPreparing(event: Extract<ServiceEvent, { type: 'preparing' }>): void {
    if (event.step === 'ready') {
      cloudStatus = { type: 'ready' };
      if (event.branch) config.onBranchChanged?.(event.branch);
      config.onPreparationReady?.();
    } else if (event.step === 'failed') {
      cloudStatus = { type: 'error', message: event.message };
      config.onError?.(event.message);
      config.onPreparationFailed?.(event.message);
    } else {
      cloudStatus = { type: 'preparing', step: event.step, message: event.message };
    }
    notify();
  }

  function processAutocommitStarted(
    event: Extract<ServiceEvent, { type: 'autocommit_started' }>
  ): void {
    status = { type: 'autocommit', step: 'started', message: event.message ?? 'Committing…' };
    notify();
  }

  function processAutocommitCompleted(
    event: Extract<ServiceEvent, { type: 'autocommit_completed' }>
  ): void {
    if (event.skipped) return;

    if (event.success) {
      const parts = [event.commitHash, event.commitMessage].filter(Boolean);
      const message = parts.length > 0 ? parts.join(' ') : 'Committed';
      status = { type: 'autocommit', step: 'completed', message };
    } else {
      status = { type: 'autocommit', step: 'failed', message: event.message ?? 'Commit failed' };
    }
    notify();
  }

  function processCloudStatus(event: Extract<ServiceEvent, { type: 'cloud.status' }>): void {
    cloudStatus = event.cloudStatus;
    notify();
  }

  function processConnected(event: Extract<ServiceEvent, { type: 'connected' }>): void {
    // Set activity from sessionStatus. When sessionStatus is absent (server
    // has no execution-derived state yet), default to idle — we know the
    // transport connected, so we're at least no longer in the 'connecting' phase.
    const sessionStatus = event.sessionStatus;
    if (sessionStatus === undefined) {
      // Only default to idle on initial connect (activity === 'connecting').
      // On reconnect, preserve existing activity — the server will send a
      // separate session.status event with the authoritative state.
      if (activity.type === 'connecting') {
        activity = { type: 'idle' };
      }
    } else if (sessionStatus.type === 'busy') {
      activity = { type: 'busy' };
    } else if (sessionStatus.type === 'idle') {
      activity = { type: 'idle' };
    } else if (sessionStatus.type === 'retry') {
      activity = {
        type: 'retrying',
        attempt: sessionStatus.attempt,
        message: sessionStatus.message,
      };
    }

    // Set cloudStatus (undefined means not provided — leave as null)
    cloudStatus = event.cloudStatus ?? null;

    // Clear question/permission — if still pending on the server the wrapper
    // replays them as separate question.asked / permission.asked events
    // immediately after the snapshot, so they'll be re-set.
    // Fire resolve callbacks first so consumers (e.g. dock atoms) also clear.
    if (question) {
      const { requestId } = question;
      question = null;
      config.onQuestionResolved?.(requestId);
    } else {
      question = null;
    }
    if (permission) {
      const { requestId } = permission;
      permission = null;
      config.onPermissionResolved?.(requestId);
    } else {
      permission = null;
    }

    // Clear terminated on connected
    terminated = false;

    notify();
  }

  function process(event: ServiceEvent): void {
    switch (event.type) {
      case 'session.status':
        processSessionStatus(event);
        break;
      case 'stopped':
        processStopped(event);
        break;
      case 'session.error':
        processSessionError(event);
        break;
      case 'session.created':
        processSessionCreated(event);
        break;
      case 'session.updated':
        processSessionUpdated(event);
        break;
      case 'question.asked':
        processQuestionAsked(event);
        break;
      case 'question.replied':
        processQuestionResolved(event.requestId);
        break;
      case 'question.rejected':
        processQuestionResolved(event.requestId);
        break;
      case 'permission.asked':
        processPermissionAsked(
          event.requestId,
          event.permission,
          event.patterns,
          event.metadata,
          event.always
        );
        break;
      case 'permission.replied':
        processPermissionResolved(event.requestId);
        break;
      case 'preparing':
        processPreparing(event);
        break;
      case 'autocommit_started':
        processAutocommitStarted(event);
        break;
      case 'autocommit_completed':
        processAutocommitCompleted(event);
        break;
      case 'cloud.status':
        processCloudStatus(event);
        break;
      case 'connected':
        processConnected(event);
        break;
      case 'session.idle':
      case 'session.turn.close':
      case 'warning':
        // No-op events
        break;
    }
  }

  return {
    process,

    getActivity: () => activity,
    getStatus: () => status,
    getCloudStatus: () => cloudStatus,
    getQuestion: () => question,
    getPermission: () => permission,
    getSessionInfo: () => sessionInfo,

    snapshot: () => ({
      activity,
      status,
      cloudStatus,
      sessionInfo,
      question,
      permission,
    }),

    setActivity(next: SessionActivity): void {
      activity = next;
      notify();
    },

    setStatus(next: AgentStatus): void {
      status = next;
      notify();
    },

    setCloudStatus(next: CloudStatus | null): void {
      cloudStatus = next;
      notify();
    },

    subscribe(callback: () => void): () => void {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
      };
    },

    reset(): void {
      activity = INITIAL_ACTIVITY;
      status = IDLE_STATUS;
      cloudStatus = null;
      sessionInfo = null;
      question = null;
      permission = null;
      terminated = false;
      notify();
    },
  };
}

export { createServiceState };
export type { ServiceState, ServiceStateConfig };
