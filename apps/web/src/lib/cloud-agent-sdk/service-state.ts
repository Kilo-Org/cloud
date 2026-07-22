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
  SuggestionAction,
  SuggestionState,
  CloudStatus,
  MessageDeliveryState,
  PreparationAttempt,
  PreparationStepSnapshot,
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
  /** Fired when a `suggest` tool asks the user to pick an action. */
  onSuggestionAsked?: (
    requestId: string,
    text: string,
    actions: SuggestionAction[],
    callId?: string
  ) => void;
  /** Fired when a suggestion is resolved (accepted or dismissed). */
  onSuggestionResolved?: (requestId: string) => void;
  onBranchChanged?: (branch: string) => void;
  onSessionCreated?: (info: SessionInfo) => void;
  onSessionUpdated?: (info: SessionInfo) => void;
  /** Fired when async preparation completes (preparing step === 'ready'). */
  onPreparationReady?: () => void;
  /** Fired when async preparation fails (preparing step === 'failed'). */
  onPreparationFailed?: (message: string) => void;
  /** Fired when the server acknowledges a user message was queued. */
  onMessageQueued?: (messageId: string) => void;
  /** Fired when a queued user message's execution terminates in 'completed'. */
  onMessageCompleted?: (messageId: string) => void;
  /** Fired when a queued user message fails delivery or its execution fails. */
  onMessageFailed?: (
    messageId: string,
    state: Extract<MessageDeliveryState, { status: 'failed' }>
  ) => void;
};

