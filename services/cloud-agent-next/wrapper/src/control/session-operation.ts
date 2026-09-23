import { isDeepStrictEqual } from 'node:util';
import { classifyAssistantFailure } from '../../../src/shared/assistant-failure.js';
import {
  diagnosticDetail,
  emitControlDiagnostic,
  OWNED_PROCESS_CLEANUP_UNREAPED,
  type ControlDiagnosticReporter,
} from '../../../src/shared/control-diagnostics.js';
import {
  SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
  SANDBOX_CONTROL_CLEANUP_TIMEOUT_MS,
  SANDBOX_CONTROL_EXECUTION_TIMEOUT_MS,
  SANDBOX_CONTROL_OUTCOME_TIMEOUT_MS,
  sessionOperationExpiresAt,
  sameSessionOperation,
  sessionMessageOutcomeSchema,
  sessionEventPayloadSchema,
  sessionOperationDeliverySchema,
  type SessionOperationAuthorization,
  type SessionOperationDelivery,
  type SessionOperationAck,
  type SessionAttachPayload,
  type SessionEventPayload,
  type SessionMessageOutcome,
  type SessionPromptPayload,
  type SessionRequestIdentity,
} from '../../../src/shared/sandbox-control-protocol.js';
import type { IngestEvent } from '../../../src/shared/protocol.js';
import { isKiloServerUnreachableError, type WrapperKiloClient } from '../kilo-api.js';
import { STABLE_ROOT_IDLE_MS } from '../lifecycle.js';
import { materializeMessageAttachments } from '../session-bootstrap.js';
import { runAutoCommit, type AutoCommitResult } from '../auto-commit.js';
import { withTimeoutAndAbort } from '../utils.js';
import type { ApplyAttachDeps, AttachPreparingEmitter } from './apply-attach.js';
import { createOwnedProcessScope, type OwnedProcessScope } from './owned-processes.js';
import type { WorktreeKiloRuntime } from './worktree-runtime.js';
import {
  SessionOperationCleanup,
  type NativeCleanupEvidence,
  type NativeOperationTarget,
  type NativeRetirement,
  type RootScopedCleanupResult,
} from './session-operation-cleanup.js';
import { operationIntent } from './operation-intent.js';
import {
  createOperationResultDelivery,
  type OperationResultDelivery,
  type OperationResultSender,
} from './operation-result-delivery.js';
import {
  createRetainedOperationNotifications,
  isRetainedOperationPreparing,
} from './retained-operation-notifications.js';

import type { ControlHandlerResult } from './control-handler-result.js';
export type { ControlHandlerResult } from './control-handler-result.js';

type NativeCompletion = Awaited<ReturnType<WrapperKiloClient['sendPrompt']>>;
type NativeResult = {
  state: 'not_started' | 'pending' | 'completed' | 'unknown';
  completion?: NativeCompletion['info'];
  result?: boolean;
  error?: unknown;
};
type Finalization = {
  autoCommit?:
    | { state: 'running' }
    | { state: 'completed'; result: AutoCommitResult }
    | { state: 'unknown'; error: unknown };
  condensation?: {
    state: 'running' | 'completed' | 'unknown';
    result?: boolean;
    error?: unknown;
  };
};

export type SessionOperationWork =
  | {
      operation: 'session.attach';
      payload: SessionAttachPayload;
      apply: (
        session: SessionRequestIdentity,
        payload: SessionAttachPayload,
        hooks: Pick<
          ApplyAttachDeps,
          | 'signal'
          | 'assertCurrent'
          | 'onMutation'
          | 'onRuntime'
          | 'onError'
          | 'onCleanupTarget'
          | 'emitPreparing'
        >
      ) => Promise<ControlHandlerResult>;
      onAttached: () => void;
      emitPreparing?: AttachPreparingEmitter;
    }
  | {
      operation: 'session.prompt';
      payload: SessionPromptPayload;
      runtime: WorktreeKiloRuntime;
      materializeAttachments?: typeof materializeMessageAttachments;
      runAutoCommit?: typeof runAutoCommit;
    };

export type SessionOperationDependencies = {
  signal?: AbortSignal;
  isCurrent: () => boolean;
  getRuntime: () => WorktreeKiloRuntime | undefined;
  prepareForNewWork?: () => boolean;
  verifyQuiescence: (target: NativeOperationTarget, deadlineAt: number) => Promise<boolean>;
  retireRuntime: (reason: string, deadlineAt: number, target?: NativeOperationTarget) => void;
  emitSessionEvent: (
    payload: SessionEventPayload,
    options?: { retained?: true; nativeRuntimeId?: string }
  ) => unknown;
  sendOperationResult?: OperationResultSender;
  consumeGateResult?: () => 'pass' | 'fail' | undefined;
  onLocalCompletion: (retain: boolean) => void;
  onCleanupConfirmed: () => void;
  onDiagnostic?: ControlDiagnosticReporter;
  processes?: OwnedProcessScope;
};

class ControlTaskCancellation extends Error {
  constructor(
    readonly status: 'failed' | 'cancelled',
    message: string
  ) {
    super(message);
  }
}

type PublicationScope = Readonly<{
  reason: string;
  deadlineAt: number;
  claim?: symbol;
}>;

type AdmittedFollowUp = {
  readonly request: SessionPromptPayload;
  readonly runtime: WorktreeKiloRuntime;
  readonly authorization?: SessionOperationAuthorization;
};

function authorizationKey(authorization: SessionOperationAuthorization): string {
  return JSON.stringify([
    authorization.session.sessionId,
    authorization.operation,
    authorization.operationId,
  ]);
}

function fail(message: string, retryable: boolean): ControlHandlerResult {
  return { ok: false, error: { code: 'not_ready', message, retryable } };
}

