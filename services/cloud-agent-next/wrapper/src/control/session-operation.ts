import { isDeepStrictEqual } from 'node:util';
import {
  emitControlDiagnostic,
  type ControlDiagnosticReporter,
} from '../../../src/shared/control-diagnostics.js';
import {
  SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
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
import { materializeMessageAttachments } from '../session-bootstrap.js';
import { runAutoCommit, type AutoCommitResult } from '../auto-commit.js';
import { withTimeoutAndAbort } from '../utils.js';
import type { AttachPreparingEmitter } from './apply-attach.js';
import { KILO_CONTROL_REQUEST_TIMEOUT_MS } from './sandbox-control-runtime.js';
import type { WorktreeKiloRuntime } from './worktree-runtime.js';
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
        hooks: { signal: AbortSignal; emitPreparing?: AttachPreparingEmitter }
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
  retireRuntime: (reason: string) => void;
  emitSessionEvent: (payload: SessionEventPayload, options?: { retained?: true }) => void;
  sendOperationResult?: OperationResultSender;
  onLocalCompletion: (retain: boolean) => void;
  onDiagnostic?: ControlDiagnosticReporter;
};

class ControlTaskCancellation extends Error {
  constructor(
    readonly status: 'failed' | 'cancelled',
    message: string
  ) {
    super(message);
  }
}

function fail(message: string, retryable: boolean): ControlHandlerResult {
  return { ok: false, error: { code: 'not_ready', message, retryable } };
}

function kiloFailure(error: unknown): ControlHandlerResult {
  return fail('Kilo request failed', isKiloServerUnreachableError(error));
}

