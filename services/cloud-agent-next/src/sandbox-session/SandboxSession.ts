import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import migrations from '../../drizzle/migrations';
import type { Env } from '../types.js';
import type { SessionId } from '../types/ids.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import {
  getSandboxProvider,
  parseSessionMetadata,
  serializeSessionMetadata,
} from '../persistence/session-metadata.js';
import type { OperationResult } from '../persistence/types.js';
import type { CallbackTarget } from '../callbacks/index.js';
import {
  renderExecutionTurnContent,
  type AcceptedExecutionTurn,
  type LegacyRegisteredInitialAdmissionRequest,
  type SessionMessageAdmissionResult,
  type SubmittedSessionMessageRequest,
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
import { createSandboxTerminalBridge, type SandboxTerminalRecord } from './terminal-bridge.js';
import {
  createSandboxTerminalLifecycle,
  SANDBOX_SESSION_METADATA_KEY,
} from './terminal-lifecycle.js';
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

const METADATA_KEY = SANDBOX_SESSION_METADATA_KEY;
const MESSAGES_KEY = 'session_messages';
const QUEUE_RETRY_MS = 5_000;

type MessageRecord = SessionMessageRecord;

export class SandboxSession extends DurableObject<Env> {
  private readonly sessionId: SessionId | undefined;
  private readonly eventQueries: EventQueries;
  private readonly terminalLifecycle: ReturnType<typeof createSandboxTerminalLifecycle>;
  private readonly terminalBridge: ReturnType<typeof createSandboxTerminalBridge>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const doName = ctx.id.name;
    const lastColon = doName?.lastIndexOf(':') ?? -1;
    const sessionIdPart = doName && lastColon > 0 ? doName.slice(lastColon + 1) : undefined;
    this.sessionId = sessionIdPart ? (sessionIdPart as SessionId) : undefined;
    this.terminalLifecycle = createSandboxTerminalLifecycle({
      state: ctx,
      getSessionId: () => this.requireSessionId(),
      getControl: sandboxId => sandboxControlRpc(env, sandboxId),
      getDirectory: metadata => this.directory(metadata),
      closeTerminalBridge: (ptyId, code, reason) =>
        this.terminalBridge.closeTerminal(ptyId, code, reason),
      closeAllBridges: (code, reason) => this.terminalBridge.closeAll(code, reason),
      closeRuntimeBridges: (wrapperInstanceId, code, reason) =>
        this.terminalBridge.closeRuntime(wrapperInstanceId, code, reason),
    });
    this.terminalBridge = createSandboxTerminalBridge({
      state: ctx,
      getMetadata: () => this.getMetadata(),
      getTerminal: async (ptyId): Promise<SandboxTerminalRecord | undefined> =>
        this.terminalLifecycle.getTerminal(ptyId),
      requestConnect: async (record, payload) =>
        this.terminalLifecycle.requestConnect(record, payload),
      reportActivity: async record => this.terminalLifecycle.reportActivity(record),
      markEnded: async record => this.terminalLifecycle.markEnded(record),
    });
    const db = drizzle(ctx.storage, { logger: false });
    this.eventQueries = createEventQueries(db, ctx.storage.sql);
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(db, migrations);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/terminal/browser') {
      return this.terminalBridge.handleBrowserUpgrade(request);
    }
    if (pathname === '/terminal/wrapper') {
      return this.terminalBridge.handleWrapperUpgrade(request);
    }
    if (pathname !== '/stream' || this.terminalLifecycle.isBlocked()) {
      return new Response('Not found', { status: 404 });
    }
    const sessionId = this.requireSessionId();
    const handler = createStreamHandler(this.ctx, this.eventQueries, sessionId, {
      deriveCloudStatus: () => this.deriveCloudStatus(),
      deriveQueuedMessages: () => this.deriveQueuedMessages(),
    });
    return handler.handleStreamRequest(request);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.terminalBridge.handleMessage(ws, message);
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    await this.terminalBridge.handleClose(ws, code, reason, wasClean);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    await this.terminalBridge.handleError(ws, error);
  }

  async receiveSandboxControlEvent(input: {
    identity: { directory: string; kiloSessionId?: string; rootKiloSessionId?: string };
    payload: { type: string; properties: Record<string, unknown>; timestamp?: string };
  }): Promise<{ applied: boolean }> {
    const metadata = await this.getMetadata();
    const epoch = this.terminalLifecycle.captureEpoch();
    if (!metadata || epoch === null) {
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
    const eventKiloSessionId =
      input.identity.kiloSessionId ??
      ingestKiloSessionId(input.payload.type, input.payload.properties);
    const terminal = userTurnTerminalState(input.payload.type, eventKiloSessionId, root);
    if (!terminal) {
      const activeMessages = recordAcceptedMessageActivity(await this.loadMessages(), Date.now());
      if (activeMessages) await this.saveMessages(activeMessages);
    }
    const ingestItems = controlEventToIngestItems(input.payload.type, input.payload.properties);
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
        if (!this.terminalLifecycle.isCurrent(epoch)) return { applied: false };
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
      if ((!isChild || internalSecret) && this.terminalLifecycle.isCurrent(epoch)) {
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
    if (!this.terminalLifecycle.isCurrent(epoch)) return { applied: false };
    if (terminal) {
      const before = await this.loadMessages();
      if (!this.terminalLifecycle.isCurrent(epoch)) return { applied: false };
      if (hasAcceptedMessage(before)) {
        if (!(await this.saveMessages(terminalizeAcceptedMessages(before, terminal), epoch))) {
          return { applied: false };
        }
        this.broadcastClientEvent(terminal === 'failed' ? 'error' : 'complete');
        const nextId = nextQueuedMessageId(await this.loadMessages());
        if (nextId && this.terminalLifecycle.isCurrent(epoch)) {
          this.ctx.waitUntil(this.dispatchQueued(nextId));
        }
      }
    }
    return { applied: true };
  }

  async receiveSandboxControlPreparing(input: {
    identity: SessionEventIdentity;
    payload: SessionPreparingPayload;
  }): Promise<{ applied: boolean }> {
    const metadata = await this.getMetadata();
    const epoch = this.terminalLifecycle.captureEpoch();
    if (!metadata || epoch === null) return { applied: false };
    const root = metadata.auth.kiloSessionId;
    if (
      input.identity.rootKiloSessionId !== undefined &&
      root !== undefined &&
      input.identity.rootKiloSessionId !== root
    ) {
      return { applied: false };
    }
    if (!this.terminalLifecycle.isCurrent(epoch)) return { applied: false };
    const sessionId = this.requireSessionId();
    applyControlPlanePreparingEvent({
      sessionId,
      data: input.payload,
      eventQueries: this.eventQueries,
      broadcast: event => this.broadcastStoredEvent(event),
    });
    return { applied: true };
  }

  async closeOrgStreams(organizationId: string): Promise<number> {
    const metadata = this.terminalLifecycle.getStoredMetadata();
    if (!metadata?.identity.orgId || metadata.identity.orgId !== organizationId) return 0;
    const records = this.terminalLifecycle.beginRevocation(metadata);
    const sockets = this.ctx.getWebSockets('stream');
    for (const ws of sockets) ws.close(1000, 'session access revoked');
    await this.terminalLifecycle.cleanupSession(metadata, records);
    return sockets.length;
  }

  async getMetadata(): Promise<SessionMetadata | null> {
    return this.terminalLifecycle.isDeleted() ? null : this.terminalLifecycle.getStoredMetadata();
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
    const epoch = this.terminalLifecycle.captureEpoch();
    if (epoch === null) return;
    const { messages } = cancelActiveMessages(await this.loadMessages());
    await this.saveMessages(messages, epoch);
  }

  async interruptExecution(): Promise<{ success: boolean; message?: string }> {
    const epoch = this.terminalLifecycle.captureEpoch();
    if (epoch === null) return { success: false, message: 'Session not found' };
    const before = await this.loadMessages();
    if (!this.terminalLifecycle.isCurrent(epoch)) {
      return { success: false, message: 'Session not found' };
    }
    const hadWork = hasInterruptibleWork(before);
    const { messages } = cancelActiveMessages(before);
    if (!(await this.saveMessages(messages, epoch))) {
      return { success: false, message: 'Session not found' };
    }
    if (hadWork) {
      this.broadcastClientEvent('interrupted', { reason: 'interrupted' });
    }
    const metadata = await this.getMetadata();
    const sandboxId = metadata?.workspace?.sandboxId;
    const kiloSessionId = metadata?.auth.kiloSessionId;
    if (sandboxId && kiloSessionId && this.sessionId && this.terminalLifecycle.isCurrent(epoch)) {
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
        if (this.terminalLifecycle.isCurrent(epoch)) {
          logger
            .withFields({
              error: error instanceof Error ? error.message : 'abort failed',
            })
            .warn('session.abort failed');
        }
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

  async createTerminal(input?: {
    cols?: number;
    rows?: number;
    operationId?: string;
  }): Promise<OperationResult<{ pty: WrapperPty }>> {
    return this.terminalLifecycle.createTerminal(input);
  }

  async resizeTerminal(input?: {
    ptyId?: string;
    cols?: number;
    rows?: number;
  }): Promise<OperationResult<{ pty: WrapperPty }>> {
    return this.terminalLifecycle.resizeTerminal(input);
  }

  async closeTerminal(input?: { ptyId?: string }): Promise<OperationResult<{ success: boolean }>> {
    return this.terminalLifecycle.closeTerminal(input);
  }

  async invalidateTerminalRuntime(input: {
    sandboxId: string;
    wrapperInstanceId: string;
    confirmed: boolean;
  }): Promise<void> {
    this.terminalLifecycle.invalidateRuntime(input);
  }

  async isSandboxCleanupScheduled(): Promise<boolean> {
    return false;
  }

  async deleteSession(): Promise<void> {
    await this.interruptExecution();
    const metadata = this.terminalLifecycle.getStoredMetadata();
    const records = this.terminalLifecycle.beginDeletion(metadata);
    for (const ws of this.ctx.getWebSockets('stream')) {
      ws.close(1000, 'session access revoked');
    }
    await this.terminalLifecycle.cleanupSession(metadata, records);
    await this.ctx.storage.deleteAlarm();
    this.ctx.storage.transactionSync(() => {
      this.eventQueries.deleteOlderThan(Number.MAX_SAFE_INTEGER);
      this.terminalLifecycle.purgeDeletedState();
    });
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
    if (this.terminalLifecycle.isBlocked()) return { success: false, error: 'Session not found' };
    if (this.terminalLifecycle.getStoredMetadata()) return { success: true };
    const repository =
      input.repository &&
      'branch' in input.repository &&
      typeof input.repository.branch === 'string'
        ? {
            ...input.repository,
            upstreamBranch: input.repository.upstreamBranch ?? input.repository.branch,
          }
        : input.repository;
    const metadata = parseSessionMetadata({
      metadataSchemaVersion: 2,
      identity: input.identity,
      auth: input.auth,
      agent: input.agent,
      ...(repository ? { repository } : {}),
      workspace: input.workspace ?? {},
      ...(input.callback ? { callback: input.callback } : {}),
      ...(input.profile ? { profile: input.profile } : {}),
      ...(input.finalization ? { finalization: input.finalization } : {}),
      lifecycle: { version: 1, timestamp: Date.now() },
    });
    if (this.terminalLifecycle.isBlocked()) return { success: false, error: 'Session not found' };
    this.ctx.storage.kv.put(METADATA_KEY, serializeSessionMetadata(metadata));
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
    message: { initialTurn: AcceptedExecutionTurn };
  }): Promise<SessionMessageAdmissionResult> {
    const registered = await this.registerSession(input);
    if (!registered.success) {
      return {
        success: false,
        code: registered.error === 'Session not found' ? 'NOT_FOUND' : 'INTERNAL',
        error: registered.error ?? 'register failed',
      };
    }
    return this.queueAndDispatch(input.message.initialTurn);
  }

  async tryUpdate(updates: { callbackTarget?: CallbackTarget | null }): Promise<OperationResult> {
    const metadata = await this.getMetadata();
    const epoch = this.terminalLifecycle.captureEpoch();
    if (!metadata || epoch === null) return { success: false, error: 'Session not found' };
    const next = {
      ...metadata,
      callback:
        updates.callbackTarget === undefined
          ? metadata.callback
          : updates.callbackTarget === null
            ? undefined
            : { target: updates.callbackTarget },
    };
    if (!this.terminalLifecycle.isCurrent(epoch)) {
      return { success: false, error: 'Session not found' };
    }
    this.ctx.storage.kv.put(METADATA_KEY, serializeSessionMetadata(next));
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
    const turn: AcceptedExecutionTurn =
      request.turn.type === 'prompt'
        ? {
            type: 'prompt',
            messageId,
            prompt: request.turn.prompt,
            ...(request.turn.attachments ? { attachments: request.turn.attachments } : {}),
          }
        : {
            type: 'command',
            messageId,
            command: request.turn.command,
            arguments: request.turn.arguments,
          };
    return this.queueAndDispatch(turn);
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
    const epoch = this.terminalLifecycle.captureEpoch();
    if (epoch === null) return;
    const now = Date.now();
    const messages = await this.loadMessages();
    if (!this.terminalLifecycle.isCurrent(epoch)) return;
    const accepted = messages.find(
      message => message.state === 'accepted' && message.acceptedAt !== undefined
    );
    if (accepted?.acceptedAt !== undefined) {
      const decision = acceptedAlarmDecision(accepted.acceptedAt, now, accepted.lastActivityAt);
      if (decision.action === 'fail') {
        await this.failWaitingMessages('accepted_overdue');
        return;
      }
      if (this.terminalLifecycle.isCurrent(epoch)) {
        await this.ctx.storage.setAlarm(decision.at);
      }
      return;
    }
    const queued = messages.filter(message => message.state === 'queued');
    for (const message of queued) {
      if (!this.terminalLifecycle.isCurrent(epoch)) return;
      await this.dispatchQueued(message.messageId, { allowCreate: false });
    }
  }

  private async queueAndDispatch(
    turn: AcceptedExecutionTurn
  ): Promise<SessionMessageAdmissionResult> {
    const epoch = this.terminalLifecycle.captureEpoch();
    if (epoch === null) return { success: false, code: 'NOT_FOUND', error: 'Session not found' };
    const messageId = turn.messageId;
    const messages = await this.loadMessages();
    if (!this.terminalLifecycle.isCurrent(epoch)) {
      return { success: false, code: 'NOT_FOUND', error: 'Session not found' };
    }
    const existing = messages.find(message => message.messageId === messageId);
    if (existing) {
      return { success: true, outcome: 'queued', messageId, compatibilityDelivery: 'queued' };
    }
    messages.push({ messageId, state: 'queued', turn });
    if (!(await this.saveMessages(messages, epoch))) {
      return { success: false, code: 'NOT_FOUND', error: 'Session not found' };
    }
    this.broadcastQueuedMessage(messageId, renderExecutionTurnContent(turn));
    if (nextQueuedMessageId(messages) === messageId && this.terminalLifecycle.isCurrent(epoch)) {
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
    const epoch = this.terminalLifecycle.captureEpoch();
    const sandboxId = metadata?.workspace?.sandboxId;
    const kiloSessionId = metadata?.auth.kiloSessionId;
    const sessionId = this.sessionId;
    if (!metadata || epoch === null || !sandboxId || !kiloSessionId || !sessionId) {
      if (!this.terminalLifecycle.isBlocked()) await this.failWaitingMessages('missing_metadata');
      return;
    }
    const messages = await this.loadMessages();
    if (!this.terminalLifecycle.isCurrent(epoch) || nextQueuedMessageId(messages) !== messageId) {
      return;
    }
    const assigned = assignPreparationAttemptId(messages, messageId, () => crypto.randomUUID());
    if (!assigned) return;
    if (assigned.messages !== messages && !(await this.saveMessages(assigned.messages, epoch))) {
      return;
    }
    if (!this.terminalLifecycle.isCurrent(epoch)) return;
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
    let routeAttached = false;
    try {
      const session = {
        sessionId,
        kiloSessionId,
        directory: this.directory(metadata),
      };
      if (!this.terminalLifecycle.isCurrent(epoch)) return;
      let before = await control.getStatus();
      const stoppingDeadline = Date.now() + DEADLINE_MS.startup;
      let status: Awaited<ReturnType<typeof control.getStatus>>;
      while (true) {
        if (!this.terminalLifecycle.isCurrent(epoch)) return;
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
          if (!this.terminalLifecycle.isCurrent(epoch)) return;
          if (nextQueuedMessageId(await this.loadMessages()) !== messageId) return;
          before = observed;
        }
        const provision = provisionPreparingStep(before.physical, allowCreate);
        if (provision) recorder.onProgress(provision.step, provision.message);
        if (!this.terminalLifecycle.isCurrent(epoch)) return;
        status = await control.ensureReady({
          ownerId: metadata.identity.userId,
          provider: getSandboxProvider(metadata),
          allowCreate,
          ...(metadata.auth.kilocodeToken ? { kiloToken: metadata.auth.kilocodeToken } : {}),
        });
        if (!this.terminalLifecycle.isCurrent(epoch)) return;
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
      if (!this.terminalLifecycle.isCurrent(epoch)) return;
      routeAttached = true;
      await control.attachSession({
        sessionId,
        kiloSessionId,
        directory: session.directory,
        ownerId: metadata.identity.userId,
      });
      if (!this.terminalLifecycle.isCurrent(epoch)) {
        await this.compensateSessionAttachment(metadata);
        return;
      }
      recorder.onProgress('workspace_setup', 'Setting up workspace…');
      delivery = 'attach';
      const attachPayload = await fillAttachGitToken(
        metadata,
        buildSessionAttachPayload(metadata, {
          attemptId: recorder.attemptId,
          triggerMessageId: messageId,
        }),
        this.env
      );
      if (!this.terminalLifecycle.isCurrent(epoch)) {
        await this.compensateSessionAttachment(metadata);
        return;
      }
      const attached = await control.request({
        operation: 'session.attach',
        session,
        payload: attachPayload,
        timeoutMs: SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
      });
      if (!this.terminalLifecycle.isCurrent(epoch)) {
        await this.compensateSessionAttachment(metadata);
        return;
      }
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
      this.terminalLifecycle.recordAttachment({
        metadata,
        sandboxId,
        wrapperInstanceId: status.wrapperInstanceId,
        epoch,
      });
      if (!this.terminalLifecycle.isCurrent(epoch)) {
        await this.compensateSessionAttachment(metadata);
        return;
      }
      recorder.finalize({ status: 'completed' });
      const latestMessages = await this.loadMessages();
      if (
        !this.terminalLifecycle.isCurrent(epoch) ||
        nextQueuedMessageId(latestMessages) !== messageId
      ) {
        if (!this.terminalLifecycle.isCurrent(epoch)) {
          await this.compensateSessionAttachment(metadata);
        }
        return;
      }
      delivery = 'prompt';
      const response = await control.request({
        operation: 'session.prompt',
        session,
        payload: {
          messageId,
          turn:
            queued?.turn?.type === 'command'
              ? {
                  type: 'command',
                  command: queued.turn.command,
                  arguments: queued.turn.arguments,
                }
              : {
                  type: 'prompt',
                  prompt: queued?.turn?.prompt ?? queued?.prompt ?? '',
                },
          agent: {
            mode: metadata.agent?.mode ?? 'code',
            model: metadata.agent?.model ?? 'default',
            ...(metadata.agent?.variant ? { variant: metadata.agent.variant } : {}),
          },
        },
      });
      if (!this.terminalLifecycle.isCurrent(epoch)) {
        await this.compensateSessionAttachment(metadata);
        return;
      }
      if (response.ok) {
        const pending = await this.loadMessages();
        if (!this.terminalLifecycle.isCurrent(epoch)) {
          await this.compensateSessionAttachment(metadata);
          return;
        }
        const accepted = acceptQueuedMessage(pending, messageId, Date.now());
        if (!accepted || !(await this.saveMessages(accepted, epoch))) return;
        if (this.terminalLifecycle.isCurrent(epoch)) {
          await this.ctx.storage.setAlarm(Date.now() + DEADLINE_MS.acceptedAlarmCap);
        }
      } else {
        await this.recordDeliveryFailure(messageId, 'prompt');
      }
    } catch (error) {
      if (!this.terminalLifecycle.isCurrent(epoch)) {
        if (routeAttached || delivery === 'attach' || delivery === 'prompt') {
          await this.compensateSessionAttachment(metadata);
        }
        return;
      }
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

  private async compensateSessionAttachment(metadata: SessionMetadata): Promise<void> {
    try {
      await this.terminalLifecycle.cleanupSession(metadata, []);
    } catch {
      logger.withFields({ sessionId: this.sessionId }).warn('Control-plane session detach failed');
    }
  }

  private async recordDeliveryFailure(messageId: string, kind: 'attach' | 'prompt'): Promise<void> {
    const epoch = this.terminalLifecycle.captureEpoch();
    if (epoch === null) return;
    const messages = await this.loadMessages();
    if (!this.terminalLifecycle.isCurrent(epoch)) return;
    const updated =
      kind === 'attach'
        ? incrementAttachFailure(messages, messageId)
        : incrementPromptFailure(messages, messageId);
    if (!(await this.saveMessages(updated.messages, epoch))) return;
    const exhausted =
      kind === 'attach' ? isAttachExhausted(updated.failures) : isPromptExhausted(updated.failures);
    if (exhausted) {
      await this.failWaitingMessages(kind === 'attach' ? 'attach_exhausted' : 'prompt_exhausted');
      return;
    }
    await this.armQueueRetry();
  }

  async failWaitingMessages(reason: string): Promise<void> {
    const epoch = this.terminalLifecycle.captureEpoch();
    if (epoch === null) return;
    const before = await this.loadMessages();
    if (!this.terminalLifecycle.isCurrent(epoch)) return;
    const { messages, failedIds } = applyFailWaitingMessages(before, reason);
    if (failedIds.length === 0 || !(await this.saveMessages(messages, epoch))) return;
    const now = Date.now();
    const safeError = safeErrorFromQueueReason(reason);
    for (const messageId of failedIds) {
      if (!this.terminalLifecycle.isCurrent(epoch)) return;
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
    if (this.terminalLifecycle.captureEpoch() === null) return;
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
    if (this.terminalLifecycle.captureEpoch() === null) return;
    const sessionId = this.requireSessionId();
    createStreamHandler(this.ctx, this.eventQueries, sessionId).broadcastEvent(event);
  }

  private async armQueueRetry(): Promise<void> {
    const epoch = this.terminalLifecycle.captureEpoch();
    if (epoch === null) return;
    const existing = await this.ctx.storage.getAlarm();
    if (!this.terminalLifecycle.isCurrent(epoch)) return;
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
    const epoch = this.terminalLifecycle.captureEpoch();
    const sandboxId = metadata?.workspace?.sandboxId;
    const kiloSessionId = metadata?.auth.kiloSessionId;
    const sessionId = this.sessionId;
    if (!metadata || epoch === null || !sandboxId || !kiloSessionId || !sessionId) {
      throw new Error('No wrapper found for session');
    }
    if (!this.terminalLifecycle.isCurrent(epoch)) {
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
    if (!this.terminalLifecycle.isCurrent(epoch)) {
      throw new Error('No wrapper found for session');
    }
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
    if (this.terminalLifecycle.captureEpoch() === null) return;
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
    if (this.terminalLifecycle.captureEpoch() === null) return;
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
    if (this.terminalLifecycle.isBlocked()) return [];
    const messages = await this.ctx.storage.get<MessageRecord[]>(MESSAGES_KEY);
    return this.terminalLifecycle.isBlocked() ? [] : (messages ?? []);
  }

  private async saveMessages(messages: MessageRecord[], epoch?: number): Promise<boolean> {
    const currentEpoch = epoch ?? this.terminalLifecycle.captureEpoch();
    if (currentEpoch === null || !this.terminalLifecycle.isCurrent(currentEpoch)) return false;
    this.ctx.storage.kv.put(MESSAGES_KEY, messages);
    return true;
  }

  private requireSessionId(): SessionId {
    if (!this.sessionId) throw new Error('SandboxSession is missing session id');
    return this.sessionId;
  }
}
