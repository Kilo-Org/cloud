import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import migrations from '../../drizzle/migrations';
import type { Env } from '../types.js';
import type { SessionId } from '../types/ids.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import { parseSessionMetadata, serializeSessionMetadata } from '../persistence/session-metadata.js';
import type { OperationResult } from '../persistence/types.js';
import type { CallbackTarget } from '../callbacks/index.js';
import type {
  LegacyRegisteredInitialAdmissionRequest,
  SessionMessageAdmissionResult,
  SubmittedSessionMessageRequest,
} from '../execution/types.js';
import type { MessageResultRPCResponse } from '../session/message-result.js';
import type { LatestAssistantMessage } from '../session/types.js';
import { createEventQueries, type EventQueries } from '../session/queries/index.js';
import { createStreamHandler } from '../websocket/stream.js';
import type { StoredEvent } from '../websocket/types.js';
import { persistSandboxControlSessionEvent } from './sandbox-control-event.js';
import {
  controlEventToIngestItems,
  ingestKiloSessionId,
  publishControlPlaneSessionIngest,
} from './control-plane-ingest.js';
import { applyControlPlanePreparingEvent } from './control-plane-preparing.js';
import { logger } from '../logger.js';
import { sandboxControlRpc } from './control-rpc.js';
import { DEADLINE_MS } from '../sandbox-control/deadlines.js';
import { createMessageId } from '../session/message-id.js';
import { buildSessionAttachPayload, fillAttachGitToken } from './attach-payload.js';
import { getSandboxProvider } from '../persistence/session-metadata.js';
import { createPreparationProgressRecorder } from '../session/preparation-progress.js';
import {
  finalizeOtherRunningAttemptsForMessage,
  finalizePreparationAttempt,
} from '../session/preparation-history.js';
import {
  SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
  type SessionEventIdentity,
  type SessionPreparingPayload,
} from '../shared/sandbox-control-protocol.js';
import type { WrapperPty } from '../kilo/wrapper-client.js';
import {
  controlDispatchDisposition,
  failureReasonFromControlStatus,
  observeControlAfterStopping,
  safeErrorFromQueueReason,
} from './control-dispatch.js';
import { acceptedAlarmDecision } from './accepted-overdue.js';
import { bootPreparingStep, provisionPreparingStep } from './preparing-steps.js';
import {
  acceptQueuedMessage,
  assignPreparationAttemptId,
  cancelActiveMessages,
  failWaitingMessages as applyFailWaitingMessages,
  failedMessageSnapshot,
  hasAcceptedMessage,
  hasInterruptibleWork,
  incrementAttachFailure,
  incrementPromptFailure,
  isAttachExhausted,
  isPromptExhausted,
  nextQueuedMessageId,
  recordAcceptedMessageActivity,
  streamCloudStatus,
  streamQueuedSnapshots,
  terminalizeAcceptedMessages,
  userTurnTerminalState,
  type SessionMessageRecord,
} from './session-message-queue.js';

const METADATA_KEY = 'session_metadata';
const MESSAGES_KEY = 'session_messages';
const QUEUE_RETRY_MS = 5_000;

type MessageRecord = SessionMessageRecord;