export class SessionOperation {
  readonly session: Readonly<SessionRequestIdentity>;
  readonly authorization?: Readonly<SessionOperationAuthorization>;
  readonly messageId?: string;
  readonly executionDeadlineAt: number;
  readonly signal: AbortSignal;
  readonly done: Promise<ControlHandlerResult>;
  private readonly controller = new AbortController();
  private readonly completion = Promise.withResolvers<ControlHandlerResult>();
  private readonly intent: ReturnType<typeof operationIntent>;
  private readonly startedAt = Date.now();
  private readonly timeout: ReturnType<typeof setTimeout>;
  private phase: 'preparation' | 'execution' | 'finalizing';
  private client?: WrapperKiloClient;
  private native: NativeResult = { state: 'not_started' };
  private nativePending?: Promise<unknown>;
  private finalization: Finalization = {};
  private readonly retainedNotifications = createRetainedOperationNotifications();
  private outcome?: SessionMessageOutcome;
  private local?: { result: ControlHandlerResult; completedAt: number };
  private delivery?: OperationResultDelivery;

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
    this.diagnostic('started');
    this.timeout = setTimeout(
      () => this.expire(),
      Math.max(0, this.executionDeadlineAt - this.startedAt)
    );
    this.timeout.unref();
    void Promise.resolve()
      .then(() =>
        this.work.operation === 'session.attach' ? this.attach(this.work) : this.execute(this.work)
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
      delivery: this.delivery?.snapshot(),
    };
  }

  deliveryResult(): SessionOperationDelivery | undefined {
    return this.delivery?.result();
  }

  waitForDelivery(): Promise<void> {
    return this.delivery?.drain() ?? Promise.resolve();
  }

  matchesAuthorization(authorization: SessionOperationAuthorization): boolean {
    return (
      this.authorization !== undefined && sameSessionOperation(this.authorization, authorization)
    );
  }

  matchesIntent(payload: unknown): boolean {
    return isDeepStrictEqual(this.intent, operationIntent(this.work.operation, payload));
  }

  canPrune(now: number): boolean {
    const delivery = this.delivery?.status();
    return (
      this.authorization !== undefined &&
      this.local !== undefined &&
      this.native.state !== 'pending' &&
      this.native.state !== 'unknown' &&
      delivery?.state === 'acknowledged' &&
      now >= Math.max(this.authorization.dispatchDeadlineAt, delivery.deadlineAt)
    );
  }

  acknowledge(ack: SessionOperationAck, isCurrent: () => boolean): Promise<boolean> {
    return this.delivery?.acknowledge(ack, isCurrent) ?? Promise.resolve(false);
  }

  cancel(reason: string, status: 'failed' | 'cancelled'): void {
    if (!this.local) this.controller.abort(new ControlTaskCancellation(status, reason));
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
    if (this.local) return;
    const reason =
      this.work.operation === 'session.attach'
        ? 'Session preparation timed out'
        : 'Execution exceeded the 60 minute limit';
    this.diagnostic('deadline_expired');
    this.cancel(reason, 'failed');
    this.deps.retireRuntime(reason);
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

  private captureClient(client: WrapperKiloClient): void {
    if (this.client) return;
    this.client = client;
  }

  private async attach(
    work: Extract<SessionOperationWork, { operation: 'session.attach' }>
  ): Promise<ControlHandlerResult> {
    this.assertCurrent();
    const result = await work.apply(this.session, work.payload, {
      signal: this.signal,
      emitPreparing: event => {
        const retained =
          this.authorization && isRetainedOperationPreparing(event)
            ? this.retainedNotifications.retainPreparing(event)
            : undefined;
        if (this.authorization && isRetainedOperationPreparing(event) && !retained) return;
        try {
          work.emitPreparing?.(
            retained ?? event,
            this.authorization ? { retained: true } : undefined
          );
        } catch {
          if (!this.authorization) throw new Error('Preparation event delivery failed');
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
    if (result.ok) work.onAttached();
    return result;
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
      this.deps.emitSessionEvent(
        retained ?? payload.data,
        this.authorization ? { retained: true } : undefined
      );
    } catch {
      if (!this.authorization) throw new Error('Finalization event delivery failed');
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

  private async waitForNativeAfterAbort(
    pending: Promise<unknown>,
    deadlineAt: number
  ): Promise<void> {
    try {
      await withTimeoutAndAbort(pending, {
        timeoutMs: Math.max(0, deadlineAt - Date.now()),
        timeoutMessage: 'Native cancellation did not settle',
        abortMessage: 'Native cancellation interrupted',
      });
    } catch (error) {
      this.recordUncertainty(error);
      this.deps.retireRuntime('Native cancellation did not settle');
    }
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
    this.captureClient(kiloClient);
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
      if (
        !error &&
        (request.finalization?.autoCommit || request.finalization?.condenseOnComplete)
      ) {
        this.phase = 'finalizing';
        diagnostic('finalization_started');
        if (request.finalization.autoCommit) {
          failureReason = 'Auto-commit failed';
          assertCurrent();
          diagnostic('autocommit_started');
          this.finalization.autoCommit = { state: 'running' };
          const committed = await (work.runAutoCommit ?? runAutoCommit)({
            workspacePath: session.directory,
            kiloClient,
            env,
            messageId: completion?.info.id ?? messageId,
            signal,
            onEvent: event => this.emitFinalizationEvent(event),
          });
          this.finalization.autoCommit = { state: 'completed', result: structuredClone(committed) };
          assertCurrent();
          if (!committed.success) throw new Error('Auto-commit failed');
          diagnostic('autocommit_completed');
        }
        if (request.finalization.condenseOnComplete) {
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
      }
      outcome = error
        ? {
            messageId,
            status: error.name === 'MessageAbortedError' ? 'cancelled' : 'failed',
            reason: `Kilo execution ended with ${error.name}`,
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
        const cleanupDeadlineAt = Date.now() + KILO_CONTROL_REQUEST_TIMEOUT_MS;
        const abortController = new AbortController();
        const abortTimer = setTimeout(
          () => abortController.abort(new Error('Kilo cancellation timed out')),
          Math.max(0, cleanupDeadlineAt - Date.now())
        );
        let aborted: boolean;
        try {
          aborted = await withTimeoutAndAbort(
            kiloClient.abortSession({
              sessionId: session.kiloSessionId,
              directory: session.directory,
              signal: abortController.signal,
            }),
            {
              timeoutMs: Math.max(0, cleanupDeadlineAt - Date.now()),
              timeoutMessage: 'Kilo cancellation timed out',
              abortMessage: 'Kilo cancellation interrupted',
            }
          );
        } finally {
          clearTimeout(abortTimer);
        }
        if (aborted !== true) throw new Error('Kilo cancellation was not confirmed');
        const pendingNative = this.nativePending;
        if (pendingNative) await this.waitForNativeAfterAbort(pendingNative, cleanupDeadlineAt);
        diagnostic('abort_completed');
      } catch (error) {
        diagnostic('abort_failed');
        this.deps.retireRuntime('Kilo cancellation failed');
        result = kiloFailure(error);
      }
      const original = this.native.completion;
      if (original?.error)
        outcome = {
          messageId,
          status: original.error.name === 'MessageAbortedError' ? 'cancelled' : 'failed',
          reason: `Kilo execution ended with ${original.error.name}`,
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
    this.outcome = sessionMessageOutcomeSchema.parse(outcome);
    if (!this.authorization) {
      try {
        diagnostic('outcome_sending', outcome.status);
        this.deps.emitSessionEvent({ type: 'session.message.outcome', properties: this.outcome });
        diagnostic('outcome_sent', outcome.status);
      } catch {
        diagnostic('outcome_failed', outcome.status);
        this.deps.retireRuntime('Session outcome delivery failed');
        return fail('Session outcome delivery failed', false);
      }
    }
    return result;
  }

  private complete(result: ControlHandlerResult): void {
    result = result.ok ? { ok: true, result: result.result } : { ok: false, error: result.error };
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
    if (this.authorization && retain) {
      const retained = this.retainedNotifications.snapshot();
      const delivery = sessionOperationDeliverySchema.parse({
        version: 2,
        authorization: this.authorization,
        completedAt: this.local.completedAt,
        result,
        ...(this.outcome ? { outcome: this.outcome } : {}),
        ...(this.native.completion ? { assistantMessageId: this.native.completion.id } : {}),
        events: retained.events,
        preparing: retained.preparing,
      });
      this.delivery = createOperationResultDelivery(
        delivery,
        Math.min(
          this.local.completedAt + SANDBOX_CONTROL_OUTCOME_TIMEOUT_MS,
          sessionOperationExpiresAt(this.authorization)
        ),
        this.deps.sendOperationResult
      );
      void this.delivery.start();
    }
  }
}