function rootStatusType(properties: unknown): string | undefined {
  if (typeof properties !== 'object' || properties === null) return undefined;
  const status = (properties as { status?: unknown }).status;
  if (typeof status !== 'object' || status === null) return undefined;
  const type = (status as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}

function kiloFailure(error: unknown): ControlHandlerResult {
  return fail('Kilo request failed', isKiloServerUnreachableError(error));
}

function assistantFailureFacts(
  source: unknown
): Pick<SessionMessageOutcome, 'assistantReason' | 'providerOwnership'> {
  const failure = classifyAssistantFailure(source);
  return { assistantReason: failure.reason, providerOwnership: failure.providerOwnership };
}

export class SessionOperation {
  readonly session: Readonly<SessionRequestIdentity>;
  readonly authorization?: Readonly<SessionOperationAuthorization>;
  readonly messageId?: string;
  readonly executionDeadlineAt: number;
  readonly signal: AbortSignal;
  readonly done: Promise<ControlHandlerResult>;
  readonly processes: OwnedProcessScope;
  private readonly controller = new AbortController();
  private readonly completion = Promise.withResolvers<ControlHandlerResult>();
  private readonly publicationScopeChanged = Promise.withResolvers<PublicationScope>();
  private readonly intent: ReturnType<typeof operationIntent>;
  private readonly startedAt = Date.now();
  private readonly timeout: ReturnType<typeof setTimeout>;
  private phase: 'preparation' | 'execution' | 'finalizing';
  private target?: NativeOperationTarget;
  private preClientCleanup?: (deadlineAt: number) => Promise<NativeRetirement>;
  private native: NativeResult = { state: 'not_started' };
  private nativePending?: Promise<unknown>;
  private finalization: Finalization = {};
  private readonly retainedNotifications = createRetainedOperationNotifications();
  private outcome?: SessionMessageOutcome;
  private local?: { result: ControlHandlerResult; completedAt: number };
  private readonly deliveries = new Map<string, OperationResultDelivery>();
  private readonly admitted = new Map<string, AdmittedFollowUp>();
  private batchRevision = 0;
  private sealedRevision = -1;
  private admissionInFlight = 0;
  private rootIdle = false;
  private stableIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly sealWaiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  private readonly cleanupOwner: SessionOperationCleanup;
  private deadlineCleanup?: Promise<boolean>;
  private publicationScoped?: PublicationScope;
  private publicationScopeNotified = false;
  private abortedByMessageScope = false;

  constructor(
    session: SessionRequestIdentity,
    authorization: SessionOperationAuthorization | undefined,
    private readonly work: SessionOperationWork,
    private readonly deps: SessionOperationDependencies
  ) {
    this.session = Object.freeze({ ...session });
    this.authorization = authorization
      ? Object.freeze({ ...authorization, session: Object.freeze({ ...authorization.session }) })
      : undefined;
    this.work =
      work.operation === 'session.attach'
        ? { ...work, payload: structuredClone(work.payload) }
        : { ...work, payload: structuredClone(work.payload) };
    this.phase = work.operation === 'session.attach' ? 'preparation' : 'execution';
    this.messageId =
      work.operation === 'session.attach'
        ? (authorization?.messageId ?? work.payload.preparation?.triggerMessageId)
        : work.payload.messageId;
    this.intent = structuredClone(operationIntent(work.operation, work.payload));
    this.executionDeadlineAt =
      this.phase === 'preparation'
        ? Math.min(
            this.startedAt + SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
            authorization?.dispatchDeadlineAt ?? Infinity
          )
        : this.startedAt + SANDBOX_CONTROL_EXECUTION_TIMEOUT_MS;
    const signals = [this.controller.signal];
    if (deps.signal) signals.push(deps.signal);
    if (work.operation === 'session.prompt') signals.push(work.runtime.signal);
    this.signal = AbortSignal.any(signals);
    this.done = this.completion.promise;
    this.processes = deps.processes ?? createOwnedProcessScope();
    this.cleanupOwner = new SessionOperationCleanup(
      this.session,
      this.processes,
      deps.verifyQuiescence,
      () => deps.onCleanupConfirmed(),
      target => {
        const runtime = deps.getRuntime();
        return (
          runtime?.runtimeId === target.runtimeId &&
          runtime.kiloClient === target.client &&
          runtime.directory === this.session.directory &&
          !runtime.signal.aborted
        );
      }
    );
    this.diagnostic('started');
    this.timeout = setTimeout(
      () => this.expire(),
      Math.max(0, this.executionDeadlineAt - this.startedAt)
    );
    this.timeout.unref();
    void Promise.resolve()
      .then(() =>
        this.processes.run(() =>
          this.work.operation === 'session.attach'
            ? this.attach(this.work)
            : this.execute(this.work)
        )
      )
      .catch((error: unknown) => {
        this.recordUncertainty(error);
        const cancellation: unknown = this.signal.reason;
        return cancellation instanceof ControlTaskCancellation && cancellation.status === 'failed'
          ? fail(cancellation.message, true)
          : kiloFailure(error);
      })
      .then(result => this.complete(result));
  }

  get kind() {
    return this.phase;
  }
  get locallyComplete() {
    return this.local !== undefined;
  }
  get cleanupDeadline() {
    return this.cleanupOwner.cleanupDeadline;
  }
  get cleanup() {
    return this.cleanupOwner.cleanupState;
  }

  nativeTarget(): NativeOperationTarget | undefined {
    return this.target;
  }

  captureCleanupDeadline(deadlineAt = Date.now() + SANDBOX_CONTROL_CLEANUP_TIMEOUT_MS): number {
    return this.cleanupOwner.captureDeadline(deadlineAt);
  }

  stopProcesses(deadlineAt: number): Promise<boolean> {
    return this.cleanupOwner.stopProcesses(deadlineAt);
  }

  async cleanupOwnedWork(
    deadlineAt: number,
    reason = 'Session aborted',
    status: 'failed' | 'cancelled' = 'cancelled'
  ): Promise<boolean> {
    if (this.publicationScoped) {
      await this.runRootScopedCleanup();
      return false;
    }
    return this.cleanupOwner.cleanup({
      deadlineAt,
      target: this.target,
      preClientCleanup: this.preClientCleanup,
      completionEvidence: this.cleanupEvidence(),
      cancel: () => this.cancel(reason, status, deadlineAt),
    });
  }

  markPublicationScoped(reason: string, deadlineAt: number, claim?: symbol): void {
    const captured = this.captureCleanupDeadline(deadlineAt);
    this.publicationScoped = this.publicationScoped
      ? {
          reason: this.publicationScoped.reason,
          deadlineAt: Math.min(this.publicationScoped.deadlineAt, captured),
          ...(claim === undefined && this.publicationScoped.claim === undefined
            ? {}
            : { claim: claim ?? this.publicationScoped.claim }),
        }
      : { reason, deadlineAt: captured, ...(claim === undefined ? {} : { claim }) };
    if (!this.publicationScopeNotified && this.publicationScoped) {
      this.publicationScopeNotified = true;
      this.publicationScopeChanged.resolve(this.publicationScoped);
    }
  }

  publicationScope(): Readonly<{ reason: string; deadlineAt: number; claim?: symbol }> | undefined {
    return this.publicationScoped;
  }

  markMessageScopedAbort(): void {
    this.abortedByMessageScope = true;
  }

  get messageScopedAbort(): boolean {
    return this.abortedByMessageScope;
  }

  waitForPublicationScope(): Promise<PublicationScope> {
    return this.publicationScoped
      ? Promise.resolve(this.publicationScoped)
      : this.publicationScopeChanged.promise;
  }

  runRootScopedCleanup(
    reason = 'Session event delivery failed',
    deadlineAt = Date.now() + SANDBOX_CONTROL_CLEANUP_TIMEOUT_MS
  ): Promise<RootScopedCleanupResult> {
    if (!this.publicationScoped) this.markPublicationScoped(reason, deadlineAt);
    const scoped = this.publicationScoped;
    if (!scoped) return Promise.resolve('unconfirmed');
    return this.cleanupOwner.cleanupRootScoped({
      deadlineAt: scoped.deadlineAt,
      target: this.target,
      completionEvidence: this.cleanupEvidence(),
      cancel: () => this.cancel(scoped.reason, 'failed', scoped.deadlineAt),
    });
  }

  waitForRootScopedCleanup(): Promise<RootScopedCleanupResult> {
    return this.cleanupOwner.waitForRootScopedCleanup();
  }

  snapshot() {
    const retained = this.retainedNotifications.snapshot();
    return {
      kind: this.phase,
      native: structuredClone(this.native),
      finalization: structuredClone(this.finalization),
      events: retained.events,
      preparing: retained.preparing,
      outcome: this.outcome ? structuredClone(this.outcome) : undefined,
      local: this.local ? structuredClone(this.local) : undefined,
      cleanup: this.cleanupOwner.cleanupState,
      cleanupDeadlineAt: this.cleanupOwner.cleanupDeadline,
      cleanupEvidence: this.cleanupEvidence(),
      delivery: this.primaryDelivery()?.snapshot(),
    };
  }

  deliveryResult(authorization?: SessionOperationAuthorization): SessionOperationDelivery | undefined {
    if (authorization) return this.deliveries.get(authorizationKey(authorization))?.result();
    return this.primaryDelivery()?.result();
  }

  private primaryDelivery(): OperationResultDelivery | undefined {
    return this.authorization
      ? this.deliveries.get(authorizationKey(this.authorization))
      : this.deliveries.values().next().value;
  }

  waitForDelivery(): Promise<void> {
    return Promise.all([...this.deliveries.values()].map(delivery => delivery.drain())).then(
      () => undefined
    );
  }

  releaseProcessOwnership(): boolean {
    return this.processes.dispose();
  }

  /**
   * Match the authorization of the admitted entry being queried: the original
   * prompt or any follow-up admitted on this operation. Identity stays strict per
   * entry, so a follow-up `session.operation.get` or replay resolves here.
   */
  matchesAuthorization(authorization: SessionOperationAuthorization): boolean {
    if (this.authorization && sameSessionOperation(this.authorization, authorization)) return true;
    for (const entry of this.admitted.values()) {
      if (entry.authorization && sameSessionOperation(entry.authorization, authorization))
        return true;
    }
    return false;
  }

  matchesIntent(payload: unknown, authorization?: SessionOperationAuthorization): boolean {
    const intent = operationIntent(this.work.operation, payload);
    if (authorization) {
      for (const entry of this.admitted.values()) {
        if (entry.authorization && sameSessionOperation(entry.authorization, authorization))
          return isDeepStrictEqual(
            operationIntent('session.prompt', entry.request),
            intent
          );
      }
    }
    return isDeepStrictEqual(this.intent, intent);
  }

  admittedMessageIds(): string[] {
    return [...(this.messageId === undefined ? [] : [this.messageId]), ...this.admitted.keys()];
  }

  private lastAdmittedMessageId(): string | undefined {
    const ids = this.admittedMessageIds();
    return ids.at(-1);
  }

  /**
   * Admit a follow-up on the running operation. The prompt is submitted with
   * `sendPromptAsync`, so the running turn is never interrupted and no second
   * operation or blocking `sendPrompt` is created.
   */
  admitFollowUp(
    request: SessionPromptPayload,
    runtime: WorktreeKiloRuntime,
    authorization?: SessionOperationAuthorization
  ): ControlHandlerResult {
    if (this.local || this.phase === 'preparation')
      return fail('Operation is not accepting follow-ups', true);
    if (this.signal.aborted) return fail('Operation is aborted', true);
    if (this.messageId === request.messageId || this.admitted.has(request.messageId))
      return { ok: true, result: { messageId: request.messageId, status: 'existing' } };
    if (this.target?.client !== runtime.kiloClient)
      return fail('Kilo runtime changed', true);
    this.admitted.set(request.messageId, { request, runtime, authorization });
    this.batchRevision += 1;
    this.rootIdle = false;
    this.clearStableIdle();
    this.admissionInFlight += 1;
    void this.submitFollowUp(request, runtime).finally(() => {
      this.admissionInFlight -= 1;
      if (this.admissionInFlight === 0) this.restartStableIdle();
    });
    return {
      ok: true,
      result: {
        messageId: request.messageId,
        status: 'accepted',
        ...(authorization ? { executionDeadlineAt: this.executionDeadlineAt } : {}),
      },
    };
  }

  observeRootEvent(event: {
    type: string;
    sessionID?: string;
    rootKiloSessionId?: string;
    properties?: unknown;
  }): void {
    if (this.phase === 'preparation' || this.local) return;
    if (
      event.rootKiloSessionId !== undefined &&
      event.rootKiloSessionId !== this.session.kiloSessionId
    )
      return;
    if (event.sessionID !== undefined && event.sessionID !== this.session.kiloSessionId) return;
    if (event.type === 'session.idle') {
      this.rootIdle = true;
      this.restartStableIdle();
      return;
    }
    // Only the root going busy again drops a started seal. `session.turn.close`
    // and other events follow an idle and must not cancel it, or no later idle
    // would ever seal the batch.
    const statusType = rootStatusType(event.properties);
    if (event.type === 'session.status' && statusType !== undefined && statusType !== 'idle') {
      this.rootIdle = false;
      this.clearStableIdle();
    }
  }

  private async submitFollowUp(
    request: SessionPromptPayload,
    runtime: WorktreeKiloRuntime
  ): Promise<void> {
    try {
      if (request.turn.type !== 'prompt') throw new Error('Unsupported follow-up turn');
      if (request.agent.model === undefined) throw new Error('Prompt model is required');
      const materialize =
        this.work.operation === 'session.prompt'
          ? (this.work.materializeAttachments ?? materializeMessageAttachments)
          : materializeMessageAttachments;
      const message = await materialize(
        {
          id: request.messageId,
          prompt: request.turn.prompt,
          parts: request.turn.parts,
          attachments: request.attachments,
        },
        { signal: this.signal }
      );
      await runtime.kiloClient.sendPromptAsync({
        sessionId: this.session.kiloSessionId,
        directory: this.session.directory,
        signal: this.signal,
        messageId: request.messageId,
        agent: request.agent.mode,
        ...(request.agent.variant ? { variant: request.agent.variant } : {}),
        prompt: message.prompt,
        ...(message.parts ? { parts: message.parts } : {}),
        model: { providerID: 'kilo', modelID: request.agent.model },
      });
    } catch (error) {
      this.recordUncertainty(error);
      this.cancel('Follow-up prompt submission failed', 'failed');
    }
  }

  /**
   * Arm the 3s stable-idle timer only while root idle holds and no admission is
   * in flight. A batch starts unsealed, so this is the only path that can seal.
   */
  private armStableIdle(): void {
    if (this.local || this.stableIdleTimer) return;
    if (!this.rootIdle || this.admissionInFlight > 0) return;
    if (this.sealedRevision >= this.batchRevision) return;
    this.stableIdleTimer = setTimeout(() => this.trySeal(), STABLE_ROOT_IDLE_MS);
    this.stableIdleTimer.unref?.();
  }

  private restartStableIdle(): void {
    this.clearStableIdle();
    this.armStableIdle();
  }

  private clearStableIdle(): void {
    if (!this.stableIdleTimer) return;
    clearTimeout(this.stableIdleTimer);
    this.stableIdleTimer = null;
  }

  private trySeal(): void {
    this.stableIdleTimer = null;
    if (this.sealedRevision >= this.batchRevision) return;
    if (!this.rootIdle || this.admissionInFlight > 0) return;
    this.sealedRevision = this.batchRevision;
    for (const waiter of this.sealWaiters.splice(0)) waiter.resolve();
  }

  /**
   * Wait for a real stable-idle seal. The batch starts unsealed, so the initial
   * equal revisions are never a seal. Reject on abort or the execution deadline
   * so a cancelled batch still runs cleanup and terminal delivery.
   */
  private waitForSeal(): Promise<void> {
    if (this.sealedRevision >= this.batchRevision) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.signal.removeEventListener('abort', onAbort);
        reject(this.signal.reason);
      };
      const waiter = {
        resolve: () => {
          this.signal.removeEventListener('abort', onAbort);
          resolve();
        },
        reject: (error: unknown) => {
          this.signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      if (this.signal.aborted) {
        waiter.reject(this.signal.reason);
        return;
      }
      this.signal.addEventListener('abort', onAbort, { once: true });
      this.sealWaiters.push(waiter);
    });
  }

  canPrune(now: number): boolean {
    if (this.authorization === undefined || this.local === undefined) return false;
    if (this.native.state === 'pending' || this.native.state === 'unknown') return false;
    if (this.deliveries.size === 0) return false;
    let deadlineAt = this.authorization.dispatchDeadlineAt;
    for (const delivery of this.deliveries.values()) {
      const status = delivery.status();
      if (status.state !== 'acknowledged') return false;
      deadlineAt = Math.max(deadlineAt, status.deadlineAt);
    }
    return now >= deadlineAt;
  }

  async acknowledge(ack: SessionOperationAck, isCurrent: () => boolean): Promise<boolean> {
    const delivery = this.deliveries.get(authorizationKey(ack.authorization));
    return delivery ? delivery.acknowledge(ack, isCurrent) : false;
  }

  cancel(reason: string, status: 'failed' | 'cancelled', cleanupDeadlineAt?: number): void {
    if (cleanupDeadlineAt !== undefined) {
      const captured = this.captureCleanupDeadline(cleanupDeadlineAt);
      if (this.publicationScoped)
        this.publicationScoped = {
          ...this.publicationScoped,
          deadlineAt: Math.min(this.publicationScoped.deadlineAt, captured),
        };
    }
    if (!this.local) this.controller.abort(new ControlTaskCancellation(status, reason));
  }

  requestRetirement(reason: string, deadlineAt: number): void {
    if (
      this.abortedByMessageScope ||
      this.publicationScoped ||
      this.cleanupOwner.cleanupState === 'confirmed'
    )
      return;
    this.deps.retireRuntime(reason, this.captureCleanupDeadline(deadlineAt), this.nativeTarget());
  }

  reportUnreapedProcessCleanup(populated: boolean): void {
    const detail = diagnosticDetail(
      `owned_process_unreaped populated=${populated ? '1' : '0'} ${this.session.directory}`
    );
    emitControlDiagnostic(this.deps.onDiagnostic, 'session.task', {
      sessionId: this.session.sessionId,
      kiloSessionId: this.session.kiloSessionId,
      messageId: this.messageId,
      kind: this.work.operation === 'session.attach' ? 'preparation' : 'execution',
      stage: 'process_cleanup',
      phase: 'failed',
      ok: false,
      ...(detail ? { detail } : {}),
    });
    console.error(OWNED_PROCESS_CLEANUP_UNREAPED);
  }

  confirmCleanup(confirmed: boolean, deadlineAt: number): boolean {
    return this.cleanupOwner.confirm(confirmed, deadlineAt);
  }

  private diagnostic(phase: string): void {
    emitControlDiagnostic(this.deps.onDiagnostic, 'session.task', {
      sessionId: this.session.sessionId,
      kiloSessionId: this.session.kiloSessionId,
      messageId: this.messageId,
      kind: this.work.operation === 'session.attach' ? 'preparation' : 'execution',
      phase,
      elapsedMs: Date.now() - this.startedAt,
    });
  }

  private expire(): void {
    if (this.local || this.deadlineCleanup) return;
    const reason =
      this.work.operation === 'session.attach'
        ? 'Session preparation timed out'
        : 'Execution exceeded the 60 minute limit';
    this.diagnostic('deadline_expired');
    const deadlineAt = this.captureCleanupDeadline(
      Math.max(this.executionDeadlineAt, Date.now()) + SANDBOX_CONTROL_CLEANUP_TIMEOUT_MS
    );
    void this.stopProcesses(deadlineAt);
    this.cancel(reason, 'failed', deadlineAt);
    this.deadlineCleanup = this.cleanupOwnedWork(deadlineAt, reason, 'failed');
    void this.deadlineCleanup.then(confirmed => {
      if (!confirmed) this.requestRetirement(reason, deadlineAt);
    });
  }

  private assertCurrent(): void {
    if (Date.now() >= this.executionDeadlineAt) this.expire();
    this.signal.throwIfAborted();
    if (!this.deps.isCurrent()) throw new Error('Operation execution authority expired');
  }

  private recordUncertainty(error: unknown): void {
    if (this.native.state === 'pending') this.native = { state: 'unknown', error };
    if (this.finalization.autoCommit?.state === 'running')
      this.finalization.autoCommit = { state: 'unknown', error };
    if (this.finalization.condensation?.state === 'running')
      this.finalization.condensation = { state: 'unknown', error };
  }

  private captureRuntime(runtime: WorktreeKiloRuntime): void {
    if (this.target) return;
    this.target = Object.freeze({
      runtimeId: runtime.runtimeId,
      client: runtime.kiloClient,
    });
  }

  private cleanupEvidence(): NativeCleanupEvidence {
    if (
      this.admissionInFlight > 0 ||
      (this.work.operation !== 'session.attach' && this.sealedRevision < this.batchRevision)
    )
      return 'unconfirmed';
    if (this.native.state === 'not_started')
      return this.local === undefined ? 'unconfirmed' : 'not_issued';
    if (this.native.state !== 'completed') return 'unconfirmed';
    if (
      (this.native.completion === undefined && this.native.result === undefined) ||
      this.native.completion?.error !== undefined ||
      this.native.result === false ||
      (this.finalization.autoCommit !== undefined &&
        (this.finalization.autoCommit.state !== 'completed' ||
          !this.finalization.autoCommit.result.success)) ||
      (this.finalization.condensation !== undefined &&
        (this.finalization.condensation.state !== 'completed' ||
          this.finalization.condensation.result !== true))
    )
      return 'unconfirmed';
    return 'finished';
  }

  private async attach(
    work: Extract<SessionOperationWork, { operation: 'session.attach' }>
  ): Promise<ControlHandlerResult> {
    this.assertCurrent();
    const result = await work.apply(this.session, work.payload, {
      signal: this.signal,
      assertCurrent: () => this.assertCurrent(),
      onMutation: () => {
        this.assertCurrent();
        this.native.state = 'pending';
      },
      onRuntime: runtime => this.captureRuntime(runtime),
      onCleanupTarget: cleanup => {
        if (!this.preClientCleanup) this.preClientCleanup = cleanup;
      },
      onError: error => {
        this.native.error = error;
      },
      emitPreparing: event => {
        const retained =
          this.authorization && isRetainedOperationPreparing(event)
            ? this.retainedNotifications.retainPreparing(event)
            : undefined;
        if (this.authorization && isRetainedOperationPreparing(event) && !retained) return;
        try {
          work.emitPreparing?.(retained ?? event, this.eventOptions());
        } catch {
          this.diagnostic('send_failed');
        }
      },
    });
    if (this.signal.aborted) {
      const cancellation: unknown = this.signal.reason;
      return fail(
        cancellation instanceof ControlTaskCancellation && cancellation.status === 'failed'
          ? cancellation.message
          : 'Session attachment cancelled',
        true
      );
    }
    if (!result.ok) return result;
    if (this.native.state === 'pending') this.native = { state: 'completed', result: true };
    work.onAttached();
    return {
      ok: true,
      result: {
        attached: true,
        ...(work.payload.captureNativeRuntimeId && this.target
          ? { nativeRuntimeId: this.target.runtimeId }
          : {}),
      },
    };
  }

  private eventOptions(): { retained?: true; nativeRuntimeId?: string } {
    return {
      ...(this.authorization ? { retained: true } : {}),
      ...(this.target ? { nativeRuntimeId: this.target.runtimeId } : {}),
    };
  }

  private emitFinalizationEvent(event: IngestEvent): void {
    const payload = sessionEventPayloadSchema.safeParse({
      type: event.streamEventType,
      properties: event.data,
      timestamp: event.timestamp,
    });
    if (!payload.success) return;
    const requiresRetention =
      payload.data.type === 'autocommit_completed' || payload.data.type === 'status';
    const retained =
      this.authorization && requiresRetention
        ? this.retainedNotifications.retainFinalization(payload.data)
        : undefined;
    if (this.authorization && requiresRetention && !retained) return;
    try {
      const delivered = this.deps.emitSessionEvent(retained ?? payload.data, this.eventOptions());
      if (delivered === false) this.diagnostic('send_failed');
    } catch {
      this.diagnostic('send_failed');
    }
  }

  private observeNative(pending: Promise<NativeCompletion>): Promise<NativeCompletion> {
    this.native.state = 'pending';
    const observed = pending.then(
      completion => {
        if (!this.local)
          this.native = { state: 'completed', completion: structuredClone(completion.info) };
        return completion;
      },
      (error: unknown) => {
        if (!this.local) this.native = { state: 'unknown', error };
        throw error;
      }
    );
    this.nativePending = observed;
    return observed;
  }

  private async summarize(
    client: WrapperKiloClient,
    model: { providerID?: string; modelID: string },
    auto?: boolean
  ): Promise<void> {
    this.signal.throwIfAborted();
    const remaining = this.executionDeadlineAt - Date.now();
    if (remaining <= 0) throw new Error('Execution exceeded the 60 minute limit');
    this.finalization.condensation = { state: 'running' };
    if (auto === undefined) this.native.state = 'pending';
    const pending = client
      .summarizeSession({
        sessionId: this.session.kiloSessionId,
        directory: this.session.directory,
        signal: this.signal,
        model,
        ...(auto === undefined ? {} : { auto }),
      })
      .then(
        result => {
          if (!this.local) {
            this.finalization.condensation = { state: 'completed', result };
            if (auto === undefined) this.native = { state: 'completed', result };
          }
          return result;
        },
        (error: unknown) => {
          if (!this.local) {
            this.finalization.condensation = { state: 'unknown', error };
            if (auto === undefined) this.native = { state: 'unknown', error };
          }
          throw error;
        }
      );
    this.nativePending = pending;
    const success = await withTimeoutAndAbort(pending, {
      signal: this.signal,
      timeoutMs: remaining,
      timeoutMessage: 'Execution exceeded the 60 minute limit',
      abortMessage: 'Execution cancelled',
    });
    if (!success) throw new Error('Session summarization failed');
  }

  private async execute(
    work: Extract<SessionOperationWork, { operation: 'session.prompt' }>
  ): Promise<ControlHandlerResult> {
    const { session, signal } = this;
    const request = work.payload;
    const { runtime } = work;
    const { kiloClient, env } = runtime;
    this.captureRuntime(runtime);
    this.deps.consumeGateResult?.();
    const assertCurrent = (submitting = false) => {
      signal.throwIfAborted();
      if (
        !this.deps.isCurrent() ||
        runtime.kiloClient !== kiloClient ||
        Date.now() >= this.executionDeadlineAt ||
        (submitting && this.deps.getRuntime() !== runtime) ||
        (submitting && this.authorization && Date.now() >= this.authorization.dispatchDeadlineAt)
      )
        throw new Error('Operation execution authority expired');
    };
    const { messageId, turn, agent } = request;
    const startedAt = Date.now();
    const diagnostic = (phase: string, status?: SessionMessageOutcome['status']): void =>
      emitControlDiagnostic(this.deps.onDiagnostic, 'session.execution', {
        sessionId: session.sessionId,
        kiloSessionId: session.kiloSessionId,
        messageId,
        phase,
        status,
        elapsedMs: Date.now() - startedAt,
        aborted: signal.aborted,
      });
    let outcome: SessionMessageOutcome;
    let result: ControlHandlerResult = { ok: true, result: {} };
    let failureReason = 'Kilo execution failed';
    const emitStatus = (message: string): void =>
      this.emitFinalizationEvent({
        streamEventType: 'status',
        data: { message, messageId },
        timestamp: new Date().toISOString(),
      });
    try {
      assertCurrent(true);
      let completion: NativeCompletion | undefined;
      const options = {
        sessionId: session.kiloSessionId,
        directory: session.directory,
        signal,
        messageId,
        agent: agent.mode,
        ...(agent.variant ? { variant: agent.variant } : {}),
      };
      const deadline = {
        signal,
        timeoutMs: Math.max(1, this.executionDeadlineAt - Date.now()),
        timeoutMessage: 'Execution exceeded the 60 minute limit',
        abortMessage: 'Execution cancelled',
      };
      if (turn.type === 'prompt') {
        if (agent.model === undefined) throw new Error('Prompt model is required');
        const message = await (work.materializeAttachments ?? materializeMessageAttachments)(
          {
            id: messageId,
            prompt: turn.prompt,
            parts: turn.parts,
            attachments: request.attachments,
          },
          { signal }
        );
        assertCurrent(true);
        diagnostic('prompt_started');
        this.native.state = 'pending';
        completion = await withTimeoutAndAbort(
          this.observeNative(
            kiloClient.sendPrompt({
              ...options,
              prompt: message.prompt,
              ...(message.parts ? { parts: message.parts } : {}),
              model: { providerID: 'kilo', modelID: agent.model },
            })
          ),
          { ...deadline, timeoutMs: Math.max(1, this.executionDeadlineAt - Date.now()) }
        );
        diagnostic('prompt_completed');
      } else if (turn.command === 'compact') {
        if (!agent.model) throw new Error('Model is required for compact');
        failureReason = 'Context condensation failed';
        emitStatus('Condensing context...');
        diagnostic('compact_started');
        await this.summarize(kiloClient, { providerID: 'kilo', modelID: agent.model });
        diagnostic('compact_completed');
        signal.throwIfAborted();
        emitStatus('Context condensed successfully');
      } else {
        assertCurrent(true);
        diagnostic('command_started');
        this.native.state = 'pending';
        completion = await withTimeoutAndAbort(
          this.observeNative(
            kiloClient.sendCommand({
              ...options,
              command: turn.command,
              args: turn.arguments,
              ...(agent.model !== undefined
                ? { model: { providerID: 'kilo', modelID: agent.model } }
                : {}),
            })
          ),
          deadline
        );
        diagnostic('command_completed');
      }
      assertCurrent();
      const error = completion?.info.error;
      if (this.admitted.size > 0 || this.admissionInFlight > 0) {
        if (error) {
          // A terminal native error must still stop the unfinished follow-up
          // work before the operation is released. Unconfirmed cleanup must not
          // release the operation as if Kilo stopped, so apply the same
          // retirement policy as the failure path.
          const cleanupDeadlineAt = this.captureCleanupDeadline();
          const cleanupConfirmed = await this.cleanupOwnedWork(cleanupDeadlineAt);
          if (!cleanupConfirmed && !this.deadlineCleanup)
            this.requestRetirement('Kilo cancellation was not confirmed', cleanupDeadlineAt);
        } else {
          // A follow-up admitted while the first prompt ran is part of this
          // batch: do not finalize until the batch seals on root idle plus
          // stable idle.
          await this.waitForSeal();
          assertCurrent();
        }
      }
      if (
        !error &&
        (request.finalization?.autoCommit || request.finalization?.condenseOnComplete)
      ) {
        this.phase = 'finalizing';
        diagnostic('finalization_started');
        // A sealed set is finalized once. The sealed revision is read after the
        // wait, so a follow-up admitted during the wait is included in the same
        // set; a follow-up admitted while a commit runs enlarges the set and
        // forces one more sealed pass.
        while (true) {
          await this.waitForSeal();
          const revision = this.batchRevision;
          if (request.finalization?.autoCommit) {
            failureReason = 'Auto-commit failed';
            assertCurrent();
            diagnostic('autocommit_started');
            this.finalization.autoCommit = { state: 'running' };
            const committed = await (work.runAutoCommit ?? runAutoCommit)({
              workspacePath: session.directory,
              kiloClient,
              env,
              messageId: completion?.info.id ?? messageId,
              userMessageId: this.lastAdmittedMessageId(),
              signal,
              onEvent: event => this.emitFinalizationEvent(event),
            });
            this.finalization.autoCommit = {
              state: 'completed',
              result: structuredClone(committed),
            };
            assertCurrent();
            if (!committed.success) throw new Error('Auto-commit failed');
            diagnostic('autocommit_completed');
          }
          if (this.batchRevision !== revision) continue;
          if (request.finalization?.condenseOnComplete) {
            failureReason = 'Context condensation failed';
            const model = agent.model
              ? { providerID: 'kilo', modelID: agent.model }
              : completion
                ? { providerID: completion.info.providerID, modelID: completion.info.modelID }
                : undefined;
            if (!model) throw new Error('Model is required for condensation');
            emitStatus('Condensing context...');
            assertCurrent();
            diagnostic('condense_started');
            await this.summarize(kiloClient, model, true);
            diagnostic('condense_completed');
            signal.throwIfAborted();
            emitStatus('Context condensed successfully');
          }
          if (this.batchRevision !== revision) continue;
          break;
        }
      }
      outcome = error
        ? {
            messageId,
            status: error.name === 'MessageAbortedError' ? 'cancelled' : 'failed',
            reason: `Kilo execution ended with ${error.name}`,
            ...(error.name === 'MessageAbortedError' ? {} : assistantFailureFacts(error)),
          }
        : { messageId, status: 'completed' };
    } catch (error) {
      diagnostic('execution_failed');
      this.recordUncertainty(error);
      const cancellation: unknown = signal.reason;
      outcome = {
        messageId,
        status: cancellation instanceof ControlTaskCancellation ? cancellation.status : 'failed',
        reason:
          cancellation instanceof ControlTaskCancellation
            ? cancellation.message
            : this.authorization && this.native.state === 'unknown'
              ? 'Kilo execution outcome is unconfirmed'
              : failureReason,
      };
      try {
        diagnostic('abort_started');
        const cleanupDeadlineAt = this.captureCleanupDeadline();
        const cleanupConfirmed = await this.cleanupOwnedWork(cleanupDeadlineAt);
        if (!cleanupConfirmed && !this.deadlineCleanup)
          this.requestRetirement('Kilo cancellation was not confirmed', cleanupDeadlineAt);
        const pending = this.nativePending;
        if (cleanupConfirmed && pending) {
          try {
            await withTimeoutAndAbort(pending, {
              timeoutMs: Math.max(1, cleanupDeadlineAt - Date.now()),
              timeoutMessage: 'Native cancellation did not settle',
              abortMessage: 'Native cancellation interrupted',
            });
          } catch (error) {
            this.recordUncertainty(error);
          }
        }
        diagnostic('abort_completed');
      } catch (error) {
        diagnostic('abort_failed');
        this.requestRetirement('Kilo cancellation failed', this.captureCleanupDeadline());
        result = kiloFailure(error);
      }
      const original = this.native.completion;
      if (original?.error)
        outcome = {
          messageId,
          status: original.error.name === 'MessageAbortedError' ? 'cancelled' : 'failed',
          reason: `Kilo execution ended with ${original.error.name}`,
          ...(original.error.name === 'MessageAbortedError'
            ? {}
            : assistantFailureFacts(original.error)),
        };
      else if (
        this.native.state === 'unknown' &&
        this.native.error instanceof Error &&
        this.native.error.name === 'MessageAbortedError'
      )
        outcome = {
          messageId,
          status: 'cancelled',
          reason: 'Kilo execution ended with MessageAbortedError',
        };
      else if (
        this.admitted.size === 0 &&
        this.admissionInFlight === 0 &&
        this.native.state === 'completed' &&
        this.native.result !== false &&
        (!request.finalization?.autoCommit ||
          (this.finalization.autoCommit?.state === 'completed' &&
            this.finalization.autoCommit.result.success)) &&
        (!request.finalization?.condenseOnComplete ||
          (this.finalization.condensation?.state === 'completed' &&
            this.finalization.condensation.result === true))
      )
        outcome = { messageId, status: 'completed' };
    }
    const gateResult = this.deps.consumeGateResult?.();
    if (outcome.status === 'completed' && gateResult !== undefined) {
      outcome = { ...outcome, gateResult };
    }
    this.outcome = sessionMessageOutcomeSchema.parse(outcome);
    if (!this.authorization) {
      try {
        diagnostic('outcome_sending', outcome.status);
        const delivered = this.deps.emitSessionEvent(
          {
            type: 'session.message.outcome',
            properties: this.outcome,
          },
          this.eventOptions()
        );
        if (delivered === false) diagnostic('send_failed', outcome.status);
        else diagnostic('outcome_sent', outcome.status);
      } catch {
        diagnostic('outcome_failed', outcome.status);
      }
    }
    return result;
  }

  private complete(result: ControlHandlerResult): void {
    result = result.ok ? { ok: true, result: result.result } : { ok: false, error: result.error };
    this.processes.seal();
    this.local = { result: structuredClone(result), completedAt: Date.now() };
    clearTimeout(this.timeout);
    const retain =
      result.ok ||
      result.error.code !== 'session_busy' ||
      this.native.state !== 'not_started' ||
      this.signal.aborted;
    this.deps.onLocalCompletion(retain);
    this.diagnostic(result.ok ? 'finished' : 'failed');
    this.completion.resolve(result);
    if (!retain) return;
    const retained = this.retainedNotifications.snapshot();
    const completedAt = this.local.completedAt;
    const createDelivery = (
      authorization: SessionOperationAuthorization,
      payload: {
        outcome?: SessionMessageOutcome;
        assistantMessageId?: string;
        events?: typeof retained.events;
        preparing?: typeof retained.preparing;
      }
    ): OperationResultDelivery =>
      createOperationResultDelivery(
        sessionOperationDeliverySchema.parse({
          version: 2,
          authorization,
          completedAt,
          result,
          ...(payload.outcome ? { outcome: payload.outcome } : {}),
          ...(payload.assistantMessageId ? { assistantMessageId: payload.assistantMessageId } : {}),
          events: payload.events ?? [],
          preparing: payload.preparing ?? [],
        }),
        Math.min(
          completedAt + SANDBOX_CONTROL_OUTCOME_TIMEOUT_MS,
          sessionOperationExpiresAt(authorization)
        ),
        this.deps.sendOperationResult
      );
    if (this.authorization) {
      this.deliveries.set(
        authorizationKey(this.authorization),
        createDelivery(this.authorization, {
          ...(this.outcome ? { outcome: this.outcome } : {}),
          ...(this.native.completion ? { assistantMessageId: this.native.completion.id } : {}),
          events: retained.events,
          preparing: retained.preparing,
        })
      );
    }
    for (const [messageId, admitted] of this.admitted) {
      if (!admitted.authorization) continue;
      this.deliveries.set(
        authorizationKey(admitted.authorization),
        createDelivery(admitted.authorization, { outcome: this.followUpOutcome(messageId) })
      );
    }
    for (const delivery of this.deliveries.values()) void delivery.start();
  }

  private followUpOutcome(messageId: string): SessionMessageOutcome {
    const outcome = this.outcome;
    if (!outcome) return { messageId, status: 'failed', reason: 'Kilo execution failed' };
    if (outcome.status === 'completed') return { messageId, status: 'completed' };
    return {
      messageId,
      status: outcome.status,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    };
  }
}
