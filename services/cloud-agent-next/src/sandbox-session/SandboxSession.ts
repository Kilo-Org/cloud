import { DurableObject } from 'cloudflare:workers';
import { TRPCError } from '@trpc/server';
import { withTimeout } from '@kilocode/worker-utils';
import { z } from 'zod';
import { buildSandboxBillingInput } from '../container-usage-context.js';
import { isCloudAgentContainerBillingEnabled } from '../container-billing-rollout.js';
import { withDORetry } from '../utils/do-retry.js';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import migrations from '../../drizzle/migrations';
import type { Env } from '../types.js';
import type { SessionId } from '../types/ids.js';
import { dispatchedKilocodeModelId } from '../persistence/model-utils.js';
import { nextMetadataAfterAdmittedAgentModel } from '../persistence/persist-admitted-agent-model.js';
import { assertKiloModelAvailable } from '../model-validation.js';
import {
  getSandboxProvider,
  parseSessionMetadata,
  serializeSessionMetadata,
  type SessionMetadata,
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
import {
  applyPendingInteractionEvent,
  pendingInteractionsSchema,
  persistSandboxControlSessionEvent,
  type PendingInteractions,
} from './sandbox-control-event.js';
import { buildSignedPromptAttachments } from '../execution/attachment-prompt-parts.js';
import { getSessionWorkspacePath } from '../workspace.js';
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
import { validateControlSessionOptions } from './attach-payload.js';
import { createPreparationProgressRecorder } from '../session/preparation-progress.js';
import {
  finalizeOtherRunningAttemptsForMessage,
  finalizePreparationAttempt,
  getPreparationSnapshots,
} from '../session/preparation-history.js';
import {
  SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
  SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
  sessionAttachResultSchema,
  sessionMessageOutcomeSchema,
  sessionPromptResultSchema,
  sessionSyncResultSchema,
  sessionPermissionResolveResultSchema,
  sessionQuestionResolveResultSchema,
  sessionAbortResultSchema,
  wrapperInstanceIdSchema,
  type SessionSyncResult,
  type SessionEventIdentity,
  type SessionPreparingPayload,
} from '../shared/sandbox-control-protocol.js';
import type { WrapperPty } from '../kilo/wrapper-client.js';
import {
  controlDispatchDisposition,
  controlRequestResult,
  isRetryableDeliveryError,
  observeControlAfterStopping,
  safeErrorFromQueueReason,
  SESSION_DELIVERY_TIMEOUT_MS,
  withDeliveryDeadline,
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
  applyMessageOutcome,
  assignPreparationAttemptId,
  createSessionMessageRecord,
  failQueuedMessage,
  failWaitingMessages as applyFailWaitingMessages,
  failedMessageSnapshot,
  freezeLegacyQueuedMessages,
  hasAcceptedMessage,
  incrementDeliveryFailure,
  matchesSessionMessageReplay,
  nextQueuedMessageId,
  recordAcceptedMessageActivity,
  resolveSessionMessageIntent,
  streamCloudStatus,
  streamQueuedSnapshots,
  type ControlSessionMessageInput,
  type SessionMessageRecord,
} from './session-message-queue.js';

const METADATA_KEY = SANDBOX_SESSION_METADATA_KEY;
const MESSAGES_KEY = 'session_messages';
const QUEUE_RETRY_MS = 5_000;
const PENDING_RUNTIME_CLEANUP_KEY = 'pending_runtime_cleanup';
const PENDING_INTERACTIONS_KEY = 'session_pending_interactions';
const pendingRuntimeCleanupSchema = z.object({
  ownerId: z.string().min(1),
  sessionId: z.string().min(1),
  sandboxId: z.string().min(1),
  wrapperInstanceId: wrapperInstanceIdSchema,
  reason: z.string(),
});

type MessageRecord = SessionMessageRecord;
type DispatchPhase = 'preparing' | 'attach' | 'prompt';

export class SandboxSession extends DurableObject<Env> {
  private readonly sessionId: SessionId | undefined;
  private readonly eventQueries: EventQueries;
  private readonly terminalLifecycle: ReturnType<typeof createSandboxTerminalLifecycle>;
  private readonly terminalBridge: ReturnType<typeof createSandboxTerminalBridge>;
  private readonly dispatches = new Map<string, Promise<void>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const doName = ctx.id.name;
    const lastColon = doName?.lastIndexOf(':') ?? -1;
    const sessionIdPart = doName && lastColon > 0 ? doName.slice(lastColon + 1) : undefined;
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
    const storedSessionId =
      sessionIdPart ?? this.terminalLifecycle.getStoredMetadata()?.identity.sessionId;
    this.sessionId = storedSessionId ? (storedSessionId as SessionId) : undefined;
    this.terminalBridge = createSandboxTerminalBridge({
      state: ctx,
      getMetadata: () => this.getMetadata(),
      getTerminal: async (ptyId): Promise<SandboxTerminalRecord | undefined> =>
        this.pendingRuntimeCleanup() ? undefined : this.terminalLifecycle.getTerminal(ptyId),
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
      derivePendingInteractions: () => this.derivePendingInteractions(),
      deriveSessionStatus: async () =>
        hasAcceptedMessage(this.loadMessages())
          ? { type: 'busy' as const }
          : { type: 'idle' as const },
      getPreparationSnapshots: async () => getPreparationSnapshots(this.eventQueries),
      reconcileMaterializedEvents: true,
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
    wrapperInstanceId?: string;
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
    if (input.identity.directory !== this.directory(metadata)) return { applied: false };
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
    const eventKiloSessionId =
      input.identity.kiloSessionId ??
      ingestKiloSessionId(input.payload.type, input.payload.properties);
    if (input.payload.type === 'session.message.outcome') {
      const outcome = sessionMessageOutcomeSchema.safeParse(input.payload.properties);
      if (
        !outcome.success ||
        !input.wrapperInstanceId ||
        (eventKiloSessionId !== undefined && root !== undefined && eventKiloSessionId !== root)
      ) {
        return { applied: false };
      }
      const messages = this.loadMessages();
      const existing = messages.find(message => message.messageId === outcome.data.messageId);
      if (
        existing?.wrapperInstanceId === input.wrapperInstanceId &&
        existing.state === outcome.data.status
      )
        return { applied: true };
      const settled = applyMessageOutcome(
        messages,
        outcome.data,
        input.wrapperInstanceId,
        Date.now()
      );
      if (!settled || !this.saveMessages(settled, epoch)) return { applied: false };
      await this.armQueueRetry();
      const nextId = nextQueuedMessageId(this.loadMessages());
      if (nextId && this.terminalLifecycle.isCurrent(epoch)) {
        this.ctx.waitUntil(this.dispatchQueued(nextId));
      }
      return { applied: true };
    }
    if (!this.isCurrentEventRuntime(input.wrapperInstanceId)) return { applied: false };
    if (
      eventKiloSessionId !== undefined &&
      eventKiloSessionId !== root &&
      (root === undefined || input.identity.rootKiloSessionId !== root)
    )
      return { applied: false };
    if (
      (input.payload.type === 'question.asked' || input.payload.type === 'permission.asked') &&
      !this.loadMessages().some(
        message => message.state === 'accepted' || message.state === 'queued'
      )
    )
      return { applied: false };
    this.recordPendingInteraction(input.payload);
    persistSandboxControlSessionEvent({
      sessionId,
      payload: input.payload,
      eventQueries: this.eventQueries,
      broadcast: event => this.broadcastStoredEvent(event),
    });
    const activeMessages = recordAcceptedMessageActivity(this.loadMessages(), Date.now());
    if (activeMessages) this.saveMessages(activeMessages, epoch);
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
    return { applied: this.terminalLifecycle.isCurrent(epoch) };
  }

  async receiveSandboxControlPreparing(input: {
    identity: SessionEventIdentity;
    payload: SessionPreparingPayload;
    wrapperInstanceId?: string;
  }): Promise<{ applied: boolean }> {
    const metadata = await this.getMetadata();
    const epoch = this.terminalLifecycle.captureEpoch();
    if (!metadata || epoch === null) return { applied: false };
    const root = metadata.auth.kiloSessionId;
    if (input.identity.directory !== this.directory(metadata)) return { applied: false };
    if (
      input.identity.rootKiloSessionId !== undefined &&
      root !== undefined &&
      input.identity.rootKiloSessionId !== root
    ) {
      return { applied: false };
    }
    const message = this.loadMessages().find(
      item => item.messageId === input.payload.triggerMessageId
    );
    if (
      !this.terminalLifecycle.isCurrent(epoch) ||
      !message ||
      message.preparationAttemptId !== input.payload.attemptId ||
      (input.wrapperInstanceId !== undefined &&
        message.wrapperInstanceId !== input.wrapperInstanceId)
    ) {
      return { applied: false };
    }
    if (message.state !== 'queued') return { applied: true };
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

  async getCredentialMetadata(): Promise<SessionMetadata | null> {
    return this.terminalLifecycle.isBlocked() ? null : this.terminalLifecycle.getStoredMetadata();
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
    const record = this.loadMessages().find(message => message.messageId === messageId);
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
    return;
  }

  async interruptExecution(): Promise<{ success: boolean; message?: string }> {
    const epoch = this.terminalLifecycle.captureEpoch();
    if (epoch === null) return { success: false, message: 'Session not found' };
    const before = this.loadMessages();
    if (!this.terminalLifecycle.isCurrent(epoch)) {
      return { success: false, message: 'Session not found' };
    }
    const active = before.filter(
      message => message.state === 'queued' || message.state === 'accepted'
    );
    if (!active.length) return { success: false, message: 'No session work to interrupt' };
    const accepted = active.find(message => message.state === 'accepted');
    const preparing = accepted ? undefined : active[0];
    const metadata = this.terminalLifecycle.getStoredMetadata();
    if (preparing?.wrapperInstanceId && metadata) {
      this.retainRuntimeCleanup(metadata, preparing.wrapperInstanceId, 'preparation_interrupted');
    }
    this.saveMessages(
      before.map(message =>
        message.state === 'queued' ? { ...message, state: 'cancelled' } : message
      ),
      epoch
    );
    await this.armQueueRetry();
    if (this.pendingRuntimeCleanup()) {
      await this.transferRuntimeCleanup();
      return { success: true };
    }
    const sandboxId = metadata?.workspace?.sandboxId;
    const kiloSessionId = metadata?.auth.kiloSessionId;
    if (!accepted) return { success: true };
    try {
      if (!metadata || !sandboxId || !kiloSessionId)
        throw new Error('Accepted runtime is unavailable');
      const response = await withTimeout(
        sandboxControlRpc(this.env, sandboxId).request({
          operation: 'session.abort',
          session: {
            sessionId: metadata.identity.sessionId,
            kiloSessionId,
            directory: this.directory(metadata),
          },
          payload: { messageId: accepted.messageId },
        }),
        SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
        'Session abort timed out'
      );
      if (!this.isCurrentAcceptedMessage(accepted, epoch)) return { success: true };
      if (!response.ok) throw new Error('Session abort failed');
      sessionAbortResultSchema.parse(response.result);
      this.saveMessages(
        this.loadMessages().map(message =>
          message.messageId === accepted.messageId ? { ...message, state: 'cancelled' } : message
        ),
        epoch
      );
      await this.armQueueRetry();
      return { success: true };
    } catch {
      if (!this.isCurrentAcceptedMessage(accepted, epoch)) return { success: true };
      await this.failDelivery(accepted.messageId, 'runtime_unhealthy', accepted.wrapperInstanceId);
      return { success: false, message: 'The session runtime could not be interrupted' };
    }
  }

  async answerPermission(input: {
    permissionId: string;
    response: 'once' | 'always' | 'reject';
  }): Promise<{ success: boolean }> {
    const result = await this.requestSessionOperation('session.permission.resolve', {
      permissionId: input.permissionId,
      response: input.response,
    });
    this.recordPendingInteraction({
      type: 'permission.replied',
      properties: { requestID: input.permissionId },
    });
    return result;
  }

  async answerQuestion(input: {
    questionId: string;
    answers: string[][];
  }): Promise<{ success: boolean }> {
    const result = await this.requestSessionOperation('session.question.resolve', {
      action: 'answer',
      questionId: input.questionId,
      answers: input.answers,
    });
    this.recordPendingInteraction({
      type: 'question.replied',
      properties: { requestID: input.questionId },
    });
    return result;
  }

  async rejectQuestion(input: { questionId: string }): Promise<{ success: boolean }> {
    const result = await this.requestSessionOperation('session.question.resolve', {
      action: 'reject',
      questionId: input.questionId,
    });
    this.recordPendingInteraction({
      type: 'question.rejected',
      properties: { requestID: input.questionId },
    });
    return result;
  }

  async createTerminal(input?: {
    cols?: number;
    rows?: number;
    operationId?: string;
  }): Promise<OperationResult<{ pty: WrapperPty }>> {
    if (this.pendingRuntimeCleanup())
      return { success: false, error: 'Runtime cleanup is pending' };
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
    return this.pendingRuntimeCleanup() !== undefined;
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
      const pendingCleanup = this.pendingRuntimeCleanup();
      this.eventQueries.deleteOlderThan(Number.MAX_SAFE_INTEGER);
      this.terminalLifecycle.purgeDeletedState();
      if (pendingCleanup) this.ctx.storage.kv.put(PENDING_RUNTIME_CLEANUP_KEY, pendingCleanup);
    });
    if (this.pendingRuntimeCleanup()) await this.armQueueRetry();
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
    try {
      validateControlSessionOptions(input);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unsupported session options',
      };
    }
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
    this.ctx.storage.kv.put(PENDING_INTERACTIONS_KEY, {
      revision: 0,
      questions: [],
      permissions: [],
    });
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
    try {
      validateControlSessionOptions(input);
    } catch (error) {
      return {
        success: false,
        code: 'BAD_REQUEST',
        error: error instanceof Error ? error.message : 'Unsupported session options',
      };
    }
    const registered = await this.registerSession(input);
    if (!registered.success) {
      return {
        success: false,
        code: registered.error === 'Session not found' ? 'NOT_FOUND' : 'INTERNAL',
        error: registered.error ?? 'register failed',
      };
    }
    return this.queueAndDispatch(
      {
        turn: input.message.initialTurn,
        agent: input.agent,
        finalization: input.finalization,
      },
      'initial'
    );
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
    const messages = this.loadMessages();
    const accepted = messages.find(message => message.state === 'accepted');
    if (accepted) return { messageId: accepted.messageId, status: 'running', health: 'healthy' };
    const queued = messages.find(message => message.state === 'queued');
    if (queued) return { messageId: queued.messageId, status: 'pending', health: 'healthy' };
    return null;
  }

  async hasMessageAdmission(messageId: string): Promise<boolean> {
    return this.loadMessages().some(message => message.messageId === messageId);
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
    return this.queueAndDispatch(
      { turn, agent: request.agent, finalization: request.finalization },
      'followup'
    );
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
    if (this.pendingRuntimeCleanup()) await this.transferRuntimeCleanup();
    const epoch = this.terminalLifecycle.captureEpoch();
    if (epoch === null) return;
    const now = Date.now();
    const messages = this.loadMessages();
    if (!this.terminalLifecycle.isCurrent(epoch)) return;
    const accepted = messages.find(message => message.state === 'accepted');
    if (accepted) {
      const decision = acceptedAlarmDecision(
        accepted.acceptedAt ?? 0,
        now,
        accepted.lastActivityAt
      );
      await this.armQueueRetry(
        decision.action === 'rearm' ? decision.at : now + DEADLINE_MS.acceptedAlarmCap
      );
      if (decision.action === 'check') {
        try {
          const snapshot = await this.syncAcceptedMessage(accepted, epoch);
          if (!snapshot || !this.isCurrentAcceptedMessage(accepted, epoch)) return;
          const healthy =
            snapshot.status.type === 'busy' ||
            snapshot.status.type === 'retry' ||
            snapshot.questions.length > 0 ||
            snapshot.permissions.length > 0;
          if (!healthy) throw new Error('Accepted execution is no longer active');
          const active = recordAcceptedMessageActivity(this.loadMessages(), Date.now());
          if (active) this.saveMessages(active, epoch);
        } catch {
          if (this.isCurrentAcceptedMessage(accepted, epoch)) {
            await this.failDelivery(
              accepted.messageId,
              'runtime_unhealthy',
              accepted.wrapperInstanceId
            );
          }
        }
      }
      return;
    }
    const headId = nextQueuedMessageId(messages);
    if (headId) await this.dispatchQueued(headId, { allowCreate: false });
  }

  private async queueAndDispatch(
    input: ControlSessionMessageInput,
    origin: 'initial' | 'followup'
  ): Promise<SessionMessageAdmissionResult> {
    const epoch = this.terminalLifecycle.captureEpoch();
    const metadata = this.terminalLifecycle.getStoredMetadata();
    if (epoch === null || !metadata) {
      return { success: false, code: 'NOT_FOUND', error: 'Session not found' };
    }
    const messageId = input.turn.messageId;
    const messages = this.ctx.storage.kv.get<MessageRecord[]>(MESSAGES_KEY) ?? [];
    const existing = messages.find(message => message.messageId === messageId);
    const intent = existing
      ? undefined
      : resolveSessionMessageIntent(input, origin === 'followup' ? metadata.agent : undefined);
    if (!existing && !intent) {
      return { success: false, code: 'BAD_REQUEST', error: 'Session is missing a valid model' };
    }
    if (!existing) {
      try {
        validateControlSessionOptions(metadata);
      } catch (error) {
        return {
          success: false,
          code: 'BAD_REQUEST',
          error: error instanceof Error ? error.message : 'Unsupported session options',
        };
      }
    }
    let validationFailure: Extract<SessionMessageAdmissionResult, { success: false }> | undefined;
    if (intent?.turn.type === 'prompt' && origin === 'followup') {
      try {
        await assertKiloModelAvailable({
          env: this.env,
          submittedModel: intent.agent.model,
          originalToken: metadata.auth.kilocodeToken,
          originalOrganizationId: metadata.identity.orgId,
          createdOnPlatform: metadata.identity.createdOnPlatform,
          procedure: 'admitSubmittedMessage',
        });
      } catch (error) {
        if (!(error instanceof TRPCError)) throw error;
        if (error.code === 'BAD_REQUEST' || error.code === 'FORBIDDEN') {
          validationFailure = { success: false, code: error.code, error: error.message };
        } else if (error.code === 'SERVICE_UNAVAILABLE') {
          validationFailure = {
            success: false,
            code: 'MODEL_VALIDATION_UNAVAILABLE',
            error: error.message,
          };
        } else {
          throw error;
        }
      }
    }
    let admitted = false;
    const result = this.ctx.storage.transactionSync((): SessionMessageAdmissionResult => {
      const latestMetadata = this.terminalLifecycle.getStoredMetadata();
      if (!this.terminalLifecycle.isCurrent(epoch) || !latestMetadata) {
        return { success: false, code: 'NOT_FOUND', error: 'Session not found' };
      }
      const latestMessages = this.ctx.storage.kv.get<MessageRecord[]>(MESSAGES_KEY) ?? [];
      const duplicate = latestMessages.find(message => message.messageId === messageId);
      if (duplicate) {
        const [frozen] = freezeLegacyQueuedMessages([duplicate], latestMetadata.agent);
        if (
          !matchesSessionMessageReplay(frozen, intent ?? input) ||
          (intent &&
            frozen.intent &&
            (intent.agent.variant !== frozen.intent.agent.variant ||
              intent.finalization?.autoCommit !== frozen.intent.finalization?.autoCommit ||
              intent.finalization?.condenseOnComplete !==
                frozen.intent.finalization?.condenseOnComplete))
        ) {
          return {
            success: false,
            code: 'BAD_REQUEST',
            error: 'Message ID conflicts with its existing intent or is already terminal',
          };
        }
        return {
          success: true,
          outcome: 'queued',
          messageId,
          compatibilityDelivery: duplicate.state === 'accepted' ? 'sent' : 'queued',
        };
      }
      if (validationFailure) return validationFailure;
      if (!intent) return { success: false, code: 'NOT_FOUND', error: 'Message not found' };
      const nextMessages = freezeLegacyQueuedMessages(latestMessages, latestMetadata.agent);
      nextMessages.push(createSessionMessageRecord(intent));
      const nextMetadata =
        intent.agent.model === undefined
          ? null
          : nextMetadataAfterAdmittedAgentModel(latestMetadata, {
              model: intent.agent.model,
              variant: intent.agent.variant,
            });
      this.ctx.storage.kv.put(MESSAGES_KEY, nextMessages);
      if (nextMetadata) {
        this.ctx.storage.kv.put(METADATA_KEY, serializeSessionMetadata(nextMetadata));
      }
      admitted = true;
      return { success: true, outcome: 'queued', messageId, compatibilityDelivery: 'queued' };
    });
    if (result.success && this.terminalLifecycle.isCurrent(epoch)) {
      await this.armQueueRetry();
      if (!this.terminalLifecycle.isCurrent(epoch)) return result;
      if (admitted) this.broadcastQueuedMessage(messageId, renderExecutionTurnContent(input.turn));
      const headId = nextQueuedMessageId(this.loadMessages());
      if (headId) this.ctx.waitUntil(this.dispatchQueued(headId, { allowCreate: true }));
    }
    return result;
  }

  private async dispatchQueued(
    messageId: string,
    options?: { allowCreate?: boolean }
  ): Promise<void> {
    const current = this.dispatches.get(messageId);
    if (current) return current;
    const pending = this.deliverQueuedMessage(messageId, options);
    this.dispatches.set(messageId, pending);
    try {
      await pending;
    } finally {
      this.dispatches.delete(messageId);
    }
  }

  private async deliverQueuedMessage(
    messageId: string,
    options?: { allowCreate?: boolean }
  ): Promise<void> {
    const metadata = this.terminalLifecycle.getStoredMetadata();
    const epoch = this.terminalLifecycle.captureEpoch();
    const sandboxId = metadata?.workspace?.sandboxId;
    const kiloSessionId = metadata?.auth.kiloSessionId;
    const sessionId = this.sessionId;
    if (!metadata || epoch === null || !sandboxId || !kiloSessionId || !sessionId) {
      if (!this.terminalLifecycle.isBlocked()) await this.failWaitingMessages('missing_metadata');
      return;
    }
    const assigned = this.ctx.storage.transactionSync(() => {
      const messages = this.ctx.storage.kv.get<MessageRecord[]>(MESSAGES_KEY) ?? [];
      if (!this.terminalLifecycle.isCurrent(epoch) || nextQueuedMessageId(messages) !== messageId) {
        return undefined;
      }
      const frozen = freezeLegacyQueuedMessages(messages, metadata.agent).map(message =>
        message.messageId === messageId && message.deliveryDeadlineAt === undefined
          ? { ...message, deliveryDeadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS }
          : message
      );
      const prepared = assignPreparationAttemptId(frozen, messageId, () => crypto.randomUUID());
      if (prepared) this.ctx.storage.kv.put(MESSAGES_KEY, prepared.messages);
      return prepared;
    });
    if (!assigned) return;
    const queued = assigned.messages.find(message => message.messageId === messageId);
    const deadlineAt = queued?.deliveryDeadlineAt;
    if (!queued || deadlineAt === undefined) return;
    const provider = getSandboxProvider(metadata);
    const acquisition =
      provider === 'cloudflare' ? { id: assigned.attemptId, deadlineAt } : undefined;
    const allowCreate = acquisition === undefined && options?.allowCreate === true;
    let wrapperInstanceId = queued.wrapperInstanceId;
    const isCurrent = () => this.queuedMessage(messageId, epoch, wrapperInstanceId) !== undefined;
    const wait = <T>(operation: () => Promise<T>, timeoutMs?: number) =>
      withDeliveryDeadline(operation, deadlineAt, timeoutMs);
    const recordRuntime = (identity: string | undefined) => {
      const runtime = wrapperInstanceIdSchema.safeParse(identity);
      if (!runtime.success) return;
      wrapperInstanceId = runtime.data;
      this.saveMessages(
        this.loadMessages().map(message =>
          message.messageId === messageId ? { ...message, wrapperInstanceId } : message
        ),
        epoch
      );
    };
    await this.armQueueRetry(Math.min(deadlineAt, Date.now() + QUEUE_RETRY_MS));
    if (!isCurrent()) return;
    if (Date.now() >= deadlineAt) {
      await this.failDelivery(messageId, 'preparation_timeout', wrapperInstanceId);
      return;
    }
    if (this.pendingRuntimeCleanup()) return;
    const intent = queued.intent;
    const model = dispatchedKilocodeModelId(intent?.agent.model);
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
    if (
      !intent ||
      ((intent.turn.type === 'prompt' || intent.agent.model !== undefined) && !model)
    ) {
      const failedMessages = failQueuedMessage(this.loadMessages(), messageId);
      const failed = failedMessages?.find(message => message.messageId === messageId);
      if (!failedMessages || !failed) return;
      failed.failedReason = 'invalid_model';
      if (!this.saveMessages(failedMessages, epoch)) return;
      if (!this.terminalLifecycle.isCurrent(epoch)) return;
      recorder.finalize({ status: 'failed', safeError: 'Session is missing a valid model' });
      if (nextQueuedMessageId(failedMessages)) await this.armQueueRetry();
      return;
    }
    let phase: DispatchPhase = 'preparing';
    let credentialsPrepared = false;
    try {
      validateControlSessionOptions(metadata);
      const session = { sessionId, kiloSessionId, directory: this.directory(metadata) };
      const attachments =
        intent.turn.type === 'prompt'
          ? await wait(() =>
              buildSignedPromptAttachments({
                env: this.env,
                userId: metadata.identity.userId,
                sessionId,
                attachments: intent.turn.type === 'prompt' ? intent.turn.attachments : undefined,
                createdOnPlatform: metadata.identity.createdOnPlatform,
              })
            )
          : [];
      if (!isCurrent()) return;
      const ensureReady = () => {
        credentialsPrepared = true;
        return wait(
          () =>
            control.ensureReady({
              ownerId: metadata.identity.userId,
              sessionId,
              provider,
              ...(acquisition ? { acquisition } : { allowCreate }),
              billing: buildSandboxBillingInput(
                metadata,
                sandboxId,
                isCloudAgentContainerBillingEnabled(this.env, metadata.identity)
              ),
            }),
          DEADLINE_MS.startup
        );
      };
      if (!this.terminalLifecycle.getAttachedWrapperInstanceId()) {
        recorder.onProgress('workspace_setup', 'Preparing environment…');
      }
      let status = await ensureReady();
      if (!isCurrent()) {
        if (!this.terminalLifecycle.isCurrent(epoch))
          await this.compensateSessionAttachment(metadata);
        return;
      }
      recordRuntime(status.wrapperInstanceId);
      const stoppingDeadline = Math.min(deadlineAt, Date.now() + DEADLINE_MS.startup);
      while (allowCreate && status.physical === 'stopping') {
        const observed = await observeControlAfterStopping(
          status,
          () => {
            if (!isCurrent()) throw new Error('Session delivery is no longer current');
            return wait(() => control.getStatus());
          },
          { retryMs: QUEUE_RETRY_MS, deadline: stoppingDeadline }
        );
        if (!isCurrent()) return;
        if (!observed) {
          await this.failDelivery(messageId, 'preparation_timeout', wrapperInstanceId);
          return;
        }
        const provision = provisionPreparingStep(observed.physical, allowCreate);
        if (provision) recorder.onProgress(provision.step, provision.message);
        status = await ensureReady();
        if (!isCurrent()) {
          if (!this.terminalLifecycle.isCurrent(epoch))
            await this.compensateSessionAttachment(metadata);
          return;
        }
        recordRuntime(status.wrapperInstanceId);
      }
      const boot = bootPreparingStep(status.physical, status.connection);
      if (boot) recorder.onProgress(boot.step, boot.message);
      const disposition = controlDispatchDisposition(status);
      if (disposition.action === 'fail') {
        await this.failDelivery(messageId, disposition.reason, wrapperInstanceId);
        return;
      }
      if (disposition.action === 'wait') {
        await this.armQueueRetry(Math.min(deadlineAt, Date.now() + QUEUE_RETRY_MS));
        return;
      }
      if (!wrapperInstanceId) throw new Error('Wrapper identity is missing');
      if (this.terminalLifecycle.getAttachedWrapperInstanceId() !== wrapperInstanceId) {
        recorder.onProgress('workspace_setup', 'Setting up workspace…');
        if (!status.attachment?.kilo)
          throw new Error('Contained session attachment is unavailable');
        const attachPayload = {
          ...status.attachment,
          preparation: { attemptId: recorder.attemptId, triggerMessageId: messageId },
        };
        phase = 'attach';
        await wait(() =>
          control.attachSession({
            ...(metadata.workspace?.worktreeId
              ? { worktreeId: metadata.workspace.worktreeId }
              : {}),
            sessionId,
            kiloSessionId,
            directory: session.directory,
            ownerId: metadata.identity.userId,
          })
        );
        if (!isCurrent()) {
          if (!this.terminalLifecycle.isCurrent(epoch))
            await this.compensateSessionAttachment(metadata);
          return;
        }
        const attached = await wait(
          async () =>
            controlRequestResult(
              await control.request({
                operation: 'session.attach',
                session,
                expectedWrapperInstanceId: wrapperInstanceId,
                payload: attachPayload,
                timeoutMs: SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
              })
            ),
          SANDBOX_CONTROL_ATTACH_TIMEOUT_MS
        );
        if (!isCurrent()) {
          if (!this.terminalLifecycle.isCurrent(epoch))
            await this.compensateSessionAttachment(metadata);
          return;
        }
        sessionAttachResultSchema.parse(attached);
      }
      const attachedRuntime = await wait(() => control.getStatus());
      if (!isCurrent()) return;
      if (
        attachedRuntime.physical !== 'running' ||
        attachedRuntime.connection !== 'ready' ||
        attachedRuntime.wrapperInstanceId !== wrapperInstanceId
      )
        throw new Error('Wrapper changed during session attachment');
      this.terminalLifecycle.recordAttachment({ metadata, sandboxId, wrapperInstanceId, epoch });
      recorder.finalize({ status: 'completed' });
      phase = 'prompt';
      const prompt = await wait(async () =>
        controlRequestResult(
          await control.request({
            operation: 'session.prompt',
            session,
            expectedWrapperInstanceId: wrapperInstanceId,
            payload: {
              messageId,
              turn:
                intent.turn.type === 'command'
                  ? {
                      type: 'command',
                      command: intent.turn.command,
                      arguments: intent.turn.arguments,
                    }
                  : { type: 'prompt', prompt: intent.turn.prompt },
              agent: {
                mode: intent.agent.mode,
                ...(model !== undefined ? { model } : {}),
                ...(intent.agent.variant !== undefined ? { variant: intent.agent.variant } : {}),
              },
              ...(intent.finalization ? { finalization: intent.finalization } : {}),
              ...(attachments.length ? { attachments } : {}),
            },
          })
        )
      );
      if (!isCurrent()) {
        if (!this.terminalLifecycle.isCurrent(epoch))
          await this.compensateSessionAttachment(metadata);
        return;
      }
      const result = sessionPromptResultSchema.parse(prompt);
      if (result.messageId !== messageId)
        throw new Error('Prompt response message identity mismatch');
      const accepted = acceptQueuedMessage(this.loadMessages(), messageId, Date.now());
      if (!accepted || !this.saveMessages(accepted, epoch)) return;
      await this.armQueueRetry(Date.now() + DEADLINE_MS.acceptedAlarmCap);
    } catch (error) {
      if (!isCurrent()) {
        if (
          (credentialsPrepared || phase !== 'preparing') &&
          !this.terminalLifecycle.isCurrent(epoch)
        ) {
          await this.compensateSessionAttachment(metadata);
        }
        return;
      }
      logger.withFields({ sessionId, messageId, phase }).warn('Control-plane dispatch failed');
      await this.recordDeliveryFailure({
        messageId,
        epoch,
        phase,
        wrapperInstanceId,
        deadlineAt,
        error,
      });
    }
  }

  private async compensateSessionAttachment(metadata: SessionMetadata): Promise<void> {
    try {
      await withTimeout(
        this.terminalLifecycle.cleanupSession(metadata, []),
        SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
        'Session detach timed out'
      );
    } catch {
      logger.withFields({ sessionId: this.sessionId }).warn('Control-plane session detach failed');
    }
  }

  private queuedMessage(
    messageId: string,
    epoch: number,
    wrapperInstanceId?: string
  ): MessageRecord | undefined {
    if (!this.terminalLifecycle.isCurrent(epoch)) return undefined;
    const messages = this.loadMessages();
    if (nextQueuedMessageId(messages) !== messageId) return undefined;
    const message = messages.find(item => item.messageId === messageId);
    return wrapperInstanceId === undefined || message?.wrapperInstanceId === wrapperInstanceId
      ? message
      : undefined;
  }

  private async recordDeliveryFailure(input: {
    messageId: string;
    epoch: number;
    phase: DispatchPhase;
    wrapperInstanceId?: string;
    deadlineAt: number;
    error: unknown;
  }): Promise<void> {
    const { messageId, epoch, phase, wrapperInstanceId, deadlineAt, error } = input;
    if (!this.queuedMessage(messageId, epoch, wrapperInstanceId)) return;
    if (Date.now() >= deadlineAt) {
      await this.failDelivery(messageId, 'preparation_timeout', wrapperInstanceId);
      return;
    }
    const updated =
      phase === 'preparing'
        ? undefined
        : incrementDeliveryFailure(this.loadMessages(), messageId, phase);
    if (updated && !this.saveMessages(updated.messages, epoch)) return;
    if (isRetryableDeliveryError(error) && !updated?.exhausted) {
      await this.armQueueRetry(Math.min(deadlineAt, Date.now() + QUEUE_RETRY_MS));
      return;
    }
    await this.failDelivery(
      messageId,
      phase === 'prompt'
        ? 'prompt_exhausted'
        : phase === 'attach'
          ? 'attach_exhausted'
          : 'environment_failed',
      wrapperInstanceId
    );
  }

  private retainRuntimeCleanup(
    metadata: SessionMetadata,
    wrapperInstanceId: string,
    reason: string
  ): void {
    const sandboxId = metadata.workspace?.sandboxId;
    if (!sandboxId) return;
    const pending = this.pendingRuntimeCleanup();
    if (pending && pending.wrapperInstanceId !== wrapperInstanceId) return;
    this.ctx.storage.kv.put(PENDING_RUNTIME_CLEANUP_KEY, {
      ownerId: metadata.identity.userId,
      sessionId: metadata.identity.sessionId,
      sandboxId,
      wrapperInstanceId,
      reason,
    });
    this.terminalLifecycle.invalidateRuntime({ sandboxId, wrapperInstanceId, confirmed: false });
  }

  private pendingRuntimeCleanup() {
    const raw = this.ctx.storage.kv.get<unknown>(PENDING_RUNTIME_CLEANUP_KEY);
    return raw === undefined ? undefined : pendingRuntimeCleanupSchema.parse(raw);
  }

  private async transferRuntimeCleanup(): Promise<boolean> {
    const pending = this.pendingRuntimeCleanup();
    if (!pending) return true;
    await this.armQueueRetry(Date.now() + SANDBOX_CONTROL_REQUEST_TIMEOUT_MS);
    try {
      const response = await withTimeout(
        withDORetry(
          () => sandboxControlRpc(this.env, pending.sandboxId),
          control =>
            control.quarantineRuntime({
              ownerId: pending.ownerId,
              sessionId: pending.sessionId,
              wrapperInstanceId: pending.wrapperInstanceId,
              reason: pending.reason,
            }),
          'quarantineRuntime'
        ),
        SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
        'Runtime quarantine timed out'
      );
      if (typeof response?.quarantined !== 'boolean')
        throw new Error('Invalid quarantine response');
      if (this.pendingRuntimeCleanup()?.wrapperInstanceId === pending.wrapperInstanceId) {
        this.ctx.storage.kv.delete(PENDING_RUNTIME_CLEANUP_KEY);
      }
      return this.pendingRuntimeCleanup() === undefined;
    } catch {
      logger.withFields({ sessionId: this.sessionId }).warn('Runtime quarantine transfer failed');
      await this.armQueueRetry(Date.now() + SANDBOX_CONTROL_REQUEST_TIMEOUT_MS);
      return false;
    }
  }

  private async failDelivery(
    messageId: string,
    reason: string,
    wrapperInstanceId?: string
  ): Promise<void> {
    const epoch = this.terminalLifecycle.captureEpoch();
    const metadata = this.terminalLifecycle.getStoredMetadata();
    const message = this.loadMessages().find(item => item.messageId === messageId);
    if (
      epoch === null ||
      !metadata ||
      !message ||
      (message.state !== 'queued' && message.state !== 'accepted') ||
      message.wrapperInstanceId !== wrapperInstanceId
    )
      return;
    if (wrapperInstanceId) this.retainRuntimeCleanup(metadata, wrapperInstanceId, reason);
    await this.failWaitingMessages(reason, wrapperInstanceId);
    if (this.pendingRuntimeCleanup()) await this.transferRuntimeCleanup();
  }

  async failWaitingMessages(reason: string, wrapperInstanceId?: string): Promise<void> {
    const epoch = this.terminalLifecycle.captureEpoch();
    if (epoch === null) return;
    const before = this.loadMessages();
    if (!this.terminalLifecycle.isCurrent(epoch)) return;
    const { messages, failedIds } = applyFailWaitingMessages(before, reason, wrapperInstanceId);
    if (failedIds.length === 0 || !this.saveMessages(messages, epoch)) return;
    if (this.pendingRuntimeCleanup() || nextQueuedMessageId(this.loadMessages()))
      await this.armQueueRetry();
  }

  private broadcastStoredEvent(event: StoredEvent): void {
    if (this.terminalLifecycle.captureEpoch() === null) return;
    const sessionId = this.requireSessionId();
    createStreamHandler(this.ctx, this.eventQueries, sessionId).broadcastEvent(event);
  }

  private async armQueueRetry(when = Date.now() + QUEUE_RETRY_MS): Promise<void> {
    const epoch = this.terminalLifecycle.captureEpoch();
    if (epoch === null && !this.pendingRuntimeCleanup()) return;
    const existing = await this.ctx.storage.getAlarm();
    if (
      (epoch === null || !this.terminalLifecycle.isCurrent(epoch)) &&
      !this.pendingRuntimeCleanup()
    )
      return;
    if (existing === null || existing > when) await this.ctx.storage.setAlarm(when);
  }

  private readPendingInteractions(): PendingInteractions | undefined {
    const parsed = pendingInteractionsSchema.safeParse(
      this.ctx.storage.kv.get<unknown>(PENDING_INTERACTIONS_KEY)
    );
    return parsed.success ? parsed.data : undefined;
  }

  private recordPendingInteraction(payload: {
    type: string;
    properties: Record<string, unknown>;
  }): void {
    if (this.terminalLifecycle.captureEpoch() === null) return;
    const next = applyPendingInteractionEvent(this.readPendingInteractions(), payload);
    if (next) this.ctx.storage.kv.put(PENDING_INTERACTIONS_KEY, next);
  }

  private isCurrentAcceptedMessage(message: MessageRecord, epoch: number): boolean {
    if (!this.terminalLifecycle.isCurrent(epoch)) return false;
    const current = this.loadMessages().find(item => item.messageId === message.messageId);
    return current?.state === 'accepted' && current.wrapperInstanceId === message.wrapperInstanceId;
  }

  private async syncAcceptedMessage(
    message: MessageRecord,
    epoch: number
  ): Promise<SessionSyncResult | undefined> {
    const metadata = this.terminalLifecycle.getStoredMetadata();
    const sandboxId = metadata?.workspace?.sandboxId;
    const kiloSessionId = metadata?.auth.kiloSessionId;
    if (
      !metadata ||
      !sandboxId ||
      !kiloSessionId ||
      !message.wrapperInstanceId ||
      this.pendingRuntimeCleanup()
    ) {
      throw new Error('Accepted runtime is unavailable');
    }
    const control = sandboxControlRpc(this.env, sandboxId);
    const status = await withTimeout(
      control.getStatus(),
      SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
      'Runtime status timed out'
    );
    if (!this.isCurrentAcceptedMessage(message, epoch)) return undefined;
    if (
      status.connection !== 'ready' ||
      status.physical !== 'running' ||
      status.wrapperInstanceId !== message.wrapperInstanceId
    ) {
      throw new Error('Accepted runtime is not ready');
    }
    const revision = this.readPendingInteractions()?.revision;
    const response = await withTimeout(
      control.request({
        operation: 'session.sync',
        session: {
          sessionId: metadata.identity.sessionId,
          kiloSessionId,
          directory: this.directory(metadata),
        },
        payload: {},
      }),
      SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
      'Session sync timed out'
    );
    if (!this.isCurrentAcceptedMessage(message, epoch)) return undefined;
    if (!response.ok) throw new Error('Session sync failed');
    const result = sessionSyncResultSchema.parse(response.result);
    if (this.readPendingInteractions()?.revision === revision) {
      this.ctx.storage.kv.put(PENDING_INTERACTIONS_KEY, {
        revision: (revision ?? 0) + 1,
        questions: result.questions,
        permissions: result.permissions,
      });
    }
    persistSandboxControlSessionEvent({
      sessionId: metadata.identity.sessionId,
      payload: {
        type: 'session.status',
        properties: { sessionID: kiloSessionId, status: result.status },
      },
      eventQueries: this.eventQueries,
      broadcast: event => this.broadcastStoredEvent(event),
    });
    return result;
  }

  private async derivePendingInteractions(): Promise<
    { questions: unknown[]; permissions: unknown[] } | undefined
  > {
    const epoch = this.terminalLifecycle.captureEpoch();
    if (epoch === null) return undefined;
    const accepted = this.loadMessages().find(message => message.state === 'accepted');
    if (accepted) {
      try {
        await this.syncAcceptedMessage(accepted, epoch);
      } catch {
        logger
          .withFields({ sessionId: this.sessionId })
          .warn('Pending interaction sync unavailable');
      }
    }
    if (!this.terminalLifecycle.isCurrent(epoch)) return undefined;
    const snapshot = this.readPendingInteractions();
    return snapshot
      ? { questions: snapshot.questions, permissions: snapshot.permissions }
      : undefined;
  }

  private async deriveQueuedMessages() {
    return streamQueuedSnapshots(this.loadMessages(), Date.now());
  }

  private async deriveCloudStatus() {
    return streamCloudStatus(this.loadMessages());
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
    if (!this.terminalLifecycle.isCurrent(epoch) || this.pendingRuntimeCleanup()) {
      throw new Error('No wrapper found for session');
    }
    const response = await withTimeout(
      sandboxControlRpc(this.env, sandboxId).request({
        operation,
        session: {
          sessionId,
          kiloSessionId,
          directory: this.directory(metadata),
        },
        payload,
      }),
      SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
      'Session interaction timed out'
    );
    if (!this.terminalLifecycle.isCurrent(epoch) || this.pendingRuntimeCleanup()) {
      throw new Error('No wrapper found for session');
    }
    if (!response.ok) {
      throw new Error(response.error?.message ?? 'Control request failed');
    }
    if (operation === 'session.permission.resolve')
      sessionPermissionResolveResultSchema.parse(response.result);
    else sessionQuestionResolveResultSchema.parse(response.result);
    return { success: true };
  }

  private directory(metadata: SessionMetadata): string {
    return (
      metadata.workspace?.workspacePath ??
      getSessionWorkspacePath(
        metadata.identity.orgId,
        metadata.identity.userId,
        metadata.identity.sessionId
      )
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

  private isCurrentEventRuntime(wrapperInstanceId?: string): boolean {
    if (wrapperInstanceId === undefined) return true;
    if (this.pendingRuntimeCleanup()?.wrapperInstanceId === wrapperInstanceId) return false;
    const messages = this.loadMessages();
    const current =
      messages.find(message => message.state === 'accepted') ??
      messages.find(message => message.state === 'queued');
    const expected =
      current?.wrapperInstanceId ??
      messages.findLast(message => message.wrapperInstanceId)?.wrapperInstanceId;
    return expected === undefined || expected === wrapperInstanceId;
  }

  private loadMessages(): MessageRecord[] {
    if (this.terminalLifecycle.isBlocked()) return [];
    return this.ctx.storage.kv.get<MessageRecord[]>(MESSAGES_KEY) ?? [];
  }

  private saveMessages(messages: MessageRecord[], epoch?: number): boolean {
    const currentEpoch = epoch ?? this.terminalLifecycle.captureEpoch();
    if (currentEpoch === null || !this.terminalLifecycle.isCurrent(currentEpoch)) return false;
    const events: StoredEvent[] = [];
    this.ctx.storage.transactionSync(() => {
      const before = this.loadMessages();
      const previousById = new Map(before.map(message => [message.messageId, message]));
      const queuedHeadId = nextQueuedMessageId(before);
      const now = Date.now();
      const next = messages.map(message => {
        const previous = previousById.get(message.messageId);
        if (previous && previous.state !== 'queued' && previous.state !== 'accepted')
          return previous;
        if (message.state === 'queued') return message;
        if (message.state === 'accepted') {
          if (previous?.state !== 'accepted') {
            const event = this.persistMessageLifecycleEvent(message);
            if (event) events.push(event);
          }
          return message;
        }
        const terminal = { ...message, terminalAt: message.terminalAt ?? now };
        if (previous?.state === 'accepted' || queuedHeadId === message.messageId) {
          const interactions = this.readPendingInteractions();
          this.ctx.storage.kv.put(PENDING_INTERACTIONS_KEY, {
            revision: (interactions?.revision ?? 0) + 1,
            questions: [],
            permissions: [],
          });
        }
        const event = this.persistMessageLifecycleEvent(terminal);
        if (event) events.push(event);
        if (terminal.preparationAttemptId) {
          events.push(
            ...finalizePreparationAttempt(
              this.eventQueries,
              terminal.preparationAttemptId,
              terminal.state === 'completed'
                ? { status: 'completed', timestamp: terminal.terminalAt }
                : {
                    status: 'failed',
                    safeError:
                      terminal.state === 'cancelled'
                        ? 'The message was interrupted'
                        : safeErrorFromQueueReason(terminal.failedReason ?? 'environment_failed'),
                    timestamp: terminal.terminalAt,
                  }
            )
          );
        }
        return terminal;
      });
      this.ctx.storage.kv.put(MESSAGES_KEY, next);
    });
    for (const event of events) this.broadcastStoredEvent(event);
    return true;
  }

  private persistMessageLifecycleEvent(message: MessageRecord): StoredEvent | undefined {
    const accepted = message.state === 'accepted';
    const completed = message.state === 'completed';
    const streamEventType = accepted
      ? 'cloud.message.sent'
      : completed
        ? 'cloud.message.completed'
        : 'cloud.message.failed';
    const sessionId = this.requireSessionId();
    const timestamp = (accepted ? message.acceptedAt : message.terminalAt) ?? Date.now();
    const payload = JSON.stringify(
      accepted
        ? { messageId: message.messageId, delivery: 'sent' }
        : completed
          ? { messageId: message.messageId, status: 'completed', delivery: 'sent', accepted: true }
          : failedMessageSnapshot(message, timestamp)
    );
    const id = this.eventQueries.insertUnique({
      executionId: '',
      sessionId,
      streamEventType,
      payload,
      timestamp,
      entityId: `${accepted ? 'accepted-message' : 'terminal-message'}/${message.messageId}`,
    });
    if (id === null) return undefined;
    return {
      id,
      execution_id: '',
      session_id: sessionId,
      stream_event_type: streamEventType,
      payload,
      timestamp,
    };
  }

  private requireSessionId(): SessionId {
    if (!this.sessionId) throw new Error('SandboxSession is missing session id');
    return this.sessionId;
  }
}
