/**
 * SQLite-backed Durable Object for cloud agent session metadata.
 * Automatically cleans up after 90 days of inactivity.
 * Uses RPC methods for type-safe communication.
 */

import { DurableObject } from 'cloudflare:workers';
import type { OperationResult } from './types.js';
import {
  parseSessionMetadata,
  serializeSessionMetadata,
  type SessionMetadata,
} from './session-metadata.js';
import { readProfileBundle, type SessionProfileBundle } from '../session-profile.js';
import type { CallbackJob, CallbackTarget } from '../callbacks/index.js';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { logger } from '../logger.js';
import { BUILTIN_AGENT_MODES, Limits } from '../schema.js';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import migrations from '../../drizzle/migrations';
import {
  createExecutionQueries,
  createEventQueries,
  createLeaseQueries,
  type ExecutionQueries,
  type EventQueries,
  type LeaseQueries,
  type LeaseAcquireError,
} from '../session/queries/index.js';
import {
  type ExecutionId,
  type EventSourceId,
  type EventId,
  type SessionId,
  type UserId,
} from '../types/ids.js';
import type {
  ExecutionMetadata,
  AddExecutionParams,
  UpdateExecutionStatusParams,
  LatestAssistantMessage,
  AssistantMessagePart,
} from '../session/types.js';
import type { ExecutionStatus } from '../core/execution.js';
import type { Result } from '../lib/result.js';
import type { AddExecutionError, UpdateStatusError } from '../session/queries/executions.js';
import {
  createStreamHandler,
  type StreamHandler,
  type QueuedMessageSnapshot,
} from '../websocket/stream.js';
import {
  createIngestHandler,
  type IngestHandler,
  type IngestDOContext,
} from '../websocket/ingest.js';
import type { StoredEvent } from '../websocket/types.js';
import type { WrapperCommand, CloudStatusData } from '../shared/protocol.js';
import { commandsOrDefault, type SlashCommandInfo } from '../shared/slash-commands.js';
import type {
  AcceptedExecutionTurn,
  AgentSelection,
  ExecutionDeliveryContext,
  ExecutionTurnSubmission,
  MessageDeliveryRequest,
  AdmitAcceptedSessionMessageRequest,
  LegacyRegisteredInitialAdmissionRequest,
  MessageDeliveryResult,
  SessionMessageAdmissionResult,
  SubmittedSessionMessageRequest,
  SessionFinalization,
} from '../execution/types.js';
import { renderExecutionTurnContent } from '../execution/types.js';
import type { Env as WorkerEnv, SandboxId } from '../types.js';
import { generateSandboxId } from '../sandbox-id.js';

import { validateStreamTicket } from '../auth.js';
import { resolveTerminalWrapperClient, type TerminalWrapperClient } from '../terminal/access.js';
import type { WrapperPty } from '../kilo/wrapper-client.js';
import {
  countPendingSessionMessages,
  findPendingSessionMessageByMessageId,
  resolvePendingSessionMessageIntent,
} from '../session/pending-messages.js';
import {
  createSessionMessageQueue,
  PENDING_FLUSH_DEBOUNCE_MS,
  type SessionMessageQueue,
} from '../session/session-message-queue.js';
import {
  clearWrapperRuntimeIdentity,
  getWrapperRuntimeState,
} from '../session/wrapper-runtime-state.js';
import {
  getSessionMessageState,
  listNonTerminalAcceptedMessages,
  markMessageAccepted,
  putSessionMessageState,
  type TerminalizeParams,
} from '../session/session-message-state.js';
import {
  createMessageSettlementOutbox,
  type MessageSettlementOutbox,
} from '../session/message-settlement-outbox.js';
import {
  createAgentRuntime,
  type AgentRuntime,
  type AgentRuntimeAcceptedDelivery,
  type AgentRuntimeOrchestrator,
  type AgentRuntimeStopReason,
} from '../session/agent-runtime.js';
import { createWrapperSupervisor, type WrapperSupervisor } from '../session/wrapper-supervisor.js';

// ---------------------------------------------------------------------------
// Alarm Constants
// ---------------------------------------------------------------------------

/** Reaper alarm interval: 5 minutes */
const REAPER_INTERVAL_MS_DEFAULT = 5 * 60 * 1000;
/** Longer reaper interval when idle: 1 hour */
const REAPER_IDLE_INTERVAL_MS = 60 * 60 * 1000;

/** Event retention period: 90 days (aligns with session TTL) */
const EVENT_RETENTION_MS = Limits.SESSION_TTL_MS;

/** Storage key for tracking last activity timestamp */
const LAST_ACTIVITY_KEY = 'last_activity';

/** Kilo server idle timeout: 15 minutes */
const KILO_SERVER_IDLE_TIMEOUT_MS_DEFAULT = 15 * 60 * 1000;

/** Default per-execution wall-clock deadline: 60 minutes */

type TerminalSizeInput = {
  cols: number;
  rows: number;
};

type TerminalCreateInput = Partial<TerminalSizeInput>;

function validateModeAgainstRuntimeAgents(
  metadata: SessionMetadata,
  mode = metadata.agent?.mode
): string | null {
  if (!mode || BUILTIN_AGENT_MODES.has(mode)) return null;

  const knownSlugs = new Set((readProfileBundle(metadata).runtimeAgents ?? []).map(a => a.slug));
  if (knownSlugs.has(mode)) return null;

  return `Mode "${mode}" is not a built-in and does not match any runtimeAgents on this session`;
}

/**
 * Concatenate text content from assistant message parts.
 * Parts have a loose `Record<string, unknown>` type; only include those with
 * `type === 'text'` and a string `text` field.
 */
function extractAssistantTextFromParts(parts: AssistantMessagePart[]): string {
  const pieces: string[] = [];
  for (const part of parts) {
    if (part.type !== 'text') continue;
    const text = part.text;
    if (typeof text === 'string' && text.length > 0) {
      pieces.push(text);
    }
  }
  return pieces.join('').trim();
}

type GroupedRegisterSessionInput = {
  identity: SessionMetadata['identity'];
  auth: SessionMetadata['auth'];
  message: {
    initialMessageId?: string;
    turn: ExecutionTurnSubmission;
  };
  agent: AgentSelection & {
    appendSystemPrompt?: string;
  };
  repository?:
    | {
        type: 'github';
        repo: string;
        branch?: string;
      }
    | {
        type: 'gitlab';
        url: string;
        branch?: string;
      }
    | {
        type: 'git';
        url: string;
        token?: string;
        branch?: string;
      };
  profile?: SessionProfileBundle;
  finalization?: SessionFinalization;
  callback?: SessionMetadata['callback'];
  workspace?: Pick<
    NonNullable<SessionMetadata['workspace']>,
    'sandboxId' | 'shallow' | 'devcontainerRequested'
  >;
};

type CreateSessionWithInitialAdmissionInput = Omit<GroupedRegisterSessionInput, 'message'> & {
  message: {
    initialTurn: AcceptedExecutionTurn;
  };
};

function isSameAcceptedInitialTurn(
  metadata: SessionMetadata,
  initialTurn: AcceptedExecutionTurn
): boolean {
  const stored = metadata.initialMessage;
  if (!stored || stored.id !== initialTurn.messageId) return false;
  if (initialTurn.type === 'command') {
    return (
      stored.turn?.type === 'command' &&
      stored.turn.command === initialTurn.command &&
      stored.turn.arguments === initialTurn.arguments
    );
  }
  return (
    stored.turn?.type === 'prompt' &&
    stored.turn.prompt === initialTurn.prompt &&
    JSON.stringify(stored.turn.images) === JSON.stringify(initialTurn.images)
  );
}

function isSameInitialAdmissionConfiguration(
  metadata: SessionMetadata,
  input: CreateSessionWithInitialAdmissionInput
): boolean {
  return (
    metadata.agent?.mode === input.agent.mode &&
    metadata.agent.model === input.agent.model &&
    metadata.agent.variant === input.agent.variant &&
    metadata.finalization?.autoCommit === input.finalization?.autoCommit &&
    metadata.finalization?.condenseOnComplete === input.finalization?.condenseOnComplete
  );
}

export class CloudAgentSession extends DurableObject<WorkerEnv> {
  private executionQueries: ExecutionQueries;
  private eventQueries: EventQueries;
  private leaseQueries: LeaseQueries;
  private streamHandler?: StreamHandler;
  private ingestHandler?: IngestHandler;
  private streamHandlerSessionId?: SessionId;
  private ingestHandlerSessionId?: SessionId;
  private sessionId?: SessionId;
  private orchestrator?: AgentRuntimeOrchestrator;
  private agentRuntime?: AgentRuntime;
  private messageSettlementOutbox?: MessageSettlementOutbox;
  private sessionMessageQueue?: SessionMessageQueue;
  private wrapperSupervisor?: WrapperSupervisor;
  private isTerminalStatus(
    status: ExecutionStatus
  ): status is 'completed' | 'failed' | 'interrupted' {
    return status === 'completed' || status === 'failed' || status === 'interrupted';
  }