type ServiceState = {
  process(event: ServiceEvent): void;
  getActivity(): SessionActivity;
  getStatus(): AgentStatus;
  getCloudStatus(): CloudStatus | null;
  /** @deprecated Legacy transient setup output. */
  getSetupLog(): readonly string[];
  getPreparationAttempts(): readonly PreparationAttempt[];
  getQuestion(): QuestionState | null;
  getPermission(): PermissionState | null;
  getSuggestion(): SuggestionState | null;
  getSessionInfo(): SessionInfo | null;
  getPendingMessages(): ReadonlyMap<string, MessageDeliveryState>;
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
  let setupLog: string[] = [];
  let preparationAttempts: PreparationAttempt[] = [];
  let sessionInfo: SessionInfo | null = null;
  let question: QuestionState | null = null;
  let permission: PermissionState | null = null;
  let suggestion: SuggestionState | null = null;
  const pendingMessages = new Map<string, MessageDeliveryState>();
  let disconnectedSource: 'transport' | 'wrapper' | null = null;
  let completed = false;

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

    if (isRootSession(sessionId) && status.type === 'disconnected') {
      status = IDLE_STATUS;
      disconnectedSource = null;
      terminated = false;
    }

    if (sessionStatus.type === 'busy') {
      if (isRootSession(sessionId)) {
        activity = { type: 'busy' };
        status = IDLE_STATUS;
        disconnectedSource = null;
        completed = false;
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
    setupLog = [];

    switch (event.reason) {
      case 'complete':
        completed = true;
        // Status stays as-is (idle, or committed if was committing)
        if (event.branch) config.onBranchChanged?.(event.branch);
        break;
      case 'interrupted':
        terminated = true;
        disconnectedSource = null;
        completed = false;
        status = { type: 'interrupted' };
        break;
      case 'error':
        terminated = true;
        disconnectedSource = null;
        completed = false;
        status = { type: 'error', message: 'Session terminated' };
        config.onError?.('Session terminated');
        break;
      case 'disconnected':
        // Clear CLI pending-message state unconditionally — including when the
        // last turn had `completed === true`. Only `cli-live-transport.ts`
        // emits this reason (via `wrapper_disconnected`); the clear is scoped
        // to it, not `transport-disconnected` (see below).
        pendingMessages.clear();
        if (completed) break;
        terminated = true;
        disconnectedSource = 'wrapper';
        status = { type: 'disconnected' };
        config.onError?.('Connection to agent lost');
        break;
      case 'transport-disconnected':
        // Do NOT clear `pendingMessages` here. Only `cloud-agent-transport.ts`
        // emits this reason, synthesized locally on any WebSocket hiccup
        // (frequent, purely client-side, self-recovering via reconnect) —
        // it never fires for CLI sessions. Cloud-agent sessions genuinely
        // populate `pendingMessages` via `cloud.message.queued`, and there is
        // no snapshot-replay mechanism that would repopulate it afterward
        // (unlike the CLI's always-on `session.queue.changed` replay), so
        // clearing here would silently and permanently drop "Queued" badges
        // for messages that are still queued server-side.
        terminated = true;
        disconnectedSource = 'transport';
        completed = false;
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

  function processSuggestionShown(
    event: Extract<ServiceEvent, { type: 'suggestion.shown' }>
  ): void {
    suggestion = {
      requestId: event.requestId,
      text: event.text,
      actions: event.actions,
      callId: event.callId,
    };
    config.onSuggestionAsked?.(event.requestId, event.text, event.actions, event.callId);
    notify();
  }

  function processSuggestionResolved(requestId: string): void {
    // Clear only when the resolution matches the currently-pending suggestion.
    // The CLI emits both a command `response` and a `suggestion.accepted` /
    // `suggestion.dismissed` bus event; whichever arrives first clears state,
    // and the second is fully a no-op (no callback, no notify).
    if (!suggestion || suggestion.requestId !== requestId) return;
    suggestion = null;
    config.onSuggestionResolved?.(requestId);
    notify();
  }

  function processPreparing(event: Extract<ServiceEvent, { type: 'preparing' }>): void {
    if (event.version === 2 && event.attemptId && event.triggerMessageId && event.action) {
      const attempt = processPreparationEvent(event);
      // Only an event that actually advanced the attempt may move cloudStatus.
      // Stale duplicates and replayed snapshots of a finished attempt would
      // otherwise flip a ready session back to 'preparing' and permanently
      // disable the chat input.
      if (attempt) {
        cloudStatus =
          attempt.status === 'completed'
            ? { type: 'ready' }
            : attempt.status === 'failed'
              ? { type: 'error', message: attempt.safeError ?? event.message }
              : { type: 'preparing', step: event.step, message: event.message };
      }
      notify();
      return;
    }
    if (event.step === 'ready') {
      cloudStatus = { type: 'ready' };
      setupLog = [];
      if (event.branch) config.onBranchChanged?.(event.branch);
      config.onPreparationReady?.();
    } else if (event.step === 'failed') {
      cloudStatus = { type: 'error', message: event.message };
      setupLog = [];
      config.onError?.(event.message);
      config.onPreparationFailed?.(event.message);
    } else {
      cloudStatus = { type: 'preparing', step: event.step, message: event.message };
      if (event.step === 'setup_commands' && event.message) {
        setupLog = [...setupLog, event.message];
      }
    }
    notify();
  }

  /**
   * Apply one v2 preparation event to the attempts list. Returns the attempt
   * in its post-event state when the event advanced it, or null when the
   * event was stale or unusable and nothing changed.
   */
  function processPreparationEvent(
    event: Extract<ServiceEvent, { type: 'preparing' }>
  ): PreparationAttempt | null {
    if (
      event.version !== 2 ||
      !event.attemptId ||
      !event.triggerMessageId ||
      event.revision === undefined ||
      event.timestamp === undefined ||
      !event.action
    ) {
      return null;
    }
    const eventTimestamp = event.timestamp;
    const eventRevision = event.revision;
    const existing = preparationAttempts.find(attempt => attempt.id === event.attemptId);
    // Steps come from two independent emitters (the server before the wrapper
    // boots, the wrapper after), and each only completes its own previous
    // step. When the attempt changes hands (a running attempt re-announced)
    // or reaches a terminal state, settle any step still marked running —
    // its emitter is gone and no completion will ever arrive.
    const settleRunningSteps = (
      steps: readonly PreparationStepSnapshot[],
      status: 'completed' | 'failed',
      safeError?: string
    ): PreparationStepSnapshot[] =>
      steps.map(step =>
        step.status === 'running'
          ? {
              ...step,
              status,
              completedAt: eventTimestamp,
              ...(status === 'failed' && safeError !== undefined ? { safeError } : {}),
              revision: eventRevision,
            }
          : step
      );
    if (event.action === 'attempt_started') {
      if (existing && existing.revision >= event.revision) return null;
      const handedOff = existing?.status === 'running' ? existing : undefined;
      const attempt: PreparationAttempt = {
        id: event.attemptId,
        triggerMessageId: event.triggerMessageId,
        status: 'running',
        // The wrapper re-announces the attempt the server already started;
        // keep the original start so the duration spans the whole preparation.
        startedAt: handedOff ? handedOff.startedAt : event.timestamp,
        revision: event.revision,
        steps: handedOff
          ? settleRunningSteps(handedOff.steps, 'completed')
          : (existing?.steps ?? []),
      };
      preparationAttempts = [
        ...preparationAttempts.filter(item => item.id !== attempt.id),
        attempt,
      ].sort((a, b) => a.startedAt - b.startedAt);
      return attempt;
    }
    if (event.action === 'attempt_snapshot' && event.attempt) {
      if (existing && existing.revision > event.attempt.revision) return null;
      const snapshot = event.attempt;
      const attempt: PreparationAttempt = {
        id: snapshot.id,
        triggerMessageId: snapshot.triggerMessageId,
        status: snapshot.status,
        startedAt: snapshot.startedAt,
        ...(snapshot.completedAt === undefined ? {} : { completedAt: snapshot.completedAt }),
        ...(snapshot.safeError === undefined ? {} : { safeError: snapshot.safeError }),
        revision: snapshot.revision,
        steps: existing?.steps ?? [],
      };
      preparationAttempts = [
        ...preparationAttempts.filter(item => item.id !== attempt.id),
        attempt,
      ].sort((a, b) => a.startedAt - b.startedAt);
      return attempt;
    }
    if (!existing) return null;
    if (event.action === 'attempt_completed' || event.action === 'attempt_failed') {
      if (existing.revision >= event.revision || existing.status !== 'running') return null;
      const status = event.action === 'attempt_completed' ? 'completed' : 'failed';
      const attempt: PreparationAttempt = {
        ...existing,
        status,
        completedAt: event.timestamp,
        ...(event.safeError === undefined ? {} : { safeError: event.safeError }),
        revision: event.revision,
        steps: settleRunningSteps(existing.steps, status, event.safeError),
      };
      preparationAttempts = preparationAttempts.map(item =>
        item.id === existing.id ? attempt : item
      );
      return attempt;
    }
    if (!event.stepId) return null;
    const existingStep = existing.steps.find(step => step.id === event.stepId);
    let nextStep: PreparationStepSnapshot | undefined;
    if (event.action === 'step_snapshot' && event.stepSnapshot) {
      if (existingStep && existingStep.revision > event.stepSnapshot.revision) return null;
      nextStep = event.stepSnapshot;
    } else if (event.action === 'step_started' && event.kind && event.label) {
      if (existingStep && existingStep.revision >= event.revision) return null;
      nextStep = {
        id: event.stepId,
        key: event.step,
        kind: event.kind,
        label: event.label,
        status: 'running',
        startedAt: event.timestamp,
        revision: event.revision,
        ...(event.command === undefined ? {} : { command: event.command }),
        ...(event.commandIndex === undefined ? {} : { commandIndex: event.commandIndex }),
        ...(event.commandCount === undefined ? {} : { commandCount: event.commandCount }),
      };
    } else if (
      existingStep &&
      existingStep.revision < event.revision &&
      existingStep.status === 'running'
    ) {
      if (event.action === 'step_progress' && event.detail !== undefined) {
        nextStep = { ...existingStep, latestDetail: event.detail, revision: event.revision };
      } else if (event.action === 'step_output' && event.output !== undefined) {
        nextStep = {
          ...existingStep,
          outputTail: `${existingStep.outputTail ?? ''}${event.output}`,
          revision: event.revision,
        };
      } else if (event.action === 'step_completed') {
        nextStep = {
          ...existingStep,
          status: 'completed',
          completedAt: event.timestamp,
          ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
          revision: event.revision,
        };
      } else if (event.action === 'step_failed' && event.safeError !== undefined) {
        nextStep = {
          ...existingStep,
          status: 'failed',
          completedAt: event.timestamp,
          safeError: event.safeError,
          ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
          revision: event.revision,
        };
      }
    }
    if (!nextStep) return null;
    const step = nextStep;
    const attempt: PreparationAttempt = {
      ...existing,
      revision: Math.max(existing.revision, step.revision),
      steps: [...existing.steps.filter(item => item.id !== step.id), step].sort(
        (a, b) => a.startedAt - b.startedAt
      ),
    };
    preparationAttempts = preparationAttempts.map(item =>
      item.id === existing.id ? attempt : item
    );
    return attempt;
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

  function processMessageQueued(
    event: Extract<ServiceEvent, { type: 'cloud.message.queued' }>
  ): void {
    pendingMessages.set(event.messageId, { status: 'queued' });
    config.onMessageQueued?.(event.messageId);
    notify();
  }

  function processMessageSent(event: Extract<ServiceEvent, { type: 'cloud.message.sent' }>): void {
    pendingMessages.delete(event.messageId);
    notify();
  }

  function processMessageCompleted(
    event: Extract<ServiceEvent, { type: 'cloud.message.completed' }>
  ): void {
    pendingMessages.delete(event.messageId);
    config.onMessageCompleted?.(event.messageId);
    notify();
  }

  function processMessageFailed(
    event: Extract<ServiceEvent, { type: 'cloud.message.failed' }>
  ): void {
    const deliveryState: Extract<MessageDeliveryState, { status: 'failed' }> = {
      status: 'failed',
      error: event.error,
      reason: event.reason,
      attempts: event.attempts,
    };
    pendingMessages.delete(event.messageId);
    if (event.reason === 'interrupted') {
      activity = { type: 'idle' };
      status = { type: 'interrupted' };
      terminated = true;
      disconnectedSource = null;
      completed = false;
    }
    config.onMessageFailed?.(event.messageId, deliveryState);
    notify();
  }

  /**
   * CLI-only: `queue.changed` carries the authoritative FIFO snapshot of
   * queued user-message IDs. Each emission is a full reconciliation, not a
   * delta — entries absent from the new snapshot are dropped.
   *
   * `pendingMessages` is a single map shared by the whole session tree, but
   * child/subagent sessions also forward their own `session.queue.changed`
   * events here (see `cli-live-transport.ts`'s parent-session forwarding and
   * `remote-sender.ts`'s always-empty replay for children). Only the root
   * session's snapshot may reconcile this map — otherwise an empty child
   * snapshot on reconnect would wipe a genuinely queued root message.
   */
  function processQueueChanged(event: Extract<ServiceEvent, { type: 'queue.changed' }>): void {
    if (!isRootSession(event.sessionId)) return;
    if (event.queued.length === 0) {
      if (pendingMessages.size === 0) return;
      pendingMessages.clear();
      notify();
      return;
    }
    const next = new Map<string, MessageDeliveryState>();
    for (const messageId of event.queued) {
      next.set(messageId, { status: 'queued' });
    }
    // Reuse the same Map identity where possible to avoid invalidating
    // existing subscribers that hold onto the previous reference.
    pendingMessages.clear();
    for (const [messageId, state] of next) {
      pendingMessages.set(messageId, state);
    }
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
    if (suggestion) {
      const { requestId } = suggestion;
      suggestion = null;
      config.onSuggestionResolved?.(requestId);
    } else {
      suggestion = null;
    }

    // Clear terminated on connected
    terminated = false;
    if (
      status.type === 'disconnected' &&
      (sessionStatus !== undefined || disconnectedSource === 'transport')
    ) {
      status = IDLE_STATUS;
      disconnectedSource = null;
    }

    // Clear pending-message delivery state — replayed cloud.message.queued
    // events following the snapshot will repopulate it with the current truth.
    pendingMessages.clear();

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
      case 'suggestion.shown':
        processSuggestionShown(event);
        break;
      case 'suggestion.accepted':
      case 'suggestion.dismissed':
        processSuggestionResolved(event.requestId);
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
      case 'cloud.message.queued':
        processMessageQueued(event);
        break;
      case 'cloud.message.sent':
        processMessageSent(event);
        break;
      case 'cloud.message.completed':
        processMessageCompleted(event);
        break;
      case 'cloud.message.failed':
        processMessageFailed(event);
        break;
      case 'queue.changed':
        processQueueChanged(event);
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
    getSetupLog: () => setupLog,
    getPreparationAttempts: () => preparationAttempts,
    getQuestion: () => question,
    getPermission: () => permission,
    getSuggestion: () => suggestion,
    getSessionInfo: () => sessionInfo,
    getPendingMessages: () => pendingMessages,

    snapshot: () => ({
      activity,
      status,
      cloudStatus,
      setupLog,
      preparationAttempts,
      sessionInfo,
      question,
      permission,
      suggestion,
      pendingMessages,
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
      setupLog = [];
      preparationAttempts = [];
      sessionInfo = null;
      question = null;
      permission = null;
      suggestion = null;
      pendingMessages.clear();
      terminated = false;
      disconnectedSource = null;
      completed = false;
      notify();
    },
  };
}

export { createServiceState };
export type { ServiceState, ServiceStateConfig };