export class SandboxSession extends DurableObject<Env> {
  private readonly sessionId: SessionId | undefined;
  private readonly eventQueries: EventQueries;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const doName = ctx.id.name;
    const lastColon = doName?.lastIndexOf(':') ?? -1;
    const sessionIdPart = doName && lastColon > 0 ? doName.slice(lastColon + 1) : undefined;
    this.sessionId = sessionIdPart ? (sessionIdPart as SessionId) : undefined;
    const db = drizzle(ctx.storage, { logger: false });
    this.eventQueries = createEventQueries(db, ctx.storage.sql);
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(db, migrations);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const sessionId = this.requireSessionId();
    const handler = createStreamHandler(this.ctx, this.eventQueries, sessionId, {
      deriveCloudStatus: () => this.deriveCloudStatus(),
      deriveQueuedMessages: () => this.deriveQueuedMessages(),
    });
    return handler.handleStreamRequest(request);
  }

  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {}

  async webSocketClose(
    _ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ): Promise<void> {}

  async receiveSandboxControlEvent(input: {
    identity: { directory: string; kiloSessionId?: string; rootKiloSessionId?: string };
    payload: { type: string; properties: Record<string, unknown>; timestamp?: string };
  }): Promise<{ applied: boolean }> {
    const metadata = await this.getMetadata();
    if (!metadata) {
      logger
        .withFields({
          sessionId: this.sessionId,
          eventType: input.payload.type,
        })
        .warn('receiveSandboxControlEvent rejected; session metadata missing');
      return { applied: false };
    }
    const root = metadata.auth.kiloSessionId;
    if (
      input.identity.rootKiloSessionId !== undefined &&
      root !== undefined &&
      input.identity.rootKiloSessionId !== root
    ) {
      logger
        .withFields({
          sessionId: this.sessionId,
          eventType: input.payload.type,
          rootKiloSessionId: input.identity.rootKiloSessionId,
          expectedRootKiloSessionId: root,
        })
        .warn('receiveSandboxControlEvent rejected; kilo session mismatch');
      return { applied: false };
    }
    const sessionId = this.requireSessionId();
    persistSandboxControlSessionEvent({
      sessionId,
      payload: input.payload,
      eventQueries: this.eventQueries,
      broadcast: event => this.broadcastStoredEvent(event),
    });
    const terminal = userTurnTerminalState(input.payload.type);
    if (!terminal) {
      const activeMessages = recordAcceptedMessageActivity(await this.loadMessages(), Date.now());
      if (activeMessages) await this.saveMessages(activeMessages);
    }
    const ingestItems = controlEventToIngestItems(input.payload.type, input.payload.properties);
    const eventKiloSessionId = ingestKiloSessionId(input.payload.type, input.payload.properties);
    const rootKiloSessionId = metadata.auth.kiloSessionId;
    const token = metadata.auth.kilocodeToken;
    if (ingestItems.length > 0 && rootKiloSessionId && token && this.env.SESSION_INGEST) {
      const isChild = eventKiloSessionId !== undefined && eventKiloSessionId !== rootKiloSessionId;
      let internalSecret: string | undefined;
      if (isChild) {
        try {
          internalSecret = await this.env.INTERNAL_API_SECRET_PROD.get();
        } catch {
          internalSecret = undefined;
        }
        if (!internalSecret) {
          logger
            .withFields({
              sessionId: this.sessionId,
              rootKiloSessionId,
              eventKiloSessionId,
            })
            .warn('Control-plane child session ingest skipped; internal secret unavailable');
        }
      }
      if (!isChild || internalSecret) {
        this.ctx.waitUntil(
          publishControlPlaneSessionIngest({
            fetchIngest: request => this.env.SESSION_INGEST.fetch(request),
            token,
            rootKiloSessionId,
            eventKiloSessionId,
            cloudAgentSessionId: metadata.identity.sessionId,
            ...(internalSecret ? { internalSecret } : {}),
            items: ingestItems,
          })
        );
      }
    }
    if (terminal) {
      const before = await this.loadMessages();
      if (hasAcceptedMessage(before)) {
        await this.saveMessages(terminalizeAcceptedMessages(before, terminal));
        this.broadcastClientEvent(terminal === 'failed' ? 'error' : 'complete');
        const nextId = nextQueuedMessageId(await this.loadMessages());
        if (nextId) this.ctx.waitUntil(this.dispatchQueued(nextId));
      }
    }
    return { applied: true };
  }

  async receiveSandboxControlPreparing(input: {
    identity: SessionEventIdentity;
    payload: SessionPreparingPayload;
  }): Promise<{ applied: boolean }> {
    const metadata = await this.getMetadata();
    if (!metadata) return { applied: false };
    const root = metadata.auth.kiloSessionId;
    if (
      input.identity.rootKiloSessionId !== undefined &&
      root !== undefined &&
      input.identity.rootKiloSessionId !== root
    ) {
      return { applied: false };
    }
    const sessionId = this.requireSessionId();
    applyControlPlanePreparingEvent({
      sessionId,
      data: input.payload,
      eventQueries: this.eventQueries,
      broadcast: event => this.broadcastStoredEvent(event),
    });
    return { applied: true };
  }

  async closeOrgStreams(_organizationId: string): Promise<number> {
    const sockets = this.ctx.getWebSockets('stream');
    for (const ws of sockets) ws.close(1001, 'organization streams closed');
    return sockets.length;
  }

  async getMetadata(): Promise<SessionMetadata | null> {
    const raw = await this.ctx.storage.get<unknown>(METADATA_KEY);
    if (raw === undefined) return null;
    try {
      return parseSessionMetadata(raw);
    } catch {
      return null;
    }
  }

  async validateKiloGlobalFeedProducer(_params: {
    kiloSessionId: string;
    wrapperRunId: string;
    wrapperGeneration: number;
    wrapperConnectionId: string;
  }): Promise<{ success: false; status: number; message: string }> {
    return { success: false, status: 404, message: 'Not found' };
  }

  async getLatestAssistantMessage(): Promise<LatestAssistantMessage | null> {
    const metadata = await this.getMetadata();
    const sessionId = this.sessionId;
    if (!metadata?.auth.kiloSessionId || !sessionId) return null;
    return this.eventQueries.getLatestAssistantMessage(sessionId, metadata.auth.kiloSessionId);
  }

  async getLatestEventId(): Promise<number | null> {
    return this.eventQueries.getLatestEventId();
  }

  async getMessageResult(messageId: string): Promise<MessageResultRPCResponse> {
    if (!(await this.getMetadata())) return { type: 'session-not-found' };
    const record = (await this.loadMessages()).find(message => message.messageId === messageId);
    if (!record) return { type: 'message-not-found' };
    const status =
      record.state === 'queued'
        ? 'queued'
        : record.state === 'accepted'
          ? 'running'
          : record.state === 'cancelled'
            ? 'interrupted'
            : record.state;
    return {
      type: 'found',
      result: {
        messageId: record.messageId,
        status,
        createdAt: record.acceptedAt ?? 0,
        cloudAgentSessionId: this.requireSessionId(),
      },
    };
  }

  async markAsInterrupted(): Promise<void> {
    const { messages } = cancelActiveMessages(await this.loadMessages());
    await this.saveMessages(messages);
  }

  async interruptExecution(): Promise<{ success: boolean; message?: string }> {
    const before = await this.loadMessages();
    const hadWork = hasInterruptibleWork(before);
    const { messages } = cancelActiveMessages(before);
    await this.saveMessages(messages);
    if (hadWork) {
      this.broadcastClientEvent('interrupted', { reason: 'interrupted' });
    }
    const metadata = await this.getMetadata();
    const sandboxId = metadata?.workspace?.sandboxId;
    const kiloSessionId = metadata?.auth.kiloSessionId;
    if (sandboxId && kiloSessionId && this.sessionId) {
      try {
        await sandboxControlRpc(this.env, sandboxId).request({
          operation: 'session.abort',
          session: {
            sessionId: this.sessionId,
            kiloSessionId,
            directory: this.directory(metadata),
          },
          payload: {},
        });
      } catch (error) {
        logger
          .withFields({
            error: error instanceof Error ? error.message : 'abort failed',
          })
          .warn('session.abort failed');
      }
    }
    return { success: hadWork, ...(hadWork ? {} : { message: 'No session work to interrupt' }) };
  }

  async answerPermission(input: {
    permissionId: string;
    response: 'once' | 'always' | 'reject';
  }): Promise<{ success: boolean }> {
    return this.requestSessionOperation('session.permission.resolve', {
      permissionId: input.permissionId,
      response: input.response,
    });
  }

  async answerQuestion(input: {
    questionId: string;
    answers: string[][];
  }): Promise<{ success: boolean }> {
    return this.requestSessionOperation('session.question.resolve', {
      action: 'answer',
      questionId: input.questionId,
      answers: input.answers,
    });
  }

  async rejectQuestion(input: { questionId: string }): Promise<{ success: boolean }> {
    return this.requestSessionOperation('session.question.resolve', {
      action: 'reject',
      questionId: input.questionId,
    });
  }

  async createTerminal(_input?: {
    cols?: number;
    rows?: number;
  }): Promise<OperationResult<{ pty: WrapperPty }>> {
    return { success: false, error: 'Terminal is not available for this session' };
  }

  async resizeTerminal(_input?: {
    ptyId?: string;
    cols?: number;
    rows?: number;
  }): Promise<OperationResult<{ pty: WrapperPty }>> {
    return { success: false, error: 'Terminal is not available for this session' };
  }

  async closeTerminal(_input?: { ptyId?: string }): Promise<OperationResult<{ success: boolean }>> {
    return { success: false, error: 'Terminal is not available for this session' };
  }

  async isSandboxCleanupScheduled(): Promise<boolean> {
    return false;
  }

  async deleteSession(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  async registerSession(input: {
    identity: SessionMetadata['identity'];
    auth: SessionMetadata['auth'];
    agent: SessionMetadata['agent'];
    repository?: SessionMetadata['repository'];
    workspace?: SessionMetadata['workspace'];
    callback?: SessionMetadata['callback'];
    profile?: SessionMetadata['profile'];
    finalization?: SessionMetadata['finalization'];
  }): Promise<OperationResult> {
    if (await this.getMetadata()) return { success: true };
    const metadata = parseSessionMetadata({
      metadataSchemaVersion: 2,
      identity: input.identity,
      auth: input.auth,
      agent: input.agent,
      ...(input.repository ? { repository: input.repository } : {}),
      workspace: input.workspace ?? {},
      ...(input.callback ? { callback: input.callback } : {}),
      ...(input.profile ? { profile: input.profile } : {}),
      ...(input.finalization ? { finalization: input.finalization } : {}),
      lifecycle: { version: 1, timestamp: Date.now() },
    });
    await this.ctx.storage.put(METADATA_KEY, serializeSessionMetadata(metadata));
    return { success: true };
  }

  async createSessionWithInitialAdmission(input: {
    identity: SessionMetadata['identity'];
    auth: SessionMetadata['auth'];
    agent: SessionMetadata['agent'];
    repository?: SessionMetadata['repository'];
    workspace?: SessionMetadata['workspace'];
    callback?: SessionMetadata['callback'];
    profile?: SessionMetadata['profile'];
    finalization?: SessionMetadata['finalization'];
    message: { initialTurn: { messageId: string; type: string } };
  }): Promise<SessionMessageAdmissionResult> {
    const registered = await this.registerSession(input);
    if (!registered.success) {
      return { success: false, code: 'INTERNAL', error: registered.error ?? 'register failed' };
    }
    const initial = input.message.initialTurn as { messageId: string; prompt?: string };
    return this.queueAndDispatch(initial.messageId, initial.prompt);
  }

  async tryUpdate(updates: { callbackTarget?: CallbackTarget | null }): Promise<OperationResult> {
    const metadata = await this.getMetadata();
    if (!metadata) return { success: false, error: 'Session not found' };
    const next = {
      ...metadata,
      callback:
        updates.callbackTarget === undefined
          ? metadata.callback
          : updates.callbackTarget === null
            ? undefined
            : { target: updates.callbackTarget },
    };
    await this.ctx.storage.put(METADATA_KEY, serializeSessionMetadata(next));
    return { success: true };
  }

  async getCurrentMessageWork(): Promise<{
    messageId: string;
    status: 'pending' | 'running';
    health: 'healthy' | 'stale';
  } | null> {
    const messages = await this.loadMessages();
    const accepted = messages.find(message => message.state === 'accepted');
    if (accepted) return { messageId: accepted.messageId, status: 'running', health: 'healthy' };
    const queued = messages.find(message => message.state === 'queued');
    if (queued) return { messageId: queued.messageId, status: 'pending', health: 'healthy' };
    return null;
  }

  async hasMessageAdmission(messageId: string): Promise<boolean> {
    return (await this.loadMessages()).some(message => message.messageId === messageId);
  }

  async admitSubmittedMessage(
    request: SubmittedSessionMessageRequest
  ): Promise<SessionMessageAdmissionResult> {
    const messageId = request.turn.id ?? createMessageId();
    const prompt =
      'prompt' in request.turn && typeof request.turn.prompt === 'string'
        ? request.turn.prompt
        : undefined;
    return this.queueAndDispatch(messageId, prompt);
  }

  async replayPreparedInitialMessage(
    _request: LegacyRegisteredInitialAdmissionRequest
  ): Promise<SessionMessageAdmissionResult | undefined> {
    return undefined;
  }

  async admitPreparedInitialMessage(
    _request: LegacyRegisteredInitialAdmissionRequest
  ): Promise<SessionMessageAdmissionResult> {
    return { success: false, code: 'BAD_REQUEST', error: 'Prepared admission is legacy-only' };
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const messages = await this.loadMessages();
    const accepted = messages.find(
      message => message.state === 'accepted' && message.acceptedAt !== undefined
    );
    if (accepted?.acceptedAt !== undefined) {
      const decision = acceptedAlarmDecision(accepted.acceptedAt, now, accepted.lastActivityAt);
      if (decision.action === 'fail') {
        await this.failWaitingMessages('accepted_overdue');
        return;
      }
      await this.ctx.storage.setAlarm(decision.at);
      return;
    }
    const queued = messages.filter(message => message.state === 'queued');
    for (const message of queued) {
      await this.dispatchQueued(message.messageId, { allowCreate: false });
    }
  }

  private async queueAndDispatch(
    messageId: string,
    prompt?: string
  ): Promise<SessionMessageAdmissionResult> {
    const messages = await this.loadMessages();
    const existing = messages.find(message => message.messageId === messageId);
    if (existing) {
      return { success: true, outcome: 'queued', messageId, compatibilityDelivery: 'queued' };
    }
    messages.push({ messageId, state: 'queued', ...(prompt ? { prompt } : {}) });
    await this.saveMessages(messages);
    this.broadcastQueuedMessage(messageId, prompt ?? '');
    if (nextQueuedMessageId(messages) === messageId) {
      this.ctx.waitUntil(this.dispatchQueued(messageId, { allowCreate: true }));
    }
    return { success: true, outcome: 'queued', messageId, compatibilityDelivery: 'queued' };
  }

  private async dispatchQueued(
    messageId: string,
    options?: { allowCreate?: boolean }
  ): Promise<void> {
    const allowCreate = options?.allowCreate === true;
    const metadata = await this.getMetadata();
    const sandboxId = metadata?.workspace?.sandboxId;
    const kiloSessionId = metadata?.auth.kiloSessionId;
    const sessionId = this.sessionId;
    if (!metadata || !sandboxId || !kiloSessionId || !sessionId) {
      await this.failWaitingMessages('missing_metadata');
      return;
    }
    const messages = await this.loadMessages();
    if (nextQueuedMessageId(messages) !== messageId) return;
    const assigned = assignPreparationAttemptId(messages, messageId, () => crypto.randomUUID());
    if (!assigned) return;
    if (assigned.messages !== messages) await this.saveMessages(assigned.messages);
    const queued = assigned.messages.find(message => message.messageId === messageId);
    const control = sandboxControlRpc(this.env, sandboxId);
    const recorder = createPreparationProgressRecorder({
      attemptId: assigned.attemptId,
      triggerMessageId: messageId,
      sessionId,
      eventQueries: this.eventQueries,
      broadcast: event => this.broadcastStoredEvent(event),
    });
    for (const event of finalizeOtherRunningAttemptsForMessage(
      this.eventQueries,
      messageId,
      assigned.attemptId,
      Date.now()
    )) {
      this.broadcastStoredEvent(event);
    }
    let delivery: 'attach' | 'prompt' | undefined;
    try {
      const session = {
        sessionId,
        kiloSessionId,
        directory: this.directory(metadata),
      };
      let before = await control.getStatus();
      const stoppingDeadline = Date.now() + DEADLINE_MS.startup;
      let status: Awaited<ReturnType<typeof control.getStatus>>;
      while (true) {
        if (allowCreate && before.physical === 'stopping') {
          const observed = await observeControlAfterStopping(before, () => control.getStatus(), {
            retryMs: QUEUE_RETRY_MS,
            deadline: stoppingDeadline,
          });
          if (!observed) {
            recorder.finalize({ status: 'failed', safeError: 'Environment failed' });
            await this.failWaitingMessages('environment_failed');
            return;
          }
          if (nextQueuedMessageId(await this.loadMessages()) !== messageId) return;
          before = observed;
        }
        const provision = provisionPreparingStep(before.physical, allowCreate);
        if (provision) recorder.onProgress(provision.step, provision.message);
        status = await control.ensureReady({
          ownerId: metadata.identity.userId,
          provider: getSandboxProvider(metadata),
          allowCreate,
          ...(metadata.auth.kilocodeToken ? { kiloToken: metadata.auth.kilocodeToken } : {}),
        });
        if (!allowCreate || status.physical !== 'stopping') break;
        before = status;
      }
      const boot = bootPreparingStep(status.physical, status.connection);
      if (boot) recorder.onProgress(boot.step, boot.message);
      const disposition = controlDispatchDisposition(status);
      if (disposition === 'fail') {
        const reason = failureReasonFromControlStatus(status.physical) ?? 'environment_failed';
        recorder.finalize({ status: 'failed', safeError: safeErrorFromQueueReason(reason) });
        logger
          .withFields({
            sessionId,
            messageId,
            connection: status.connection,
            physical: status.physical,
          })
          .warn('Control-plane sandbox failed; waiting messages terminalized');
        await this.failWaitingMessages(reason);
        return;
      }
      if (disposition === 'wait') {
        logger
          .withFields({
            sessionId,
            messageId,
            connection: status.connection,
            physical: status.physical,
          })
          .warn('Control-plane not ready; message stays queued');
        if (status.physical === 'creating' || status.physical === 'running') {
          await this.armQueueRetry();
        }
        return;
      }
      await control.attachSession({
        sessionId,
        kiloSessionId,
        directory: session.directory,
        ownerId: metadata.identity.userId,
      });
      recorder.onProgress('workspace_setup', 'Setting up workspace…');
      delivery = 'attach';
      const attached = await control.request({
        operation: 'session.attach',
        session,
        payload: await fillAttachGitToken(
          metadata,
          buildSessionAttachPayload(metadata, {
            attemptId: recorder.attemptId,
            triggerMessageId: messageId,
          }),
          this.env
        ),
        timeoutMs: SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
      });
      if (!attached.ok) {
        recorder.finalize({ status: 'failed', safeError: 'Environment preparation failed' });
        logger
          .withFields({
            sessionId,
            messageId,
            error: attached.error?.message ?? 'session.attach failed',
          })
          .warn('Control-plane attach rejected');
        await this.recordDeliveryFailure(messageId, 'attach');
        return;
      }
      recorder.finalize({ status: 'completed' });
      if (nextQueuedMessageId(await this.loadMessages()) !== messageId) return;
      delivery = 'prompt';
      const response = await control.request({
        operation: 'session.prompt',
        session,
        payload: {
          messageId,
          turn: { type: 'prompt', prompt: queued?.prompt ?? '' },
          agent: {
            mode: metadata.agent?.mode ?? 'code',
            model: metadata.agent?.model ?? 'default',
            ...(metadata.agent?.variant ? { variant: metadata.agent.variant } : {}),
          },
        },
      });
      if (response.ok) {
        const accepted = acceptQueuedMessage(await this.loadMessages(), messageId, Date.now());
        if (!accepted) return;
        await this.saveMessages(accepted);
        await this.ctx.storage.setAlarm(Date.now() + DEADLINE_MS.acceptedAlarmCap);
      } else {
        await this.recordDeliveryFailure(messageId, 'prompt');
      }
    } catch (error) {
      recorder.finalize({ status: 'failed', safeError: 'Environment preparation failed' });
      logger
        .withFields({
          sessionId,
          messageId,
          error: error instanceof Error ? error.message : 'dispatch failed',
        })
        .warn('Control-plane dispatch failed; message stays queued');
      if (delivery === 'attach' || delivery === 'prompt') {
        await this.recordDeliveryFailure(messageId, delivery);
        return;
      }
      await this.armQueueRetry();
    }
  }

  private async recordDeliveryFailure(messageId: string, kind: 'attach' | 'prompt'): Promise<void> {
    const updated =
      kind === 'attach'
        ? incrementAttachFailure(await this.loadMessages(), messageId)
        : incrementPromptFailure(await this.loadMessages(), messageId);
    await this.saveMessages(updated.messages);
    const exhausted =
      kind === 'attach' ? isAttachExhausted(updated.failures) : isPromptExhausted(updated.failures);
    if (exhausted) {
      await this.failWaitingMessages(kind === 'attach' ? 'attach_exhausted' : 'prompt_exhausted');
      return;
    }
    await this.armQueueRetry();
  }

  async failWaitingMessages(reason: string): Promise<void> {
    const { messages, failedIds } = applyFailWaitingMessages(await this.loadMessages(), reason);
    if (failedIds.length === 0) return;
    await this.saveMessages(messages);
    const now = Date.now();
    const safeError = safeErrorFromQueueReason(reason);
    for (const messageId of failedIds) {
      const record = messages.find(message => message.messageId === messageId);
      if (!record) continue;
      if (record.preparationAttemptId) {
        for (const event of finalizePreparationAttempt(
          this.eventQueries,
          record.preparationAttemptId,
          { status: 'failed', safeError, timestamp: now }
        )) {
          this.broadcastStoredEvent(event);
        }
      }
      this.broadcastMessageFailed(record, now);
    }
  }

  private broadcastMessageFailed(message: SessionMessageRecord, now: number): void {
    const sessionId = this.requireSessionId();
    const payload = JSON.stringify(failedMessageSnapshot(message, now));
    const eventId = this.eventQueries.insert({
      executionId: '',
      sessionId,
      streamEventType: 'cloud.message.failed',
      payload,
      timestamp: now,
    });
    createStreamHandler(this.ctx, this.eventQueries, sessionId).broadcastEvent({
      id: eventId,
      execution_id: '',
      session_id: sessionId,
      stream_event_type: 'cloud.message.failed',
      payload,
      timestamp: now,
    });
  }

  private broadcastStoredEvent(event: StoredEvent): void {
    const sessionId = this.requireSessionId();
    createStreamHandler(this.ctx, this.eventQueries, sessionId).broadcastEvent(event);
  }

  private async armQueueRetry(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    const when = Date.now() + QUEUE_RETRY_MS;
    if (existing === null || existing > when) {
      await this.ctx.storage.setAlarm(when);
    }
  }

  private async deriveQueuedMessages() {
    return streamQueuedSnapshots(await this.loadMessages(), Date.now());
  }

  private async deriveCloudStatus() {
    return streamCloudStatus(await this.loadMessages());
  }

  private async requestSessionOperation(
    operation: 'session.permission.resolve' | 'session.question.resolve',
    payload: unknown
  ): Promise<{ success: boolean }> {
    const metadata = await this.getMetadata();
    const sandboxId = metadata?.workspace?.sandboxId;
    const kiloSessionId = metadata?.auth.kiloSessionId;
    const sessionId = this.sessionId;
    if (!metadata || !sandboxId || !kiloSessionId || !sessionId) {
      throw new Error('No wrapper found for session');
    }
    const response = await sandboxControlRpc(this.env, sandboxId).request({
      operation,
      session: {
        sessionId,
        kiloSessionId,
        directory: this.directory(metadata),
      },
      payload,
    });
    if (!response.ok) {
      throw new Error(response.error?.message ?? 'Control request failed');
    }
    return { success: true };
  }

  private directory(metadata: SessionMetadata): string {
    return (
      buildSessionAttachPayload(metadata).directory ??
      metadata.workspace?.workspacePath ??
      `/workspace/${metadata.identity.sessionId}`
    );
  }

  private broadcastQueuedMessage(messageId: string, content: string): void {
    const sessionId = this.requireSessionId();
    createStreamHandler(this.ctx, this.eventQueries, sessionId).broadcastEvent({
      id: 0,
      execution_id: '',
      session_id: sessionId,
      stream_event_type: 'cloud.message.queued',
      payload: JSON.stringify({ messageId, content, delivery: 'queued' }),
      timestamp: Date.now(),
    });
  }

  private broadcastClientEvent(
    streamEventType: 'interrupted' | 'complete' | 'error',
    data: Record<string, unknown> = {}
  ): void {
    const sessionId = this.requireSessionId();
    const timestamp = Date.now();
    const payload = JSON.stringify(data);
    const eventId = this.eventQueries.insert({
      executionId: '',
      sessionId,
      streamEventType,
      payload,
      timestamp,
    });
    createStreamHandler(this.ctx, this.eventQueries, sessionId).broadcastEvent({
      id: eventId,
      execution_id: '',
      session_id: sessionId,
      stream_event_type: streamEventType,
      payload,
      timestamp,
    });
  }

  private async loadMessages(): Promise<MessageRecord[]> {
    return (await this.ctx.storage.get<MessageRecord[]>(MESSAGES_KEY)) ?? [];
  }

  private async saveMessages(messages: MessageRecord[]): Promise<void> {
    await this.ctx.storage.put(MESSAGES_KEY, messages);
  }

  private requireSessionId(): SessionId {
    if (!this.sessionId) throw new Error('SandboxSession is missing session id');
    return this.sessionId;
  }
}