  private async enqueueCallbackNotification(
    execution: ExecutionMetadata,
    status: 'completed' | 'failed' | 'interrupted',
    error?: string,
    gateResult?: 'pass' | 'fail'
  ): Promise<void> {
    // TODO(cleanup): This is a rollout-only compatibility adapter for
    // pre-message-queue executions that still complete through
    // updateExecutionStatus(addExecution(...)). Once old in-flight wrappers and
    // Durable Object state have drained, remove this path and rely exclusively
    // on MessageSettlementOutbox, where deprecated executionId is just a
    // messageId alias.
    const { messageId } = execution;
    const metadata = await this.getMetadata();
    const callbackQueue = this.env.CALLBACK_QUEUE;

    const callbackTarget = metadata?.callback?.target;
    if (!metadata || !callbackTarget || !callbackQueue) {
      return;
    }

    logger.info('Callback enqueue requested', {
      cloudAgentSessionId: metadata.identity.sessionId,
      kiloSessionId: metadata.auth.kiloSessionId,
      messageId,
      callbackTarget: this.redactCallbackTargetUrl(callbackTarget.url),
    });

    const resolvedSessionId = await this.resolveSessionId(metadata.identity.sessionId as SessionId);
    const sessionId = resolvedSessionId ?? metadata.identity.sessionId ?? '';

    const lastAssistantMessageText =
      status === 'completed' ? await this.getLatestAssistantMessageText() : undefined;

    const payload: CallbackJob['payload'] = {
      sessionId,
      cloudAgentSessionId: sessionId,
      executionId: execution.executionId,
      status,
      errorMessage: error,
      lastSeenBranch: metadata.repository?.upstreamBranch,
      kiloSessionId: metadata.auth.kiloSessionId,
      gateResult,
      lastAssistantMessageText,
    };

    if (messageId) {
      payload.messageId = messageId;
      payload.idempotencyKey = messageId;
    }

    const callbackJob: CallbackJob = {
      target: callbackTarget,
      payload,
    };

    try {
      await callbackQueue.send(callbackJob);
      logger
        .withFields({
          sessionId,
          messageId,
          status,
          callbackTarget: this.redactCallbackTargetUrl(callbackTarget.url),
        })
        .info('Callback job enqueued');
    } catch (err) {
      logger
        .withFields({
          sessionId,
          messageId,
          error: err instanceof Error ? err.message : String(err),
        })
        .error('Failed to enqueue callback job');
    }
  }

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);

    // Extract sessionId from DO name pattern: "userId:sessionId"
    // The DO name is set by the worker when creating the stub.
    // Split on the *last* colon because userId may contain colons
    // (e.g. "oauth/google:12345:agent_abc" → sessionId = "agent_abc").
    const doName = ctx.id.name;
    const lastColon = doName?.lastIndexOf(':') ?? -1;
    const sessionIdPart = doName && lastColon > 0 ? doName.slice(lastColon + 1) : undefined;
    this.sessionId = sessionIdPart ? (sessionIdPart as SessionId) : undefined;

    const db = drizzle(ctx.storage, { logger: false });
    const rawSql = ctx.storage.sql;

    this.executionQueries = createExecutionQueries(ctx.storage);
    this.eventQueries = createEventQueries(db, rawSql);
    this.leaseQueries = createLeaseQueries(db, rawSql);

    void ctx.blockConcurrencyWhile(async () => {
      await migrate(db, migrations);
      await this.ensureAlarmScheduled();
    });
  }

  /**
   * Resolve the canonical sessionId for this DO.
   * Prefer metadata, then the expected sessionId, then existing value.
   */
  private async resolveSessionId(expected?: SessionId): Promise<SessionId | null> {
    if (this.sessionId?.startsWith('sess_')) {
      this.sessionId = undefined;
    }

    if (this.sessionId) {
      if (expected && this.sessionId !== expected) {
        throw new Error(`SessionId mismatch: ${expected} != ${this.sessionId}`);
      }
      return this.sessionId;
    }

    const rawMetadata = await this.ctx.storage.get('metadata');
    const metadata = rawMetadata ? parseSessionMetadata(rawMetadata) : null;
    if (metadata?.identity.sessionId) {
      if (expected && metadata.identity.sessionId !== expected) {
        throw new Error(`SessionId mismatch: ${expected} != ${metadata.identity.sessionId}`);
      }
      this.sessionId = metadata.identity.sessionId as SessionId;
      return this.sessionId;
    }

    if (expected) {
      this.sessionId = expected;
      return expected;
    }

    return null;
  }

  private async requireSessionId(expected?: SessionId): Promise<SessionId> {
    const sessionId = await this.resolveSessionId(expected);
    if (!sessionId) {
      throw new Error('SessionId is not available');
    }
    return sessionId;
  }

  private getMessageSettlementOutbox(): MessageSettlementOutbox {
    if (!this.messageSettlementOutbox) {
      this.messageSettlementOutbox = createMessageSettlementOutbox({
        storage: this.ctx.storage,
        getMetadata: () => this.getMetadata(),
        requireSessionId: () => this.requireSessionId(),
        resolveCallbackSessionId: async metadata => {
          const resolvedSessionId = await this.resolveSessionId(
            metadata?.identity.sessionId as SessionId
          );
          return resolvedSessionId ?? metadata?.identity.sessionId ?? '';
        },
        getCallbackQueue: () => this.env.CALLBACK_QUEUE,
        getAssistantMessageForUserMessage: (sessionId, kiloSessionId, parentMessageId) =>
          this.eventQueries.getAssistantMessageForUserMessage(
            sessionId,
            kiloSessionId,
            parentMessageId
          ),
        ensureTerminalMessageEvent: event => {
          this.ensureTerminalMessageEvent({
            executionId: '' as EventSourceId,
            ...event,
          });
        },
        hasObservedWrapperIdle: async () => {
          const state = await getWrapperRuntimeState(this.ctx.storage);
          return state.lastWrapperIdleAt !== undefined;
        },
        requestAlarmAtOrBefore: deadline => this.scheduleAlarmAtOrBefore(deadline),
        getSessionIdForLogs: () => this.sessionId,
      });
    }

    return this.messageSettlementOutbox;
  }

  private getAgentRuntime(): AgentRuntime {
    if (!this.agentRuntime) {
      this.agentRuntime = createAgentRuntime({
        storage: this.ctx.storage,
        env: this.env,
        getMetadata: () => this.getMetadata(),
        getSessionIdForLogs: () => this.sessionId,
        sendToWrapper: (ingestTagId, command, fence) =>
          this.sendToWrapper(ingestTagId, command, fence),
        getOrchestratorOverride: () => this.orchestrator,
      });
    }

    return this.agentRuntime;
  }

  private getWrapperSupervisor(): WrapperSupervisor {
    if (!this.wrapperSupervisor) {
      this.wrapperSupervisor = createWrapperSupervisor({
        storage: this.ctx.storage,
        agentRuntime: {
          sendPing: ingestTagId => this.getAgentRuntime().sendPing(ingestTagId),
          stopWrapperProcess: reason => this.stopCurrentWrapperProcess(reason),
        },
        messageSettlementOutbox: this.getMessageSettlementOutbox(),
        sessionMessageQueue: this.getSessionMessageQueue(),
        getMetadata: () => this.getMetadata(),
        getAssistantMessageForUserMessage: (sessionId, kiloSessionId, parentMessageId) =>
          this.eventQueries.getAssistantMessageForUserMessage(
            sessionId,
            kiloSessionId,
            parentMessageId
          ),
        hasActiveIngestConnection: async params =>
          (await this.getIngestHandler()).hasActiveConnection(params),
        clearInterruptRequest: () => this.executionQueries.clearInterrupt(),
        getSessionIdForLogs: () => this.sessionId,
      });
    }

    return this.wrapperSupervisor;
  }

  private async getPendingMessageDeliveryContext(): Promise<ExecutionDeliveryContext | null> {
    const metadata = await this.getMetadata();
    if (!metadata) return null;

    const sandboxId =
      metadata.workspace?.sandboxId ??
      (await generateSandboxId(
        this.env.PER_SESSION_SANDBOX_ORG_IDS,
        metadata.identity.orgId,
        metadata.identity.userId,
        metadata.identity.sessionId,
        metadata.identity.botId
      ));

    return {
      sessionId: metadata.identity.sessionId as SessionId,
      userId: metadata.identity.userId as UserId,
      orgId: metadata.identity.orgId,
      sandboxId,
      kiloSessionId: metadata.auth.kiloSessionId,
      metadata,
    };
  }

  private getSessionMessageQueue(): SessionMessageQueue {
    if (!this.sessionMessageQueue) {
      this.sessionMessageQueue = createSessionMessageQueue({
        storage: this.ctx.storage,
        getMetadata: () => this.getMetadata(),
        requireSessionId: () => this.requireSessionId(),
        validateModeAgainstRuntimeAgents,
        getDeliveryContext: () => this.getPendingMessageDeliveryContext(),
        deliver: plan => this.executeDirectly(plan),
        ensureQueuedMessageEvent: event => {
          this.ensureQueuedMessageEvent({
            executionId: '' as EventSourceId,
            ...event,
          });
        },
        ensureAcceptedMessageEffects: messageId => this.ensureAcceptedMessageEffects(messageId),
        persistTerminalTransition: (messageId, params, options) =>
          this.getMessageSettlementOutbox().persistTerminalTransition(messageId, params, options),
        repairTerminalMessageEffects: messageId =>
          this.getMessageSettlementOutbox().repairTerminalMessageEffects(messageId),
        finalizeTerminalCallbackEffects: options =>
          this.getMessageSettlementOutbox().finalizeIdleBatchCallbackIfReady(options),
        requestAlarmAtOrBefore: deadline => this.scheduleAlarmAtOrBefore(deadline),
        getSessionIdForLogs: () => this.sessionId,
      });
    }

    return this.sessionMessageQueue;
  }

  private async getStreamHandler(expected?: SessionId): Promise<StreamHandler> {
    const sessionId = await this.requireSessionId(expected);
    if (!this.streamHandler || this.streamHandlerSessionId !== sessionId) {
      this.streamHandler = createStreamHandler(this.ctx, this.eventQueries, sessionId, {
        deriveCloudStatus: () => this.deriveCloudStatus(),
        deriveQueuedMessages: () => this.deriveQueuedMessages(),
        getAvailableCommands: () => this.getAvailableCommands(),
      });
      this.streamHandlerSessionId = sessionId;
    }
    return this.streamHandler;
  }

  private async getIngestHandler(): Promise<IngestHandler> {
    const sessionId = await this.requireSessionId();
    if (!this.ingestHandler || this.ingestHandlerSessionId !== sessionId) {
      // Create DO context for the ingest handler to call back into the DO
      const doContext: IngestDOContext = {
        updateKiloSessionId: (id: string) => this.updateKiloSessionId(id),
        updateUpstreamBranch: (branch: string) => this.updateUpstreamBranch(branch),
        setAvailableCommands: (commands: SlashCommandInfo[]) => this.setAvailableCommands(commands),
        wrapperSupervisor: this.getWrapperSupervisor(),
        keepContainerAlive: () => {
          void this.keepContainerAlive();
        },
        terminalizeSessionMessageOnce: async (messageId, params, wrapperRunId) => {
          await this.ensureAcceptedMessageBeforeTerminal(messageId, wrapperRunId);
          await this.terminalizeSessionMessageOnce(messageId, params as TerminalizeParams);
        },
      };

      this.ingestHandler = createIngestHandler(
        this.ctx,
        this.eventQueries,
        sessionId,
        event => this.broadcastEvent(event),
        doContext
      );
      this.ingestHandlerSessionId = sessionId;
    }
    return this.ingestHandler;
  }

  private isAllowedWebSocketOrigin(origin: string | null): boolean {
    const allowedOrigins = (this.env.WS_ALLOWED_ORIGINS || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);

    const isRealOrigin = origin !== null && origin !== 'null';
    return allowedOrigins.length === 0 || !isRealOrigin || allowedOrigins.includes(origin);
  }

  // ---------------------------------------------------------------------------
  // HTTP/WebSocket Routing
  // ---------------------------------------------------------------------------

  /**
   * Handle incoming HTTP requests and WebSocket upgrades.
   * Routes to appropriate handler based on URL pathname.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Route WebSocket upgrade requests
    if (url.pathname === '/stream') {
      const sessionIdParam = url.searchParams.get('cloudAgentSessionId') as SessionId | null;
      const ticket = url.searchParams.get('ticket');
      const origin = request.headers.get('Origin');

      if (!this.isAllowedWebSocketOrigin(origin)) {
        logger
          .withFields({ origin, sessionId: sessionIdParam })
          .warn('DO /stream: Origin not allowed');
        return new Response('Origin not allowed', { status: 403 });
      }

      if (!sessionIdParam) {
        return new Response('Missing cloudAgentSessionId', { status: 400 });
      }

      const authResult = validateStreamTicket(ticket, this.env.NEXTAUTH_SECRET);
      if (!authResult.success) {
        return new Response(authResult.error, { status: 401 });
      }

      const ticketSessionId =
        authResult.payload.cloudAgentSessionId || authResult.payload.sessionId;
      if (!ticketSessionId || ticketSessionId !== sessionIdParam) {
        return new Response('Invalid ticket session', { status: 401 });
      }

      const streamHandler = await this.getStreamHandler(sessionIdParam ?? undefined);
      const response = await streamHandler.handleStreamRequest(request);

      // Request fresh kilo state from wrapper if connected.
      // The wrapper will respond with regular kilocode events (session.status,
      // question.asked, permission.asked) that are broadcast via the normal pipeline.
      this.requestKiloSnapshot();

      return response;
    }

    // Route ingest WebSocket (internal only - from queue consumer)
    if (url.pathname === '/ingest') {
      const ingestHandler = await this.getIngestHandler();
      return ingestHandler.handleIngestRequest(request);
    }

    // No matching route
    return new Response('Not Found', { status: 404 });
  }

  // ---------------------------------------------------------------------------
  // WebSocket Lifecycle Methods (Hibernation API)
  // ---------------------------------------------------------------------------

  /**
   * Handle incoming messages from WebSocket clients.
   * Distinguishes between /stream (server-push only) and /ingest connections.
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const tags = this.ctx.getTags(ws);

    // Check if this is an ingest connection
    if (tags.some(tag => tag.startsWith('ingest:'))) {
      const ingestHandler = await this.getIngestHandler();
      await ingestHandler.handleIngestMessage(ws, message);
      return;
    }

    // Stream connections are server-push only, ignore client messages
    // Future: could handle client commands like subscribe/unsubscribe
  }

  /**
   * Handle WebSocket close events.
   * Cleans up ingest connections and logs the disconnection.
   */
  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    const tags = this.ctx.getTags(ws);

    // Clean up ingest connection tracking
    if (tags.some(tag => tag.startsWith('ingest:'))) {
      const ingestHandler = await this.getIngestHandler();
      const disconnected = await ingestHandler.handleIngestClose(ws);

      if (disconnected) {
        const wrapperSupervisor = this.getWrapperSupervisor();
        await wrapperSupervisor.onDisconnected({
          disconnected,
          wsCloseCode: code,
          wsCloseReason: reason,
        });
        for (const deadline of await wrapperSupervisor.nextMaintenanceDeadlines()) {
          await this.scheduleAlarmAtOrBefore(deadline);
        }
      }
    }

    logger.debug(`WebSocket closed: code=${code}, reason=${reason}, wasClean=${wasClean}`);
  }

  /**
   * Handle WebSocket errors.
   * Logs the error for debugging purposes.
   */
  async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    logger
      .withFields({
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      })
      .error('WebSocket error');
  }

  // ---------------------------------------------------------------------------
  // Event Broadcasting
  // ---------------------------------------------------------------------------

  /**
   * Broadcast a new event to all connected /stream clients.
   * Called from the ingest handler when new events are stored.
   *
   * @param event - The stored event to broadcast
   */
  broadcastEvent(event: StoredEvent): void {
    if (this.streamHandler) {
      this.streamHandler.broadcastEvent(event);
      return;
    }

    void this.getStreamHandler()
      .then(handler => {
        handler.broadcastEvent(event);
      })
      .catch(error => {
        logger
          .withFields({
            error: error instanceof Error ? error.message : String(error),
          })
          .warn('Failed to broadcast event - stream handler unavailable');
      });
  }

  private insertAndBroadcastEvent(params: {
    executionId: EventSourceId;
    sessionId: string;
    streamEventType: string;
    payload: string;
    timestamp: number;
  }): void {
    const eventId = this.eventQueries.insert({
      executionId: params.executionId,
      sessionId: params.sessionId,
      streamEventType: params.streamEventType,
      payload: params.payload,
      timestamp: params.timestamp,
    });
    this.broadcastEvent({
      id: eventId,
      execution_id: params.executionId,
      session_id: params.sessionId,
      stream_event_type: params.streamEventType,
      payload: params.payload,
      timestamp: params.timestamp,
    });
  }

  private ensureTerminalMessageEvent(params: {
    executionId: EventSourceId;
    sessionId: string;
    streamEventType: string;
    payload: string;
    timestamp: number;
    entityId: string;
  }): void {
    const eventId = this.eventQueries.insertUnique({
      executionId: params.executionId,
      sessionId: params.sessionId,
      streamEventType: params.streamEventType,
      payload: params.payload,
      timestamp: params.timestamp,
      entityId: params.entityId,
    });
    if (eventId === null) return;
    this.broadcastEvent({
      id: eventId,
      execution_id: params.executionId,
      session_id: params.sessionId,
      stream_event_type: params.streamEventType,
      payload: params.payload,
      timestamp: params.timestamp,
    });
  }

  private ensureQueuedMessageEvent(params: {
    executionId: EventSourceId;
    sessionId: string;
    streamEventType: string;
    payload: string;
    timestamp: number;
    entityId: string;
  }): void {
    const eventId = this.eventQueries.insertUnique({
      executionId: params.executionId,
      sessionId: params.sessionId,
      streamEventType: params.streamEventType,
      payload: params.payload,
      timestamp: params.timestamp,
      entityId: params.entityId,
    });
    if (eventId === null) return;
    this.broadcastEvent({
      id: eventId,
      execution_id: params.executionId,
      session_id: params.sessionId,
      stream_event_type: params.streamEventType,
      payload: params.payload,
      timestamp: params.timestamp,
    });
  }

  /**
   * Broadcast an event to connected /stream clients without persisting it.
   * Used for transient progress events (e.g. `preparing`) that have no
   * replay value — avoids stale indicators on WebSocket reconnect.
   */
  private broadcastVolatileEvent(params: {
    executionId: EventSourceId;
    sessionId: string;
    streamEventType: string;
    payload: string;
    timestamp: number;
  }): void {
    this.broadcastEvent({
      id: 0 as EventId,
      execution_id: params.executionId,
      session_id: params.sessionId,
      stream_event_type: params.streamEventType,
      payload: params.payload,
      timestamp: params.timestamp,
    });
  }

  /**
   * Derive current cloud infrastructure status from execution state.
   * Used to populate the `connected` event on WebSocket upgrade.
   */
  private async deriveCloudStatus(): Promise<CloudStatusData['cloudStatus'] | null> {
    const metadata = await this.getMetadata();
    if (metadata?.lifecycle.preparedAt) return { type: 'ready' };

    const pendingCount = await countPendingSessionMessages(this.ctx.storage);
    return pendingCount > 0 ? { type: 'preparing' } : null;
  }

  /**
   * List user messages that are currently queued and awaiting delivery, so
   * the /stream handler can resurface them on WebSocket connect. This is
   * volatile catch-up state — nothing here is persisted into the event log.
   *
   * Pending messages (including the initial message) live under
   * `pending_message:*` with their durable `messageId`. Legacy V2 responses may
   * project that identity as `executionId`, but no separate current execution
   * identity exists in this snapshot path. These are the messages a reconnecting
   * client would otherwise miss because the client opts out of event-log replay.
   */
  private async deriveQueuedMessages(): Promise<QueuedMessageSnapshot[]> {
    return this.getSessionMessageQueue().snapshotForStreamConnect();
  }

  /**
   * Get count of connected stream clients.
   *
   * @returns Number of active WebSocket connections
   */
  getConnectedClientCount(): number {
    return this.streamHandler?.getConnectedClientCount() ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Metadata RPC Methods
  // ---------------------------------------------------------------------------
  /**
   * Get session metadata.
   * Returns null if no metadata has been written yet (e.g., before first CLI execution).
   */
  async getMetadata(): Promise<SessionMetadata | null> {
    const metadata = await this.ctx.storage.get('metadata');
    return metadata ? parseSessionMetadata(metadata) : null;
  }

  async getLatestAssistantMessage(): Promise<LatestAssistantMessage | null> {
    const sessionId = await this.requireSessionId();
    const metadata = await this.getMetadata();
    if (!metadata?.auth.kiloSessionId) return null;
    return this.eventQueries.getLatestAssistantMessage(sessionId, metadata.auth.kiloSessionId);
  }

  private async getLatestAssistantMessageText(): Promise<string | undefined> {
    try {
      const message = await this.getLatestAssistantMessage();
      if (!message) return undefined;
      const text = extractAssistantTextFromParts(message.parts);
      return text.length > 0 ? text : undefined;
    } catch (err) {
      logger
        .withFields({ error: err instanceof Error ? err.message : String(err) })
        .warn('Failed to fetch latest assistant message for callback');
      return undefined;
    }
  }

  /**
   * Update session metadata with validation.
   * Throws an error if validation fails.
   */
  async updateMetadata(data: unknown): Promise<void> {
    const newMetadata = serializeSessionMetadata(parseSessionMetadata(data));
    await this.ctx.storage.put('metadata', newMetadata);

    // Track activity for session TTL
    await this.updateLastActivity();
  }

  /**
   * Mark this session as interrupted.
   * Used to signal streaming generators to stop when interruptSession is called.
   */
  async markAsInterrupted(): Promise<void> {
    await this.ctx.storage.put('interrupted', true);
  }

  /**
   * Check if this session has been marked as interrupted.
   */
  async isInterrupted(): Promise<boolean> {
    const interrupted = await this.ctx.storage.get<boolean>('interrupted');
    return interrupted ?? false;
  }

  /**
   * Clear the interrupted flag.
   * Should be called when starting a new execution after an interrupt.
   */
  async clearInterrupted(): Promise<void> {
    await this.ctx.storage.delete('interrupted');
  }

  /**
   * Update the Kilo CLI session ID for continuation.
   * This ID is captured from the session_created event emitted by the CLI.
   */
  async updateKiloSessionId(kiloSessionId: string): Promise<void> {
    const metadata = await this.getMetadata();
    if (!metadata) {
      throw new Error('Cannot update kiloSessionId: session metadata not found');
    }

    const updated = {
      ...metadata,
      auth: {
        ...metadata.auth,
        kiloSessionId,
      },
      lifecycle: {
        ...metadata.lifecycle,
        version: Date.now(),
      },
    };

    await this.updateMetadata(updated);
  }

  /**
   * Update the callback target for this session.
   * This allows redirecting completion callbacks to a new URL (e.g., for follow-up reviews).
   */
  private async updateCallbackTarget(callbackTarget: CallbackTarget): Promise<void> {
    const metadata = await this.getMetadata();
    if (!metadata) {
      throw new Error('Cannot update callbackTarget: session metadata not found');
    }

    const updated = {
      ...metadata,
      callback: { target: callbackTarget },
      lifecycle: {
        ...metadata.lifecycle,
        version: Date.now(),
      },
    };

    await this.updateMetadata(updated);
  }

  /**
   * Persist the slash-command catalog reported by the wrapper. Stored as a
   * dedicated DO storage key (not part of session metadata) because the
   * catalog is a runtime cache derived from the kilo server, not durable
   * session config — keeping it separate avoids polluting MetadataSchema.
   */
  async setAvailableCommands(commands: SlashCommandInfo[]): Promise<void> {
    await this.ctx.storage.put('availableCommands', commands);
  }

  /** Read the cached slash-command catalog. Falls back to defaults if missing or empty. */
  async getAvailableCommands(): Promise<SlashCommandInfo[]> {
    const stored = await this.ctx.storage.get<SlashCommandInfo[]>('availableCommands');
    return commandsOrDefault(stored);
  }

  /**
   * Update the upstream branch for this session.
   * This allows capturing the branch after kilo execution without a full metadata write.
   */
  async updateUpstreamBranch(upstreamBranch: string): Promise<void> {
    const metadata = await this.getMetadata();
    if (!metadata) {
      throw new Error('Cannot update upstreamBranch: session metadata not found');
    }
    if (!metadata.repository) {
      throw new Error('Cannot update upstreamBranch: session repository metadata not found');
    }

    const updated = {
      ...metadata,
      repository: {
        ...metadata.repository,
        upstreamBranch,
      },
      lifecycle: {
        ...metadata.lifecycle,
        version: Date.now(),
      },
    };

    await this.updateMetadata(updated);
  }

  /**
   * Record kilo server activity for idle timeout tracking.
   * Called by the queue consumer after each successful execution.
   * Resets the idle timeout clock.
   */
  async recordKiloServerActivity(): Promise<void> {
    const metadata = await this.getMetadata();
    if (!metadata) {
      throw new Error('Cannot record kilo server activity: session metadata not found');
    }

    const updated = {
      ...metadata,
      lifecycle: {
        ...metadata.lifecycle,
        kiloServerLastActivity: Date.now(),
        version: Date.now(),
      },
    };

    await this.updateMetadata(updated);
  }

  // ---------------------------------------------------------------------------
  // Wrapper Communication Methods
  // ---------------------------------------------------------------------------

  /**
   * Send a command to the wrapper via its ingest WebSocket connection.
   * Used for bidirectional communication (kill, ping).
   *
   * @param ingestTagId - Fenced wrapper run tag on the ingest socket.
   * @param command - The command to send (kill, ping)
   */
  sendToWrapper(
    ingestTagId: string,
    command: WrapperCommand,
    fence?: { wrapperGeneration: number; wrapperConnectionId: string }
  ): boolean {
    const wrappers = this.ctx.getWebSockets(`ingest:${ingestTagId}`);
    let sent = false;
    for (const ws of wrappers) {
      if (fence) {
        const attachment: unknown = ws.deserializeAttachment();
        if (
          !attachment ||
          typeof attachment !== 'object' ||
          !('wrapperGeneration' in attachment) ||
          !('wrapperConnectionId' in attachment) ||
          attachment.wrapperGeneration !== fence.wrapperGeneration ||
          attachment.wrapperConnectionId !== fence.wrapperConnectionId
        ) {
          continue;
        }
      }
      ws.send(JSON.stringify(command));
      sent = true;
    }
    return sent;
  }

  /**
   * Request fresh kilo state from the wrapper.
   * The wrapper will respond with regular kilocode events (session.status,
   * question.asked, permission.asked) that flow through the normal ingest pipeline.
   * Best-effort: silently does nothing if no wrapper is connected.
   */
  private requestKiloSnapshot(): void {
    void this.getAgentRuntime().requestSnapshot();
  }

  /**
   * Interrupt accepted current wrapper-run messages and queued delivery work.
   * The optional `executionId` result remains for legacy response compatibility.
   *
   * @returns Result indicating if the interrupt was initiated
   */
  private async interruptAcceptedWrapperMessages(): Promise<{
    acceptedMessageCount: number;
    wrapperCommandSent: boolean;
  }> {
    const state = await getWrapperRuntimeState(this.ctx.storage);
    const acceptedMessages = await listNonTerminalAcceptedMessages(
      this.ctx.storage,
      state.wrapperRunId
    );
    for (const msg of acceptedMessages) {
      const transition = await this.getMessageSettlementOutbox().persistTerminalTransition(
        msg.messageId,
        {
          kind: 'interrupted',
          error: 'Message interrupted by user',
          completionSource: 'interrupt',
        },
        { allowIdleBatchWithoutObservedIdle: true }
      );
      if (!transition.state || transition.state.status !== 'interrupted') {
        throw new Error(`Failed to persist interrupted transition for message ${msg.messageId}`);
      }
      try {
        await this.getMessageSettlementOutbox().repairTerminalMessageEffects(msg.messageId);
      } catch (error) {
        logger
          .withFields({
            sessionId: this.sessionId,
            messageId: msg.messageId,
            error: error instanceof Error ? error.message : String(error),
          })
          .warn(
            'Accepted message interruption effects incomplete; alarm repair will continue recovery'
          );
        await this.scheduleAlarmAtOrBefore(Date.now() + 1_000);
      }
    }

    const interrupt = await this.getAgentRuntime().interruptWrapper();
    if (acceptedMessages.length > 0 && state.wrapperConnectionId) {
      await clearWrapperRuntimeIdentity(
        this.ctx.storage,
        {
          wrapperGeneration: state.wrapperGeneration,
          wrapperConnectionId: state.wrapperConnectionId,
        },
        { incrementGeneration: true }
      );
      try {
        await this.stopCurrentWrapperProcess('user-interrupt');
      } catch (error) {
        logger
          .withFields({
            sessionId: this.sessionId,
            error: error instanceof Error ? error.message : String(error),
          })
          .warn('Failed to stop interrupted wrapper process after fencing');
      }
    }
    return {
      acceptedMessageCount: acceptedMessages.length,
      wrapperCommandSent: interrupt.commandSent,
    };
  }

  async interruptExecution(): Promise<{
    success: boolean;
    executionId?: ExecutionId;
    message?: string;
  }> {
    let acceptedMessageCount = 0;
    let wrapperCommandSent = false;
    const clearedMessages = await this.getSessionMessageQueue().interruptPendingQueuedMessages(
      async () => {
        const acceptedInterruption = await this.interruptAcceptedWrapperMessages();
        acceptedMessageCount = acceptedInterruption.acceptedMessageCount;
        wrapperCommandSent = acceptedInterruption.wrapperCommandSent;
      }
    );

    await this.finalizeIdleBatchCallbackIfReady({ allowWithoutObservedIdle: true });

    if (!wrapperCommandSent && clearedMessages.length === 0 && acceptedMessageCount === 0) {
      return { success: false, message: 'No accepted wrapper messages or pending queued messages' };
    }

    // Current interrupt success intentionally does not expose arbitrary legacy
    // execution rows as the identity of message-native work.
    return { success: true, executionId: undefined };
  }

  private async getTerminalClient(): Promise<OperationResult<{ client: TerminalWrapperClient }>> {
    const sessionId = await this.requireSessionId();
    const terminal = await resolveTerminalWrapperClient({
      env: this.env,
      metadata: await this.getMetadata(),
      sessionId,
    });

    if (!terminal.success || !terminal.data) {
      return { success: false, error: terminal.error };
    }

    return { success: true, data: { client: terminal.data.client } };
  }

  async createTerminal(input: TerminalCreateInput): Promise<OperationResult<{ pty: WrapperPty }>> {
    const terminal = await this.getTerminalClient();
    if (!terminal.success || !terminal.data) {
      return { success: false, error: terminal.error };
    }

    try {
      const pty = await terminal.data.client.createTerminal(
        input.cols !== undefined && input.rows !== undefined
          ? { cols: input.cols, rows: input.rows }
          : undefined
      );
      await this.updateLastActivity();
      return { success: true, data: { pty } };
    } catch (error) {
      logger
        .withFields({
          sessionId: this.sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
        .warn('Failed to create terminal');
      return { success: false, error: 'Terminal is unavailable' };
    }
  }

  async resizeTerminal(input: {
    ptyId: string;
    cols: number;
    rows: number;
  }): Promise<OperationResult<{ pty: WrapperPty }>> {
    const terminal = await this.getTerminalClient();
    if (!terminal.success || !terminal.data) {
      return { success: false, error: terminal.error };
    }

    try {
      const pty = await terminal.data.client.resizeTerminal(input.ptyId, {
        cols: input.cols,
        rows: input.rows,
      });
      await this.updateLastActivity();
      return { success: true, data: { pty } };
    } catch (error) {
      logger
        .withFields({
          sessionId: this.sessionId,
          ptyId: input.ptyId,
          error: error instanceof Error ? error.message : String(error),
        })
        .warn('Failed to resize terminal');
      return { success: false, error: 'Terminal is unavailable' };
    }
  }

  async closeTerminal(input: { ptyId: string }): Promise<OperationResult<{ success: boolean }>> {
    const terminal = await this.getTerminalClient();
    if (!terminal.success || !terminal.data) {
      return { success: false, error: terminal.error };
    }

    try {
      const result = await terminal.data.client.closeTerminal(input.ptyId);
      await this.updateLastActivity();
      return { success: true, data: result };
    } catch (error) {
      logger
        .withFields({
          sessionId: this.sessionId,
          ptyId: input.ptyId,
          error: error instanceof Error ? error.message : String(error),
        })
        .warn('Failed to close terminal');
      return { success: false, error: 'Terminal is unavailable' };
    }
  }

  /**
   * Delete session and all associated data.
   */
  async deleteSession(): Promise<void> {
    logger.info('Explicit DELETE requested for Durable Object');

    // Must delete alarm before deleteAll
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /**
   * Register full session metadata without setting preparedAt.
   * Workspace preparation happens lazily when the pending-message flusher
   * delivers the first message.
   */
  async registerSession(input: GroupedRegisterSessionInput): Promise<OperationResult> {
    await this.requireSessionId(input.identity.sessionId as SessionId);
    const existing = await this.ctx.storage.get('metadata');
    if (existing) {
      return { success: false, error: 'Session already registered' };
    }

    const now = Date.now();
    const repository: SessionMetadata['repository'] =
      input.repository?.type === 'github'
        ? {
            type: 'github',
            repo: input.repository.repo,
            upstreamBranch: input.repository.branch,
          }
        : input.repository?.type === 'gitlab'
          ? {
              type: 'gitlab',
              url: input.repository.url,
              platform: 'gitlab',
              upstreamBranch: input.repository.branch,
            }
          : input.repository?.type === 'git'
            ? {
                type: 'git',
                url: input.repository.url,
                token: input.repository.token,
                upstreamBranch: input.repository.branch,
              }
            : undefined;

    const metadata: SessionMetadata = {
      metadataSchemaVersion: 2,
      identity: input.identity,
      auth: input.auth,
      repository,
      initialMessage: {
        id: input.message.initialMessageId ?? input.message.turn.id ?? undefined,
        prompt:
          input.message.turn.type === 'prompt'
            ? input.message.turn.prompt
            : input.message.turn.arguments.length > 0
              ? `/${input.message.turn.command} ${input.message.turn.arguments}`
              : `/${input.message.turn.command}`,
        images: input.message.turn.type === 'prompt' ? input.message.turn.images : undefined,
        turn:
          input.message.turn.type === 'prompt'
            ? {
                type: 'prompt',
                prompt: input.message.turn.prompt,
                images: input.message.turn.images,
              }
            : {
                type: 'command',
                command: input.message.turn.command,
                arguments: input.message.turn.arguments,
              },
      },
      agent: {
        mode: input.agent.mode,
        model: input.agent.model,
        variant: input.agent.variant,
        appendSystemPrompt: input.agent.appendSystemPrompt,
      },
      finalization: input.finalization,
      profile: input.profile,
      callback: input.callback,
      workspace: input.workspace,
      lifecycle: {
        version: now,
        timestamp: now,
      },
    };

    let serialized: SessionMetadata;
    try {
      serialized = serializeSessionMetadata(metadata);
    } catch (error) {
      return {
        success: false,
        error: `Invalid metadata: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const modeError = validateModeAgainstRuntimeAgents(serialized);
    if (modeError) {
      return { success: false, error: modeError };
    }

    await this.ctx.storage.put('metadata', serialized);
    await this.updateLastActivity();
    await this.ensureAlarmScheduled();

    return { success: true };
  }

  /**
   * Register metadata and admit the initial accepted turn through one DO-owned
   * command. These storage steps are intentionally staged: if initial durable
   * admission is rejected after metadata is stored (for example if capacity is
   * exhausted), metadata remains registered and the caller receives a failure
   * so the Worker can attempt best-effort `onlyIfEmpty` deletion of its external
   * ownership-row prerequisite. Retrying this command with the same canonical
   * initial message ID and immutable intent resumes admission or replays its
   * existing acknowledgment. This method does not assert a cross-record storage
   * transaction.
   */
  async createSessionWithInitialAdmission(
    input: CreateSessionWithInitialAdmissionInput
  ): Promise<SessionMessageAdmissionResult> {
    const initialTurn = input.message.initialTurn;
    const admitInitialTurn = () =>
      this.getSessionMessageQueue().admitAcceptedMessage({
        userId: input.identity.userId as UserId,
        botId: input.identity.botId,
        turn: initialTurn,
        agent: input.agent,
        finalization: input.finalization,
      });
    const existingMetadata = await this.getMetadata();
    if (existingMetadata) {
      if (!isSameAcceptedInitialTurn(existingMetadata, initialTurn)) {
        return {
          success: false,
          code: 'BAD_REQUEST',
          error: 'Initial turn does not match registered session intent',
        };
      }
      if (!isSameInitialAdmissionConfiguration(existingMetadata, input)) {
        return {
          success: false,
          code: 'BAD_REQUEST',
          error: 'Initial admission configuration does not match registered session intent',
        };
      }
      return admitInitialTurn();
    }

    const registration = await this.registerSession({
      ...input,
      message: {
        initialMessageId: initialTurn.messageId,
        turn:
          initialTurn.type === 'prompt'
            ? {
                type: 'prompt',
                id: initialTurn.messageId,
                prompt: initialTurn.prompt,
                images: initialTurn.images,
              }
            : {
                type: 'command',
                id: initialTurn.messageId,
                command: initialTurn.command,
                arguments: initialTurn.arguments,
              },
      },
    });
    if (!registration.success) {
      return {
        success: false,
        code: 'INTERNAL',
        error: registration.error ?? 'Failed to register session',
      };
    }

    return admitInitialTurn();
  }

  async tryUpdate(updates: { callbackTarget?: CallbackTarget | null }): Promise<OperationResult> {
    const metadata = await this.getMetadata();

    if (!metadata) {
      return { success: false, error: 'Session metadata is not available' };
    }

    const allKeys = Object.keys(updates).filter(
      k => updates[k as keyof typeof updates] !== undefined
    );
    if (allKeys.some(key => key !== 'callbackTarget')) {
      return { success: false, error: 'Only callbackTarget can be updated' };
    }

    const updated: SessionMetadata = { ...metadata };
    if (updates.callbackTarget === null) {
      delete updated.callback;
    } else if (updates.callbackTarget !== undefined) {
      updated.callback = { target: updates.callbackTarget };
    }
    const now = Date.now();
    updated.lifecycle = {
      ...updated.lifecycle,
      version: now,
      timestamp: now,
    };

    let serialized: SessionMetadata;
    try {
      serialized = serializeSessionMetadata(updated);
    } catch (error) {
      return {
        success: false,
        error: `Invalid metadata after update: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const modeError = validateModeAgainstRuntimeAgents(serialized);
    if (modeError) {
      return { success: false, error: modeError };
    }

    await this.ctx.storage.put('metadata', serialized);

    // Track activity for session TTL
    await this.updateLastActivity();

    return { success: true };
  }

  async recordSessionReady(input: {
    workspacePath: string;
    sandboxId: string;
    sessionHome: string;
    branchName: string;
    kiloSessionId: string;
    githubInstallationId?: string;
    githubAppType?: 'standard' | 'lite';
    gitToken?: string;
    gitlabTokenManaged?: boolean;
    devcontainer?: SessionMetadata['devcontainer'];
  }): Promise<OperationResult<SessionMetadata>> {
    const metadata = await this.getMetadata();

    if (!metadata) {
      return { success: false, error: 'Session metadata is not available' };
    }

    const now = Date.now();
    const repository: SessionMetadata['repository'] =
      metadata.repository?.type === 'github'
        ? {
            ...metadata.repository,
            githubInstallationId:
              input.githubInstallationId ?? metadata.repository.githubInstallationId,
            githubAppType: input.githubAppType ?? metadata.repository.githubAppType,
          }
        : metadata.repository?.type === 'gitlab'
          ? {
              ...metadata.repository,
              gitlabTokenManaged:
                input.gitlabTokenManaged ?? metadata.repository.gitlabTokenManaged,
            }
          : metadata.repository;

    const updated: SessionMetadata = {
      ...metadata,
      auth: {
        ...metadata.auth,
        kiloSessionId: input.kiloSessionId,
      },
      repository,
      workspace: {
        ...metadata.workspace,
        workspacePath: input.workspacePath,
        sandboxId: input.sandboxId as SandboxId,
        sessionHome: input.sessionHome,
        branchName: input.branchName,
      },
      ...((input.devcontainer ?? metadata.devcontainer)
        ? { devcontainer: input.devcontainer ?? metadata.devcontainer }
        : {}),
      lifecycle: {
        ...metadata.lifecycle,
        preparedAt: metadata.lifecycle.preparedAt ?? now,
        version: now,
        timestamp: now,
      },
    };

    let serialized: SessionMetadata;
    try {
      serialized = serializeSessionMetadata(updated);
    } catch (error) {
      return {
        success: false,
        error: `Invalid metadata after readiness update: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    await this.ctx.storage.put('metadata', serialized);
    await this.updateLastActivity();

    return { success: true, data: serialized };
  }

  private async recordSessionInitiatedIfNeeded(initiatedAt: number): Promise<void> {
    const metadata = await this.getMetadata();
    if (!metadata || metadata.lifecycle.initiatedAt) return;

    const updated: SessionMetadata = {
      ...metadata,
      lifecycle: {
        ...metadata.lifecycle,
        initiatedAt,
        version: initiatedAt,
        timestamp: initiatedAt,
      },
    };
    let serialized: SessionMetadata;
    try {
      serialized = serializeSessionMetadata(updated);
    } catch (error) {
      throw new Error(
        `Invalid metadata after initiation update: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    await this.ctx.storage.put('metadata', serialized);
    await this.updateLastActivity();
  }

  // ---------------------------------------------------------------------------
  // Alarm Reaper
  // ---------------------------------------------------------------------------

  /**
   * Alarm handler for periodic cleanup tasks.
   * Runs periodic retention/TTL cleanup and schedules nearer deadlines for
   * pending message flushes, disconnect grace, wrapper liveness, and max runtime.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    const alarmAtStart = await this.ctx.storage.getAlarm();

    let pendingFlushRetryAt: number | undefined;
    let remainingPendingCount: number | undefined;
    let alarmWorkFailed = false;

    try {
      // Check if session should be deleted due to inactivity (90 days)
      const lastActivity = await this.ctx.storage.get<number>(LAST_ACTIVITY_KEY);
      if (lastActivity && now - lastActivity > Limits.SESSION_TTL_MS) {
        logger
          .withFields({ sessionId: this.sessionId, lastActivity })
          .info('Deleting session due to inactivity');

        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        return;
      }

      await this.getWrapperSupervisor().runMaintenance(now);

      try {
        await this.getMessageSettlementOutbox().repairTerminalEffects();
      } catch (error) {
        logger
          .withFields({
            sessionId: this.sessionId,
            error: error instanceof Error ? error.message : String(error),
          })
          .warn('Terminal effect repair failed; scheduled retry will continue recovery');
      }
      await this.retryPendingCallbacks(now);
      await this.getSessionMessageQueue().recoverPendingInterruption(async () => {
        await this.interruptAcceptedWrapperMessages();
      });

      // Run cleanup tasks
      this.cleanupOldEvents(now);
      this.cleanupExpiredLeases(now);
      await this.cleanupIdleKiloServer(now);

      const flushOneResult = await this.flushOnePendingSessionMessage();
      pendingFlushRetryAt = flushOneResult.retryAt;
      remainingPendingCount = flushOneResult.remainingPendingCount;
    } catch (error) {
      alarmWorkFailed = true;
      logger
        .withFields({
          doId: this.ctx.id.toString(),
          sessionId: this.sessionId,
          elapsedMs: Date.now() - now,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        })
        .error('Error during alarm reaper');
    }

    // Schedule next alarm run from the nearest pending deadline, retry pending
    // work promptly when idle, and otherwise use the long idle cadence.
    // Wrapped in try/catch so a failure here never prevents rescheduling the alarm.
    let nextAlarmAt = Date.now() + REAPER_IDLE_INTERVAL_MS;
    try {
      const pendingCount = remainingPendingCount ?? 0;
      const currentTime = Date.now();
      const deadlines = await this.getNextAlarmDeadlines();
      if (alarmWorkFailed) {
        deadlines.push(currentTime + PENDING_FLUSH_DEBOUNCE_MS);
      }
      if (pendingFlushRetryAt !== undefined) {
        deadlines.push(pendingFlushRetryAt);
      }

      for (const deadline of deadlines) {
        const clampedDeadline = deadline <= currentTime ? currentTime + 1_000 : deadline;
        if (clampedDeadline < nextAlarmAt) {
          nextAlarmAt = clampedDeadline;
        }
      }

      const existingAlarm = await this.ctx.storage.getAlarm();
      if (
        existingAlarm !== null &&
        existingAlarm !== alarmAtStart &&
        existingAlarm > currentTime &&
        existingAlarm < nextAlarmAt
      ) {
        nextAlarmAt = existingAlarm;
      }

      if (
        pendingFlushRetryAt === undefined &&
        pendingCount > 0 &&
        currentTime + PENDING_FLUSH_DEBOUNCE_MS < nextAlarmAt
      ) {
        nextAlarmAt = currentTime + PENDING_FLUSH_DEBOUNCE_MS;
      }
    } catch {
      // Can't determine state — use a conservative short interval so the
      // reaper retries soon rather than sleeping for an hour.
      nextAlarmAt = Date.now() + REAPER_INTERVAL_MS_DEFAULT;
    }
    await this.ctx.storage.setAlarm(nextAlarmAt);
  }

  /**
   * Ensure the reaper alarm is scheduled.
   * Called during initialization and when session is first created.
   */
  private async ensureAlarmScheduled(): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null) {
      await this.ctx.storage.setAlarm(Date.now() + this.getReaperIntervalMs());
      return;
    }
  }

  private async scheduleAlarmAtOrBefore(deadline: number): Promise<void> {
    const now = Date.now();
    const clampedDeadline = deadline <= now ? now + 1_000 : deadline;
    const existingAlarm = await this.ctx.storage.getAlarm();
    if (existingAlarm === null || existingAlarm <= now || clampedDeadline < existingAlarm) {
      await this.ctx.storage.setAlarm(clampedDeadline);
    }
  }

  private redactCallbackTargetUrl(callbackUrl: string): string {
    try {
      const url = new URL(callbackUrl);
      return `${url.origin}${url.pathname}`;
    } catch {
      return 'invalid-url';
    }
  }

  /**
   * Update the last activity timestamp.
   * Called when metadata is modified to track session activity.
   */
  private async updateLastActivity(): Promise<void> {
    await this.ctx.storage.put(LAST_ACTIVITY_KEY, Date.now());
  }

  /**
   * Clean up events older than the retention period.
   */
  private cleanupOldEvents(now: number): void {
    const retentionCutoff = now - EVENT_RETENTION_MS;
    const deletedCount = this.eventQueries.deleteOlderThan(retentionCutoff);

    if (deletedCount > 0) {
      logger.withFields({ sessionId: this.sessionId, deletedCount }).info('Cleaned up old events');
    }
  }

  /**
   * Clean up expired leases.
   */
  private cleanupExpiredLeases(now: number): void {
    const deletedCount = this.leaseQueries.deleteExpired(now);

    if (deletedCount > 0) {
      logger
        .withFields({ sessionId: this.sessionId, deletedCount })
        .info('Cleaned up expired leases');
    }
  }

  private getReaperIntervalMs(): number {
    const value = Number(this.env.REAPER_INTERVAL_MS);
    return Number.isFinite(value) && value > 0 ? value : REAPER_INTERVAL_MS_DEFAULT;
  }

  private getKiloServerIdleTimeoutMs(): number {
    const value = Number(this.env.KILO_SERVER_IDLE_TIMEOUT_MS);
    return Number.isFinite(value) && value > 0 ? value : KILO_SERVER_IDLE_TIMEOUT_MS_DEFAULT;
  }

  /**
   * Stop kilo server if it has been idle for too long.
   * Called by the alarm handler to free up sandbox resources.
   */
  private async cleanupIdleKiloServer(now: number): Promise<void> {
    const metadata = await this.getMetadata();
    if (!metadata) {
      return;
    }

    const lastActivity = metadata.lifecycle.kiloServerLastActivity;
    if (!lastActivity) {
      // No kilo server activity recorded, nothing to clean up
      return;
    }

    const idleMs = now - lastActivity;
    const idleTimeoutMs = this.getKiloServerIdleTimeoutMs();

    if (idleMs < idleTimeoutMs) {
      // Server is still within idle threshold
      return;
    }

    const hasRuntimeWork = await this.hasWrapperRuntimeOrPendingWork();
    if (hasRuntimeWork) {
      logger
        .withFields({
          sessionId: this.sessionId,
          idleMs,
        })
        .debug('Skipping idle kilo server cleanup - wrapper or pending work is active');
      return;
    }

    // Server has been idle too long and no wrapper/pending work remains, stop it
    logger
      .withFields({
        sessionId: this.sessionId,
        idleMs,
        idleTimeoutMs,
      })
      .info('Stopping idle kilo server');

    const stopped = await this.getAgentRuntime().stopWrapperProcess('idle-timeout');
    const updated = {
      ...metadata,
      lifecycle: {
        ...metadata.lifecycle,
        ...(stopped ? { kiloServerLastActivity: undefined } : {}),
        version: Date.now(),
      },
    };
    await this.updateMetadata(updated);

    if (stopped) {
      await this.getMessageSettlementOutbox().releaseWrapperTerminalWaitForIdleBatch();
      await this.finalizeIdleBatchCallbackIfReady({ allowWithoutObservedIdle: true });
      logger
        .withFields({ sessionId: this.sessionId })
        .info('Idle kilo server stopped successfully');
      return;
    }

    logger.withFields({ sessionId: this.sessionId }).warn('Failed to stop idle kilo server');
  }

  /**
   * Keep the sandbox active while wrapper heartbeat traffic bypasses container fetches.
   * Called from the ingest heartbeat adapter; AgentRuntime owns the renewal transport.
   */
  private async keepContainerAlive(): Promise<void> {
    await this.getAgentRuntime().keepSandboxAlive();
  }

  // ---------------------------------------------------------------------------
  // Execution Management RPC Methods
  // ---------------------------------------------------------------------------

  /**
   * Add a new execution with initial 'pending' status.
   */
  async addExecution(
    params: AddExecutionParams
  ): Promise<Result<ExecutionMetadata, AddExecutionError>> {
    return this.executionQueries.add(params);
  }

  /**
   * Update execution status with state machine validation.
   *
   * When `suppressCallback` is true the status is persisted but no callback
   * notification is enqueued.  Used on the followup path where the caller
   * (orchestrator) handles the error synchronously and enqueuing a callback
   * would race with a fallback session's callbacks.
   */
  private async emitAcceptedMessageTerminalEvent(
    execution: ExecutionMetadata,
    params: UpdateExecutionStatusParams,
    status: 'completed' | 'failed' | 'interrupted'
  ): Promise<void> {
    if (!execution.messageId) {
      return;
    }

    const payload: Record<string, unknown> = {
      messageId: execution.messageId,
      executionId: execution.executionId,
      status,
      delivery: 'sent',
      accepted: true,
    };

    if (status === 'interrupted') {
      payload.reason = 'interrupted';
      payload.error = params.error ?? 'Execution was interrupted';
    } else if (status === 'failed') {
      payload.reason = 'execution';
      if (params.error !== undefined) payload.error = params.error;
    } else if (params.error !== undefined) {
      payload.error = params.error;
    }
    if (params.gateResult !== undefined) {
      payload.gateResult = params.gateResult;
    }

    const sessionId = await this.requireSessionId();
    this.insertAndBroadcastEvent({
      executionId: execution.executionId,
      sessionId,
      streamEventType: status === 'completed' ? 'cloud.message.completed' : 'cloud.message.failed',
      payload: JSON.stringify(payload),
      timestamp: Date.now(),
    });
  }

  private async ensureAcceptedMessageEffects(
    messageId: string,
    acceptedAt = Date.now()
  ): Promise<void> {
    const sessionId = await this.requireSessionId();
    const eventId = this.eventQueries.insertUnique({
      executionId: '' as EventSourceId,
      entityId: `sent-message/${messageId}`,
      sessionId,
      streamEventType: 'cloud.message.sent',
      payload: JSON.stringify({ messageId, delivery: 'sent' }),
      timestamp: Date.now(),
    });
    if (eventId !== null) {
      this.broadcastEvent({
        id: eventId,
        execution_id: '' as EventSourceId,
        session_id: sessionId,
        stream_event_type: 'cloud.message.sent',
        payload: JSON.stringify({ messageId, delivery: 'sent' }),
        timestamp: Date.now(),
      });
    }
    await this.recordSessionInitiatedIfNeeded(acceptedAt);
  }

  private async finalizeIdleBatchCallbackIfReady(options?: {
    allowWithoutObservedIdle?: boolean;
  }): Promise<void> {
    await this.getMessageSettlementOutbox().finalizeIdleBatchCallbackIfReady(options);
  }

  private async terminalizeSessionMessageOnce(
    messageId: string,
    params: TerminalizeParams,
    opts?: {
      gateResult?: 'pass' | 'fail';
      suppressCallback?: boolean;
      allowIdleBatchWithoutObservedIdle?: boolean;
    }
  ) {
    return this.getMessageSettlementOutbox().terminalizeSessionMessageOnce(messageId, params, opts);
  }

  private async ensureAcceptedMessageBeforeTerminal(
    messageId: string,
    wrapperRunId: string
  ): Promise<void> {
    const runtimeState = await getWrapperRuntimeState(this.ctx.storage);
    if (runtimeState.wrapperRunId !== wrapperRunId) return;

    const state = await getSessionMessageState(this.ctx.storage, messageId);
    if (
      state?.status === 'completed' ||
      state?.status === 'failed' ||
      state?.status === 'interrupted'
    ) {
      return;
    }
    if (state?.status === 'accepted') {
      if (state.wrapperRunId !== wrapperRunId) return;
      await this.ensureAcceptedMessageEffects(messageId, state.acceptedAt ?? Date.now());
      return;
    }

    const pending = await findPendingSessionMessageByMessageId(this.ctx.storage, messageId);
    if (!state && !pending) return;

    const acceptedAt = Date.now();
    if (state?.status === 'queued') {
      await markMessageAccepted(this.ctx.storage, messageId, wrapperRunId, acceptedAt);
    } else if (pending) {
      const context = await this.getPendingMessageDeliveryContext();
      const intent = resolvePendingSessionMessageIntent(pending, {
        mode: context?.metadata.agent?.mode,
        model: context?.metadata.agent?.model,
        variant: context?.metadata.agent?.variant,
        autoCommit: context?.metadata.finalization?.autoCommit,
        condenseOnComplete: context?.metadata.finalization?.condenseOnComplete,
      });
      await putSessionMessageState(this.ctx.storage, {
        messageId,
        status: 'accepted',
        prompt: pending.content,
        createdAt: pending.createdAt,
        queuedAt: pending.createdAt,
        acceptedAt,
        wrapperRunId,
        callbackRequired: pending.callbackSnapshot?.required,
        callbackTarget: pending.callbackSnapshot?.target,
        admissionSnapshot: intent,
      });
    }
    try {
      await this.ensureAcceptedMessageEffects(messageId, acceptedAt);
    } catch (error) {
      logger
        .withFields({
          sessionId: this.sessionId,
          messageId,
          error: error instanceof Error ? error.message : String(error),
        })
        .warn('Accepted terminal message effects incomplete; alarm repair will continue recovery');
      await this.scheduleAlarmAtOrBefore(Date.now() + 1_000);
    }
  }

  async updateExecutionStatus(
    params: UpdateExecutionStatusParams,
    opts?: { suppressCallback?: boolean }
  ): Promise<Result<ExecutionMetadata, UpdateStatusError>> {
    const existing = await this.executionQueries.get(params.executionId);
    if (existing?.status === params.status && this.isTerminalStatus(params.status)) {
      return { ok: true, value: existing };
    }

    const result = await this.executionQueries.updateStatus(params);

    if (result.ok && this.isTerminalStatus(params.status)) {
      if (!opts?.suppressCallback) {
        await this.emitAcceptedMessageTerminalEvent(result.value, params, params.status);
        await this.enqueueCallbackNotification(
          result.value,
          params.status,
          params.error,
          params.gateResult
        );
      }
    }

    return result;
  }

  /**
   * Fail an execution with full cleanup.
   * Idempotent — safe to call if execution is already terminal.
   *
   * Performs:
   * 1. Update execution status to terminal (enqueues callback)
   * 2. Clear current wrapper runtime liveness state when applicable
   * 3. Clear interrupt flag
   * 4. Broadcast event to /stream clients
   *
   * Returns false if the execution was already terminal (no-op).
   */
  private async failExecution(params: {
    executionId: ExecutionId;
    status: 'failed' | 'interrupted';
    error: string;
    streamEventType: string;
    streamPayload?: Record<string, unknown>;
    /** When true, skip enqueuing the callback notification. */
    suppressCallback?: boolean;
  }): Promise<boolean> {
    const { executionId, status, error, streamEventType, streamPayload } = params;

    // The RPC remains for public execution compatibility; current wrapper-run
    // cleanup is owned by message supervision rather than legacy execution IDs.

    // 1. Update status (enqueues callback notification on terminal unless suppressed)
    const statusResult = await this.updateExecutionStatus(
      {
        executionId,
        status,
        error,
        completedAt: Date.now(),
      },
      { suppressCallback: params.suppressCallback }
    );

    if (!statusResult.ok) {
      logger
        .withFields({ executionId, error: statusResult.error })
        .info('failExecution: status transition rejected (already terminal?)');
      return false;
    }

    // 2. Broadcast to /stream clients
    const sessionId = await this.requireSessionId();
    this.insertAndBroadcastEvent({
      executionId,
      sessionId,
      streamEventType,
      payload: JSON.stringify({
        error,
        fatal: true,
        ...streamPayload,
      }),
      timestamp: Date.now(),
    });

    return true;
  }

  private async hasWrapperRuntimeOrPendingWork(): Promise<boolean> {
    const pendingCount = await countPendingSessionMessages(this.ctx.storage);
    if (pendingCount > 0) return true;

    const state = await getWrapperRuntimeState(this.ctx.storage);
    if (!state.wrapperConnectionId) return false;

    const acceptedMessages = await listNonTerminalAcceptedMessages(
      this.ctx.storage,
      state.wrapperRunId
    );
    if (acceptedMessages.length > 0) return true;

    return false;
  }

  private async getNextAlarmDeadlines(): Promise<number[]> {
    const deadlines = await this.getWrapperSupervisor().nextMaintenanceDeadlines();

    const nextCallbackDeadline = await this.getMessageSettlementOutbox().nextCallbackDeadline();
    if (nextCallbackDeadline !== undefined) {
      deadlines.push(nextCallbackDeadline);
    }

    return deadlines;
  }

  private async retryPendingCallbacks(now: number): Promise<void> {
    await this.getMessageSettlementOutbox().retryPendingCallbacks(now);
  }

  private async stopCurrentWrapperProcess(reason: AgentRuntimeStopReason): Promise<boolean> {
    return this.getAgentRuntime().stopWrapperProcess(reason);
  }

  /**
   * Update execution heartbeat timestamp.
   */
  async updateExecutionHeartbeat(executionId: ExecutionId, timestamp: number): Promise<boolean> {
    return this.executionQueries.updateHeartbeat(executionId, timestamp);
  }

  /**
   * Set the process ID for a long-running execution.
   * Used for resume support in the queue consumer.
   */
  async setProcessId(executionId: ExecutionId, processId: string): Promise<boolean> {
    return this.executionQueries.setProcessId(executionId, processId);
  }

  /**
   * Insert and broadcast an error event for an execution.
   * Used by external callers (e.g. interrupt handler) to notify /stream clients.
   */
  async emitExecutionError(executionId: ExecutionId, errorMessage: string): Promise<void> {
    const sessionId = await this.requireSessionId();
    const payload = JSON.stringify({
      error: errorMessage,
      fatal: true,
    });
    this.insertAndBroadcastEvent({
      executionId,
      sessionId,
      streamEventType: 'error',
      payload,
      timestamp: Date.now(),
    });
  }

  /**
   * RPC wrapper for failExecution — allows external callers (e.g. interrupt
   * handler) to perform a full execution failure with cleanup.
   */
  async failExecutionRpc(params: {
    executionId: string;
    error: string;
    streamEventType?: string;
  }): Promise<boolean> {
    const execution = await this.executionQueries.get(params.executionId as ExecutionId);
    if (!execution || this.isTerminalStatus(execution.status)) {
      return false;
    }

    return this.failExecution({
      executionId: params.executionId as ExecutionId,
      status: 'failed',
      error: params.error,
      streamEventType: params.streamEventType ?? 'error',
    });
  }

  /**
   * Get a specific execution by ID.
   */
  async getExecution(executionId: ExecutionId): Promise<ExecutionMetadata | null> {
    return this.executionQueries.get(executionId);
  }

  /**
   * Get all executions for this session.
   */
  async getExecutions(): Promise<ExecutionMetadata[]> {
    return this.executionQueries.getAll();
  }

  /**
   * Retained response-shape compatibility surface for status, health, and
   * interrupt callers. This reads active legacy execution records only; it is
   * intentionally not used by current message drain, fencing, or supervision.
   */
  async getCurrentRuntimeExecution(): Promise<ExecutionMetadata | null> {
    const executions = await this.executionQueries.getAll();
    return (
      executions.find(
        execution => execution.status === 'pending' || execution.status === 'running'
      ) ?? null
    );
  }

  /**
   * Represent message-native queued/accepted work through existing health
   * response fields without recreating an execution-backed runtime identity.
   */
  async getCurrentMessageWork(): Promise<{
    messageId: string;
    status: 'pending' | 'running';
    health: 'healthy' | 'stale';
  } | null> {
    const accepted = await listNonTerminalAcceptedMessages(this.ctx.storage);
    const [firstAccepted] = accepted;
    if (!firstAccepted) {
      const pending = await countPendingSessionMessages(this.ctx.storage);
      if (pending === 0) return null;
      const queued = await this.getSessionMessageQueue().snapshotForStreamConnect();
      const first = queued.find(message => !message.terminalFailure);
      return first ? { messageId: first.messageId, status: 'pending', health: 'healthy' } : null;
    }
    const runtime = await getWrapperRuntimeState(this.ctx.storage);
    const now = Date.now();
    const currentFenceMatches =
      runtime.wrapperRunId === firstAccepted.wrapperRunId && Boolean(runtime.wrapperConnectionId);
    const expired =
      (runtime.noOutputDeadlineAt !== undefined && now >= runtime.noOutputDeadlineAt) ||
      (runtime.pingDeadlineAt !== undefined && now >= runtime.pingDeadlineAt);
    return {
      messageId: firstAccepted.messageId,
      status: 'running',
      health: currentFenceMatches && !expired ? 'healthy' : 'stale',
    };
  }

  /**
   * Check if interrupt was requested for the current execution.
   * Note: This is different from the legacy isInterrupted() method which uses 'interrupted' key.
   */
  async isInterruptRequested(): Promise<boolean> {
    return this.executionQueries.isInterruptRequested();
  }

  /**
   * Request interrupt for the current execution.
   */
  async requestInterrupt(): Promise<void> {
    return this.executionQueries.requestInterrupt();
  }

  /**
   * Clear the interrupt flag.
   * Note: This is different from the legacy clearInterrupted() method.
   */
  async clearInterruptRequest(): Promise<void> {
    return this.executionQueries.clearInterrupt();
  }

  // ---------------------------------------------------------------------------
  // Lease Management RPC Methods
  // ---------------------------------------------------------------------------

  /**
   * Try to acquire a lease for an execution.
   * Used by queue consumers for idempotent processing.
   *
   * @param executionId - ID of the execution to acquire lease for
   * @param messageId - Queue message ID for tracking
   * @param leaseId - Unique ID for this lease attempt
   * @returns Result with expiry time on success, or error if lease is held
   */
  acquireLease(
    executionId: ExecutionId,
    messageId: string,
    leaseId: string
  ): Result<{ acquired: true; expiresAt: number }, LeaseAcquireError> {
    return this.leaseQueries.tryAcquire(executionId, leaseId, messageId);
  }

  /**
   * Extend an existing lease (heartbeat).
   * Returns true if the lease was extended, false if the lease is not held.
   *
   * @param executionId - ID of the execution
   * @param leaseId - Lease ID that must match the current holder
   * @returns true if lease was extended
   */
  extendLease(executionId: ExecutionId, leaseId: string): boolean {
    const result = this.leaseQueries.extend(executionId, leaseId);
    return result.ok;
  }

  /**
   * Release a lease on completion.
   *
   * @param executionId - ID of the execution
   * @param leaseId - Lease ID that must match the current holder
   * @returns true if lease was released
   */
  releaseLease(executionId: ExecutionId, leaseId: string): boolean {
    return this.leaseQueries.release(executionId, leaseId);
  }

  // ---------------------------------------------------------------------------
  // Direct Execution Methods
  // ---------------------------------------------------------------------------

  async admitSubmittedMessage(
    request: SubmittedSessionMessageRequest
  ): Promise<SessionMessageAdmissionResult> {
    return this.getSessionMessageQueue().admitSubmittedMessage(request);
  }

  async admitPreparedInitialMessage(
    request: LegacyRegisteredInitialAdmissionRequest
  ): Promise<SessionMessageAdmissionResult> {
    const metadata = await this.getMetadata();
    if (!metadata) return { success: false, code: 'NOT_FOUND', error: 'Session not found' };
    const initialMessage = metadata.initialMessage;
    if (!initialMessage?.id) {
      return { success: false, code: 'BAD_REQUEST', error: 'No prompt provided' };
    }
    const turn: AdmitAcceptedSessionMessageRequest['turn'] | undefined =
      initialMessage.turn?.type === 'command'
        ? {
            type: 'command',
            messageId: initialMessage.id,
            command: initialMessage.turn.command,
            arguments: initialMessage.turn.arguments,
          }
        : initialMessage.turn?.type === 'prompt'
          ? {
              type: 'prompt',
              messageId: initialMessage.id,
              prompt: initialMessage.turn.prompt,
              images: initialMessage.turn.images,
            }
          : initialMessage.prompt
            ? {
                type: 'prompt',
                messageId: initialMessage.id,
                prompt: initialMessage.prompt,
                images: initialMessage.images,
              }
            : undefined;
    if (!turn) return { success: false, code: 'BAD_REQUEST', error: 'No prompt provided' };
    if (!metadata.agent?.mode || !metadata.agent.model) {
      return {
        success: false,
        code: 'BAD_REQUEST',
        error: 'No model specified and session has no default model',
      };
    }
    return this.getSessionMessageQueue().admitAcceptedMessage({
      userId: request.userId,
      botId: request.botId,
      turn,
      agent: {
        mode: metadata.agent.mode,
        model: metadata.agent.model,
        variant: metadata.agent.variant,
      },
      finalization: {
        autoCommit: metadata.finalization?.autoCommit,
        condenseOnComplete: metadata.finalization?.condenseOnComplete,
      },
    });
  }

  private async flushOnePendingSessionMessage(): Promise<{
    retryAt?: number;
    remainingPendingCount: number;
  }> {
    return this.getSessionMessageQueue().drainNextPendingMessage();
  }

  private async recordRuntimeAcceptedMessage(
    plan: MessageDeliveryRequest,
    delivery: AgentRuntimeAcceptedDelivery
  ): Promise<void> {
    const { turn } = plan;
    const sessionId = plan.scope.sessionId;
    const { acceptedAt, wrapperRunId } = delivery;

    const existingState = await getSessionMessageState(this.ctx.storage, turn.messageId);
    if (existingState && existingState.status === 'queued') {
      await markMessageAccepted(this.ctx.storage, turn.messageId, wrapperRunId, acceptedAt);
      logger
        .withFields({ sessionId, messageId: turn.messageId, wrapperRunId })
        .info('Session message transitioned from queued to accepted');
    } else if (!existingState) {
      const pending = await findPendingSessionMessageByMessageId(this.ctx.storage, turn.messageId);
      const intent = pending
        ? resolvePendingSessionMessageIntent(pending, {
            mode: plan.agent.mode,
            model: plan.agent.model,
            variant: plan.agent.variant,
            autoCommit: plan.finalization?.autoCommit,
            condenseOnComplete: plan.finalization?.condenseOnComplete,
          })
        : undefined;
      await putSessionMessageState(this.ctx.storage, {
        messageId: turn.messageId,
        status: 'accepted',
        prompt: pending?.content ?? renderExecutionTurnContent(turn),
        createdAt: pending?.createdAt ?? acceptedAt,
        queuedAt: pending?.createdAt ?? acceptedAt,
        acceptedAt,
        wrapperRunId,
        callbackRequired: pending?.callbackSnapshot?.required,
        callbackTarget: pending?.callbackSnapshot?.target,
        admissionSnapshot: intent,
      });
      logger
        .withFields({ sessionId, messageId: turn.messageId, wrapperRunId })
        .warn('Accepted session message state was missing and has been reconstructed');
    }

    await this.ensureAcceptedMessageEffects(turn.messageId, acceptedAt);
  }

  /**
   * Deliver one pending message through the shared wrapper delivery path.
   */
  private async executeDirectly(plan: MessageDeliveryRequest): Promise<MessageDeliveryResult> {
    const sessionId = plan.scope.sessionId;
    const eventSourceId = '' as EventSourceId;

    await this.scheduleAlarmAtOrBefore(Date.now() + PENDING_FLUSH_DEBOUNCE_MS);

    const result = await this.getAgentRuntime().send(plan, {
      onProgress: (step, message) => {
        const now = Date.now();
        this.broadcastVolatileEvent({
          executionId: eventSourceId,
          sessionId,
          streamEventType: 'preparing',
          payload: JSON.stringify({ step, message }),
          timestamp: now,
        });
        this.broadcastVolatileEvent({
          executionId: eventSourceId,
          sessionId,
          streamEventType: 'cloud.status',
          payload: JSON.stringify({
            cloudStatus: { type: 'preparing' as const, step, message },
          }),
          timestamp: now,
        });
      },
      onWorkspaceReady: async ready => {
        const readyResult = await this.recordSessionReady(ready);
        if (!readyResult.success) {
          throw new Error(readyResult.error ?? 'Failed to record session readiness');
        }
      },
      onAccepted: delivery => this.recordRuntimeAcceptedMessage(plan, delivery),
    });

    this.broadcastVolatileEvent({
      executionId: eventSourceId,
      sessionId,
      streamEventType: 'cloud.status',
      payload: JSON.stringify({ cloudStatus: { type: 'ready' } }),
      timestamp: Date.now(),
    });

    logger
      .withFields({
        sessionId,
        messageId: plan.turn.messageId,
        wrapperRunId: result.success ? result.wrapperRunId : undefined,
      })
      .info('Wrapper accepted delivered session message');

    return result;
  }

  /**
   * Called when an execution completes (successfully, failed, or interrupted).
   *
   * Updates retained legacy execution status and schedules a pending-message
   * flush if more work is waiting. Current wrapper-run supervision is separate.
   *
   * @param executionId - ID of the completed execution
   * @param status - Final status of the execution
   * @param error - Optional error message for failed executions
   */
  async onExecutionComplete(
    executionId: ExecutionId,
    status: 'completed' | 'failed' | 'interrupted',
    error?: string,
    gateResult?: 'pass' | 'fail'
  ): Promise<void> {
    const sessionId = await this.resolveSessionId();
    logger
      .withFields({
        sessionId,
        executionId,
        status,
        error,
      })
      .info('onExecutionComplete called');

    // Update retained legacy execution status without affecting current wrapper-run identity.
    const updateResult = await this.updateExecutionStatus({
      executionId,
      status,
      error,
      gateResult,
      completedAt: Date.now(),
    });

    if (!updateResult.ok) {
      logger
        .withFields({ sessionId, executionId, error: updateResult.error })
        .warn('Failed to update execution status');
    }

    await this.getSessionMessageQueue().requestPendingDrainIfNeeded();

    logger.withFields({ sessionId, executionId }).info('Execution complete - session is idle');
  }

  async handleWrapperTerminalEvent(params: {
    wrapperRunId: string;
    status: 'completed' | 'failed' | 'interrupted';
    error?: string;
    gateResult?: 'pass' | 'fail';
  }): Promise<void> {
    await this.resolveSessionId();
    await this.getWrapperSupervisor().onTerminalEvent(params);
  }
}
