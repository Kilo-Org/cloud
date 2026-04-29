/**
 * SQLite-backed Durable Object for cloud agent session metadata.
 * Automatically cleans up after 90 days of inactivity.
 * Uses RPC methods for type-safe communication.
 */

import { DurableObject } from 'cloudflare:workers';
import { TRPCError } from '@trpc/server';
import type { CloudAgentSessionState, OperationResult, MCPServerConfig } from './types.js';
import {
  MetadataSchema,
  PreparationInputSchema,
  type Images,
  type PreparationInput,
} from './schemas.js';
import type { EncryptedSecrets } from '../router/schemas.js';
import type { CallbackJob, CallbackTarget } from '../callbacks/index.js';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { logger } from '../logger.js';
import { Limits } from '../schema.js';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import migrations from '../../drizzle/migrations';
import { normalizeKilocodeModel } from './model-utils.js';
import {
  createExecutionQueries,
  createEventQueries,
  createLeaseQueries,
  type ExecutionQueries,
  type EventQueries,
  type LeaseQueries,
  type LeaseAcquireError,
} from '../session/queries/index.js';
import { createExecutionId } from '../types/ids.js';
import type { ExecutionId, EventSourceId, EventId, SessionId, UserId } from '../types/ids.js';
import type {
  ExecutionMetadata,
  AddExecutionParams,
  UpdateExecutionStatusParams,
  LatestAssistantMessage,
  AssistantMessagePart,
} from '../session/types.js';
import type { ExecutionStatus } from '../core/execution.js';
import type { Result } from '../lib/result.js';
import type {
  AddExecutionError,
  UpdateStatusError,
  SetActiveError,
} from '../session/queries/executions.js';
import { createStreamHandler, type StreamHandler } from '../websocket/stream.js';
import {
  createIngestHandler,
  type IngestHandler,
  type IngestDOContext,
} from '../websocket/ingest.js';
import type { StoredEvent } from '../websocket/types.js';
import type {
  WrapperCommand,
  PreparingStep,
  PreparingEventData,
  CloudStatusData,
} from '../shared/protocol.js';
import { STALE_THRESHOLD_MS, SANDBOX_SLEEP_AFTER_SECONDS } from '../core/lease.js';
import { ExecutionOrchestrator, type OrchestratorDeps } from '../execution/orchestrator.js';
import type {
  ExecutionMode,
  ExecutionPlan,
  StartExecutionV2Request,
  StartExecutionV2Result,
  InitializeContext,
  TokenResumeContext,
} from '../execution/types.js';
import { isExecutionError } from '../execution/errors.js';
import type { Env as WorkerEnv, SandboxId } from '../types.js';
import { generateSandboxId, getSandboxNamespace } from '../sandbox-id.js';

import { validateStreamTicket } from '../auth.js';
import { getSandbox } from '@cloudflare/sandbox';
import { stopWrapper } from '../kilo/wrapper-manager.js';
import { SessionService } from '../session-service.js';
import { executePreparationSteps } from './async-preparation.js';
import { resolveManagedGitLabToken } from '../services/git-token-service-client.js';

// ---------------------------------------------------------------------------
// Alarm Constants
// ---------------------------------------------------------------------------

/** Reaper alarm interval: 5 minutes */
const REAPER_INTERVAL_MS_DEFAULT = 5 * 60 * 1000;
/** Shorter reaper interval while execution is active: 2 minutes */
const REAPER_ACTIVE_INTERVAL_MS = 2 * 60 * 1000;
/** Longer reaper interval when idle (no active execution): 1 hour */
const REAPER_IDLE_INTERVAL_MS = 60 * 60 * 1000;
const PENDING_START_TIMEOUT_MS_DEFAULT = 3 * 60 * 1000;

/** Event retention period: 90 days (aligns with session TTL) */
const EVENT_RETENTION_MS = Limits.SESSION_TTL_MS;

/** Storage key for tracking last activity timestamp */
const LAST_ACTIVITY_KEY = 'last_activity';

/** Kilo server idle timeout: 15 minutes */
const KILO_SERVER_IDLE_TIMEOUT_MS_DEFAULT = 15 * 60 * 1000;

/** Default per-execution wall-clock deadline: 30 minutes */
const DEFAULT_MAX_RUNTIME_MS = 1_800_000;

/** Hung execution timeout: no non-heartbeat events for 5 minutes */
const HUNG_EXECUTION_TIMEOUT_MS = 5 * 60 * 1000;

/** Grace period before failing execution after wrapper disconnect (ms).
 *  Covers the first few reconnection attempts (exponential backoff: 1s, 2s, 4s …). */
const DISCONNECT_GRACE_MS = 10_000;

/** DO storage key for persisting disconnect grace state across hibernation. */
const DISCONNECT_GRACE_KEY = 'disconnect_grace';

/** DO storage key for pending async preparation input. */
const PENDING_PREPARATION_KEY = 'pending_preparation';

/** Stored in DO storage under DISCONNECT_GRACE_KEY while a grace period is active. */
type DisconnectGraceState = {
  executionId: ExecutionId;
  disconnectedAt: number;
  wsCloseCode: number;
  wsCloseReason: string;
};

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

export class CloudAgentSession extends DurableObject<WorkerEnv> {
  private executionQueries: ExecutionQueries;
  private eventQueries: EventQueries;
  private leaseQueries: LeaseQueries;
  private streamHandler?: StreamHandler;
  private ingestHandler?: IngestHandler;
  private streamHandlerSessionId?: SessionId;
  private ingestHandlerSessionId?: SessionId;
  private sessionId?: SessionId;
  private orchestrator?: ExecutionOrchestrator;
  private isTerminalStatus(
    status: ExecutionStatus
  ): status is 'completed' | 'failed' | 'interrupted' {
    return status === 'completed' || status === 'failed' || status === 'interrupted';
  }

  private async enqueueCallbackNotification(
    executionId: ExecutionId,
    status: 'completed' | 'failed' | 'interrupted',
    error?: string,
    gateResult?: 'pass' | 'fail'
  ): Promise<void> {
    const metadata = await this.getMetadata();
    const callbackQueue = this.env.CALLBACK_QUEUE;

    if (!metadata?.callbackTarget || !callbackQueue) {
      return;
    }

    logger.info('Enqueued callback job', {
      cloudAgentSessionId: metadata.sessionId,
      kiloSessionId: metadata.kiloSessionId,
      executionId,
      callbackUrl: metadata.callbackTarget.url,
    });

    const resolvedSessionId = await this.resolveSessionId(metadata.sessionId as SessionId);
    const sessionId = resolvedSessionId ?? metadata.sessionId ?? '';

    const lastAssistantMessageText =
      status === 'completed' ? await this.getLatestAssistantMessageText() : undefined;

    const callbackJob: CallbackJob = {
      target: metadata.callbackTarget,
      payload: {
        sessionId,
        cloudAgentSessionId: sessionId,
        executionId,
        status,
        errorMessage: error,
        lastSeenBranch: metadata.upstreamBranch,
        kiloSessionId: metadata.kiloSessionId,
        gateResult,
        lastAssistantMessageText,
      },
    };

    // Fire-and-forget enqueue - don't block execution completion
    callbackQueue.send(callbackJob).catch(err => {
      logger
        .withFields({
          sessionId,
          executionId,
          error: err instanceof Error ? err.message : String(err),
        })
        .error('Failed to enqueue callback job');
    });
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

    const metadata = await this.ctx.storage.get<CloudAgentSessionState>('metadata');
    if (metadata?.sessionId) {
      if (expected && metadata.sessionId !== expected) {
        throw new Error(`SessionId mismatch: ${expected} != ${metadata.sessionId}`);
      }
      this.sessionId = metadata.sessionId as SessionId;
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

  private async getStreamHandler(expected?: SessionId): Promise<StreamHandler> {
    const sessionId = await this.requireSessionId(expected);
    if (!this.streamHandler || this.streamHandlerSessionId !== sessionId) {
      this.streamHandler = createStreamHandler(this.ctx, this.eventQueries, sessionId, {
        deriveCloudStatus: () => this.deriveCloudStatus(),
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
        clearActiveExecution: () => this.clearActiveExecution(),
        getActiveExecutionId: () => this.executionQueries.getActiveExecutionId(),
        cancelDisconnectGrace: () => this.cancelDisconnectGrace(),
        getExecution: async (executionId: string) => {
          const execution = await this.executionQueries.get(executionId as ExecutionId);
          if (!execution) return null;
          return {
            executionId: execution.executionId,
            status: execution.status,
            ingestToken: execution.ingestToken,
          };
        },
        transitionToRunning: async (executionId: string) => {
          const result = await this.executionQueries.updateStatus({
            executionId: executionId as ExecutionId,
            status: 'running',
          });
          return result.ok;
        },
        updateHeartbeat: async (executionId: string, timestamp: number) => {
          await this.executionQueries.updateHeartbeat(executionId as ExecutionId, timestamp);
          // Reset the sandbox container's sleep timer alongside the heartbeat.
          // The wrapper heartbeat travels over an outbound WebSocket that
          // bypasses containerFetch(), so the idle timer never refreshes otherwise.
          void this.keepContainerAlive();
        },
        updateLastEventAt: async (executionId: string, timestamp: number) => {
          await this.executionQueries.updateLastEventAt(executionId as ExecutionId, timestamp);
        },
        updateExecutionStatus: async (
          executionId: string,
          status: 'completed' | 'failed' | 'interrupted',
          error?: string,
          gateResult?: 'pass' | 'fail'
        ) => {
          await this.updateExecutionStatus({
            executionId: executionId as ExecutionId,
            status,
            error,
            completedAt: Date.now(),
            gateResult,
          });
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

      const allowedOrigins = (this.env.WS_ALLOWED_ORIGINS || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);

      if (allowedOrigins.length > 0 && origin && !allowedOrigins.includes(origin)) {
        logger
          .withFields({ origin, allowedOrigins, sessionId: sessionIdParam })
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
      void ingestHandler.handleIngestMessage(ws, message);
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
      const disconnectedExecutionId = ingestHandler.handleIngestClose(ws);

      // If the wrapper disconnected while its execution was still active, start a
      // grace period before failing. This gives the wrapper time to reconnect
      // (exponential backoff: 1s, 2s, 4s …).
      if (disconnectedExecutionId) {
        const activeExecutionId = await this.executionQueries.getActiveExecutionId();
        if (activeExecutionId === disconnectedExecutionId) {
          const execution = await this.executionQueries.get(activeExecutionId);
          if (execution && (execution.status === 'running' || execution.status === 'pending')) {
            await this.startDisconnectGrace(activeExecutionId, code, reason);
          }
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
    const activeExecId = await this.executionQueries.getActiveExecutionId();
    if (!activeExecId) {
      const metadata = await this.ctx.storage.get<CloudAgentSessionState>('metadata');
      return metadata?.preparedAt ? { type: 'ready' } : null;
    }

    const exec = await this.executionQueries.get(activeExecId);
    if (!exec) return null;

    if (exec.status === 'pending') {
      return { type: 'preparing' };
    }

    // Running executions mean the agent has control — infrastructure is ready
    return { type: 'ready' };
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
  async getMetadata(): Promise<CloudAgentSessionState | null> {
    const metadata = await this.ctx.storage.get<CloudAgentSessionState>('metadata');
    return metadata || null;
  }

  async getLatestAssistantMessage(): Promise<LatestAssistantMessage | null> {
    const sessionId = await this.requireSessionId();
    const metadata = await this.getMetadata();
    if (!metadata?.kiloSessionId) return null;
    return this.eventQueries.getLatestAssistantMessage(sessionId, metadata.kiloSessionId);
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
    const result = MetadataSchema.safeParse(data);
    if (!result.success) {
      throw new Error(`Invalid metadata structure: ${JSON.stringify(result.error.format())}`);
    }

    const newMetadata: CloudAgentSessionState = result.data;
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
      kiloSessionId,
      version: Date.now(), // Bump version for cache invalidation
    };

    await this.updateMetadata(updated);
  }

  /**
   * Update the GitHub Personal Access Token for this session.
   * This allows refreshing tokens without re-initializing the session.
   */
  async updateGithubToken(githubToken: string): Promise<void> {
    const metadata = await this.getMetadata();
    if (!metadata) {
      throw new Error('Cannot update githubToken: session metadata not found');
    }

    const updated = {
      ...metadata,
      githubToken,
      version: Date.now(), // Bump version for cache invalidation
    };

    await this.updateMetadata(updated);
  }

  /**
   * Update the Git token for this session (for generic git repos).
   * This allows refreshing tokens without re-initializing the session.
   */
  async updateGitToken(gitToken: string): Promise<void> {
    const metadata = await this.getMetadata();
    if (!metadata) {
      throw new Error('Cannot update gitToken: session metadata not found');
    }

    const updated = {
      ...metadata,
      gitToken,
      version: Date.now(), // Bump version for cache invalidation
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
      callbackTarget,
      version: Date.now(), // Bump version for cache invalidation
    };

    await this.updateMetadata(updated);
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

    const updated = {
      ...metadata,
      upstreamBranch,
      version: Date.now(), // Bump version for cache invalidation
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
      kiloServerLastActivity: Date.now(),
      version: Date.now(),
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
   * @param executionId - The execution whose wrapper should receive the command
   * @param command - The command to send (kill, ping)
   */
  sendToWrapper(executionId: ExecutionId, command: WrapperCommand): void {
    const wrappers = this.ctx.getWebSockets(`ingest:${executionId}`);
    for (const ws of wrappers) {
      ws.send(JSON.stringify(command));
    }
  }

  /**
   * Request fresh kilo state from the wrapper.
   * The wrapper will respond with regular kilocode events (session.status,
   * question.asked, permission.asked) that flow through the normal ingest pipeline.
   * Best-effort: silently does nothing if no wrapper is connected.
   */
  private requestKiloSnapshot(): void {
    void this.executionQueries.getActiveExecutionId().then(activeExecId => {
      if (!activeExecId) return;
      this.sendToWrapper(activeExecId, { type: 'request_snapshot' });
    });
  }

  /**
   * Interrupt the currently active execution by sending a kill command to the wrapper.
   * Returns success/failure status.
   *
   * @returns Result indicating if the interrupt was initiated
   */
  async interruptExecution(): Promise<{ success: boolean; message?: string }> {
    const activeExecutionId = await this.executionQueries.getActiveExecutionId();

    if (!activeExecutionId) {
      return { success: false, message: 'No active execution' };
    }

    // Send kill command directly to wrapper
    this.sendToWrapper(activeExecutionId, { type: 'kill', signal: 'SIGTERM' });

    return { success: true };
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
   * Atomically prepare a session - sets preparedAt timestamp.
   * Fails if session was already prepared.
   * Validates input against MetadataSchema before storing.
   */
  async prepare(input: {
    sessionId: string;
    userId: string;
    orgId?: string;
    botId?: string;
    kiloSessionId: string;
    prompt: string;
    mode: string;
    model: string;
    variant?: string;
    kilocodeToken?: string;
    githubRepo?: string;
    githubToken?: string;
    githubInstallationId?: string;
    githubAppType?: 'standard' | 'lite';
    gitUrl?: string;
    gitToken?: string;
    platform?: 'github' | 'gitlab';
    gitlabTokenManaged?: boolean;
    envVars?: Record<string, string>;
    encryptedSecrets?: EncryptedSecrets;
    setupCommands?: string[];
    mcpServers?: Record<string, MCPServerConfig>;
    autoCommit?: boolean;
    condenseOnComplete?: boolean;
    appendSystemPrompt?: string;
    upstreamBranch?: string;
    callbackTarget?: CallbackTarget;
    images?: Images;
    createdOnPlatform?: string;
    gateThreshold?: 'off' | 'all' | 'warning' | 'critical';
    initialMessageId?: string;
    // Workspace metadata (set during prepareSession)
    workspacePath?: string;
    sessionHome?: string;
    branchName?: string;
    sandboxId?: SandboxId;
  }): Promise<OperationResult> {
    await this.requireSessionId(input.sessionId as SessionId);
    const existing = await this.ctx.storage.get<CloudAgentSessionState>('metadata');
    if (existing?.preparedAt) {
      return { success: false, error: 'Session already prepared' };
    }

    const now = Date.now();

    const metadata: CloudAgentSessionState = {
      ...input,
      version: now,
      timestamp: now,
      preparedAt: now,
    };

    // Validate against schema before storing
    const parseResult = MetadataSchema.safeParse(metadata);
    if (!parseResult.success) {
      return {
        success: false,
        error: `Invalid metadata: ${JSON.stringify(parseResult.error.format())}`,
      };
    }

    await this.ctx.storage.put('metadata', parseResult.data);

    // Track activity and ensure reaper alarm is scheduled
    await this.updateLastActivity();
    await this.ensureAlarmScheduled();

    return { success: true };
  }

  /**
   * Lightweight registration for async preparation flow.
   * Stores minimal metadata WITHOUT setting preparedAt.
   * Makes getMetadata() return non-null so the chat page can distinguish
   * "async prep in progress" from "no DO at all".
   */
  async registerSession(input: {
    sessionId: string;
    userId: string;
    orgId?: string;
    botId?: string;
    prompt: string;
    mode: string;
    model: string;
    variant?: string;
    kiloSessionId?: string;
    githubRepo?: string;
    gitUrl?: string;
    platform?: 'github' | 'gitlab';
    initialMessageId?: string;
  }): Promise<OperationResult> {
    await this.requireSessionId(input.sessionId as SessionId);
    const existing = await this.ctx.storage.get<CloudAgentSessionState>('metadata');
    if (existing) {
      return { success: false, error: 'Session already registered' };
    }

    const now = Date.now();
    const metadata: CloudAgentSessionState = {
      sessionId: input.sessionId,
      userId: input.userId,
      orgId: input.orgId,
      botId: input.botId,
      prompt: input.prompt,
      mode: input.mode,
      model: input.model,
      variant: input.variant,
      kiloSessionId: input.kiloSessionId,
      githubRepo: input.githubRepo,
      gitUrl: input.gitUrl,
      platform: input.platform,
      initialMessageId: input.initialMessageId,
      version: now,
      timestamp: now,
      // NOTE: preparedAt is NOT set — this is the key difference from prepare()
    };

    const parseResult = MetadataSchema.safeParse(metadata);
    if (!parseResult.success) {
      return {
        success: false,
        error: `Invalid metadata: ${JSON.stringify(parseResult.error.format())}`,
      };
    }

    await this.ctx.storage.put('metadata', parseResult.data);
    await this.updateLastActivity();
    await this.ensureAlarmScheduled();

    return { success: true };
  }

  /**
   * Schedule async preparation via alarm.
   * Stores the preparation input in DO storage and schedules an immediate
   * alarm. The alarm handler will pick it up and run the expensive work.
   * This approach is safe regardless of caller lifetime — the DO wakes
   * itself up via the alarm even if the original worker request has ended.
   */
  async startPreparationAsync(input: PreparationInput): Promise<void> {
    await this.ctx.storage.put(PENDING_PREPARATION_KEY, input);
    // Schedule an immediate alarm to run the preparation.
    // If an alarm is already pending (e.g. reaper), setAlarm replaces it —
    // the reaper will self-reschedule when it next runs.
    await this.ctx.storage.setAlarm(Date.now());
  }

  /**
   * Internal: run all expensive preparation steps, emitting progress events.
   * Workspace orchestration (clone, setup, wrapper start) is delegated to
   * executePreparationSteps(); this method handles the DO-specific bookkeeping
   * (metadata, progress events, auto-initiate, error cleanup).
   */
  private async runPreparationAsync(input: PreparationInput): Promise<void> {
    const sessionId = input.sessionId as SessionId;
    const prepExecutionId: EventSourceId = `prep_${input.sessionId}`;
    const env = this.env;

    const emitProgress = (
      step: PreparingStep,
      message: string,
      extra?: Omit<PreparingEventData, 'step' | 'message'>
    ) => {
      const now = Date.now();
      // Backward-compatible preparing event
      this.broadcastVolatileEvent({
        executionId: prepExecutionId,
        sessionId: input.sessionId,
        streamEventType: 'preparing',
        payload: JSON.stringify({ step, message, ...extra }),
        timestamp: now,
      });
      // cloud.status event derived from preparation step
      const cloudStatus =
        step === 'ready'
          ? { type: 'ready' as const }
          : step === 'failed'
            ? { type: 'error' as const, message }
            : { type: 'preparing' as const, step, message };
      this.broadcastVolatileEvent({
        executionId: prepExecutionId,
        sessionId: input.sessionId,
        streamEventType: 'cloud.status',
        payload: JSON.stringify({ cloudStatus }),
        timestamp: now,
      });
    };

    let createdKiloSessionId: string | undefined = input.kiloSessionId;

    const cleanupCliSession = async () => {
      if (!createdKiloSessionId) return;
      const svc = new SessionService();
      try {
        await svc.deleteCliSessionViaSessionIngest(createdKiloSessionId, input.userId, env, {
          onlyIfEmpty: true,
        });
      } catch (cleanupError) {
        logger
          .withFields({
            sessionId,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          })
          .warn('Failed to clean up cli_sessions_v2 record (onlyIfEmpty)');
      }
    };

    try {
      // Steps 1–9: workspace orchestration (token, disk, clone, branch, setup, wrapper)
      const result = await executePreparationSteps(input, env, emitProgress);
      if (!result) {
        // executePreparationSteps already emitted 'failed' — clean up DO metadata
        await this.ctx.storage.delete('metadata');
        await cleanupCliSession();
        return;
      }

      createdKiloSessionId = result.kiloSessionId;

      // 10. Store full metadata via prepare() — sets preparedAt
      const prepareResult = await this.prepare({
        sessionId: input.sessionId,
        userId: input.userId,
        orgId: input.orgId,
        botId: input.botId,
        kiloSessionId: result.kiloSessionId,
        prompt: input.prompt,
        mode: input.mode,
        model: input.model,
        variant: input.variant,
        kilocodeToken: input.authToken,
        githubRepo: input.githubRepo,
        githubToken: input.githubToken,
        githubInstallationId: result.resolvedInstallationId,
        githubAppType: result.resolvedGithubAppType,
        gitUrl: input.gitUrl,
        gitToken: result.resolvedGitToken,
        platform: input.platform,
        gitlabTokenManaged: result.gitlabTokenManaged,
        envVars: input.envVars,
        encryptedSecrets: input.encryptedSecrets,
        setupCommands: input.setupCommands,
        mcpServers: input.mcpServers,
        upstreamBranch: input.upstreamBranch,
        autoCommit: input.autoCommit,
        condenseOnComplete: input.condenseOnComplete,
        appendSystemPrompt: input.appendSystemPrompt,
        callbackTarget: input.callbackTarget,
        images: input.images,
        createdOnPlatform: input.createdOnPlatform,
        gateThreshold: input.gateThreshold,
        workspacePath: result.workspacePath,
        sessionHome: result.sessionHome,
        branchName: result.branchName,
        sandboxId: result.sandboxId,
        initialMessageId: input.initialMessageId,
      });

      if (!prepareResult.success) {
        emitProgress('failed', prepareResult.error ?? 'Failed to prepare session');
        await this.ctx.storage.delete('metadata');
        await cleanupCliSession();
        return;
      }

      await this.recordKiloServerActivity();

      // 11. Auto-initiate if requested, then emit ready only on success.
      // Emitting 'ready' before startExecutionV2 would let the client
      // unlock chat input for a session that may fail to initiate.
      if (input.autoInitiate) {
        const initiateResult = await this.startExecutionV2({
          kind: 'initiatePrepared',
          userId: input.userId as UserId,
          botId: input.botId,
          authToken: input.authToken,
        });

        if (!initiateResult.success) {
          logger
            .withFields({ sessionId, error: initiateResult.error })
            .error('Auto-initiate failed after async preparation');

          // startExecutionV2 persists initiatedAt via tryInitiate() before
          // attempting execution. Roll it back so the session doesn't appear
          // initiated with no running execution (stuck state).
          const staleMetadata = await this.ctx.storage.get<CloudAgentSessionState>('metadata');
          if (staleMetadata?.initiatedAt) {
            const { initiatedAt: _, ...rest } = staleMetadata;
            await this.ctx.storage.put('metadata', { ...rest, version: Date.now() });
          }

          emitProgress('failed', `Auto-initiate failed: ${initiateResult.error}`);
          return;
        }
      }

      // 12. Emit ready — session is prepared (and initiated, if autoInitiate)
      emitProgress('ready', 'Session ready', { branch: result.branchName });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger
        .withFields({
          sessionId,
          error: message,
          stack: error instanceof Error ? error.stack : undefined,
        })
        .error('Async preparation failed');

      await cleanupCliSession();

      emitProgress('failed', message);
      await this.ctx.storage.delete('metadata');
    }
  }

  /**
   * Atomically update a prepared session - only succeeds if prepared but not initiated.
   * Single DO request ensures atomicity.
   * Validates updated metadata against MetadataSchema before storing.
   */
  async tryUpdate(updates: {
    mode?: string | null;
    model?: string | null;
    variant?: string | null;
    githubToken?: string | null;
    gitToken?: string | null;
    autoCommit?: boolean | null;
    condenseOnComplete?: boolean | null;
    appendSystemPrompt?: string | null;
    envVars?: Record<string, string>;
    encryptedSecrets?: EncryptedSecrets;
    setupCommands?: string[];
    mcpServers?: Record<string, MCPServerConfig>;
    callbackTarget?: CallbackTarget | null;
    upstreamBranch?: string | null;
  }): Promise<OperationResult> {
    const metadata = await this.ctx.storage.get<CloudAgentSessionState>('metadata');

    if (!metadata?.preparedAt) {
      return { success: false, error: 'Session has not been prepared' };
    }

    // callbackTarget can be updated even after initiation (needed for follow-up
    // reviews that reuse an existing session with a new callback URL).
    // All other fields are immutable once initiated.
    const allKeys = Object.keys(updates).filter(
      k => updates[k as keyof typeof updates] !== undefined
    );
    const onlyCallbackTarget = allKeys.length === 1 && allKeys[0] === 'callbackTarget';
    if (metadata.initiatedAt && !onlyCallbackTarget) {
      return { success: false, error: 'Session has already been initiated' };
    }

    // Apply updates (handle null for clearing)
    const updated = { ...metadata };
    for (const [key, value] of Object.entries(updates)) {
      if (value === null) {
        delete (updated as Record<string, unknown>)[key];
      } else if (value !== undefined) {
        (updated as Record<string, unknown>)[key] = value;
      }
    }
    const now = Date.now();
    updated.version = now;
    updated.timestamp = now;

    // Validate against schema before storing
    const parseResult = MetadataSchema.safeParse(updated);
    if (!parseResult.success) {
      return {
        success: false,
        error: `Invalid metadata after update: ${JSON.stringify(parseResult.error.format())}`,
      };
    }

    await this.ctx.storage.put('metadata', parseResult.data);

    // Track activity for session TTL
    await this.updateLastActivity();

    return { success: true };
  }

  /**
   * Atomically initiate a prepared session - sets initiatedAt timestamp.
   * Returns the full metadata on success for execution.
   * Single DO request ensures no race between update and initiate.
   */
  async tryInitiate(): Promise<OperationResult<CloudAgentSessionState>> {
    const metadata = await this.ctx.storage.get<CloudAgentSessionState>('metadata');

    if (!metadata?.preparedAt) {
      return { success: false, error: 'Session has not been prepared' };
    }
    if (metadata.initiatedAt) {
      return { success: false, error: 'Session has already been initiated' };
    }

    const now = Date.now();

    const updated: CloudAgentSessionState = {
      ...metadata,
      initiatedAt: now,
      version: now,
      timestamp: now,
    };

    await this.ctx.storage.put('metadata', updated);

    // Track activity for session TTL
    await this.updateLastActivity();

    return { success: true, data: updated };
  }

  // ---------------------------------------------------------------------------
  // Alarm Reaper
  // ---------------------------------------------------------------------------

  /**
   * Alarm handler for periodic cleanup tasks.
   * Runs every REAPER_INTERVAL_MS to:
   * 1. Clean up stale executions (no heartbeat for STALE_THRESHOLD_MS)
   * 2. Clean up old events (older than EVENT_RETENTION_MS)
   * 3. Clean up expired leases
   * 4. Check if session should be deleted due to inactivity
   */
  async alarm(): Promise<void> {
    const now = Date.now();

    logger
      .withFields({ doId: this.ctx.id.toString(), sessionId: this.sessionId })
      .info('Alarm fired');

    try {
      // Run pending async preparation if scheduled.
      // This must run before other alarm duties because it can take minutes
      // (git clone, setup commands, etc.). The reaper self-reschedules at the end.
      const pendingPrep = await this.ctx.storage.get(PENDING_PREPARATION_KEY);
      if (pendingPrep) {
        await this.ctx.storage.delete(PENDING_PREPARATION_KEY);
        const parsed = PreparationInputSchema.safeParse(pendingPrep);
        if (parsed.success) {
          await this.runPreparationAsync(parsed.data);
        } else {
          logger
            .withFields({ error: JSON.stringify(parsed.error.format()) })
            .error('Invalid pending preparation data in storage');

          // Clean up resources left behind by registerSession/createCliSession
          // so the session doesn't sit in a zombie preparing state forever.
          const metadata = await this.ctx.storage.get<CloudAgentSessionState>('metadata');
          await this.ctx.storage.delete('metadata');

          if (metadata?.kiloSessionId && metadata?.userId) {
            const svc = new SessionService();
            try {
              await svc.deleteCliSessionViaSessionIngest(
                metadata.kiloSessionId,
                metadata.userId,
                this.env,
                { onlyIfEmpty: true }
              );
            } catch {
              // Best-effort — already logged the root cause above
            }
          }

          if (this.sessionId) {
            const prepId: EventSourceId = `prep_${this.sessionId}`;
            const failNow = Date.now();
            const failMessage = 'Internal error: invalid preparation data';
            this.broadcastVolatileEvent({
              executionId: prepId,
              sessionId: this.sessionId,
              streamEventType: 'preparing',
              payload: JSON.stringify({ step: 'failed', message: failMessage }),
              timestamp: failNow,
            });
            this.broadcastVolatileEvent({
              executionId: prepId,
              sessionId: this.sessionId,
              streamEventType: 'cloud.status',
              payload: JSON.stringify({ cloudStatus: { type: 'error', message: failMessage } }),
              timestamp: failNow,
            });
          }
        }
      }

      // Check disconnect grace period first — this alarm may have been
      // rescheduled specifically for the grace deadline.
      await this.checkDisconnectGrace();

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

      logger
        .withFields({ sessionId: this.sessionId, lastActivity, elapsedMs: Date.now() - now })
        .debug('TTL check passed');

      // Run cleanup tasks
      logger
        .withFields({ sessionId: this.sessionId, elapsedMs: Date.now() - now })
        .debug('Starting cleanupStaleExecutions');
      await this.cleanupStaleExecutions(now);

      logger
        .withFields({ sessionId: this.sessionId, elapsedMs: Date.now() - now })
        .debug('Starting checkHungExecution');
      await this.checkHungExecution(now);

      logger
        .withFields({ sessionId: this.sessionId, elapsedMs: Date.now() - now })
        .debug('Starting checkMaxRuntime');
      await this.checkMaxRuntime(now);

      logger
        .withFields({ sessionId: this.sessionId, elapsedMs: Date.now() - now })
        .debug('Starting cleanupOldEvents');
      this.cleanupOldEvents(now);

      logger
        .withFields({ sessionId: this.sessionId, elapsedMs: Date.now() - now })
        .debug('Starting cleanupExpiredLeases');
      this.cleanupExpiredLeases(now);

      // Check if kilo server should be stopped due to inactivity
      logger
        .withFields({ sessionId: this.sessionId, elapsedMs: Date.now() - now })
        .debug('Starting cleanupIdleKiloServer');
      await this.cleanupIdleKiloServer(now);

      logger
        .withFields({ sessionId: this.sessionId, elapsedMs: Date.now() - now })
        .debug('All cleanup steps completed');
    } catch (error) {
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

    // Schedule next alarm run — use shorter interval while an execution is active,
    // longer idle interval otherwise so we don't wake the DO every 5 min for nothing.
    // Wrapped in try/catch so a failure here never prevents rescheduling the alarm.
    let nextInterval = REAPER_IDLE_INTERVAL_MS;
    try {
      const activeExecutionId = await this.executionQueries.getActiveExecutionId();
      if (activeExecutionId) {
        nextInterval = REAPER_ACTIVE_INTERVAL_MS;
      }
    } catch {
      // Can't determine state — use a conservative short interval so the
      // reaper retries soon rather than sleeping for an hour.
      nextInterval = REAPER_INTERVAL_MS_DEFAULT;
    }
    logger
      .withFields({ sessionId: this.sessionId, nextInterval, elapsedMs: Date.now() - now })
      .info('Rescheduling alarm');
    await this.ctx.storage.setAlarm(Date.now() + nextInterval);
  }

  /**
   * Ensure the reaper alarm is scheduled.
   * Called during initialization and when session is first created.
   */
  private async ensureAlarmScheduled(): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null) {
      await this.ctx.storage.setAlarm(Date.now() + this.getReaperIntervalMs());
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
   * Clean up stale executions that have stopped heartbeating.
   * Marks them as failed and clears the active execution.
   */
  private async cleanupStaleExecutions(now: number): Promise<void> {
    const activeExecutionId = await this.executionQueries.getActiveExecutionId();

    if (!activeExecutionId) return;

    // Get the execution metadata
    const execution = await this.executionQueries.get(activeExecutionId);

    if (!execution) {
      // Orphaned active execution ID - clear it
      logger
        .withFields({ sessionId: this.sessionId, executionId: activeExecutionId })
        .warn('Clearing orphaned active execution ID');
      await this.executionQueries.clearActiveExecution();
      return;
    }

    // Check if execution is stale (no heartbeat for STALE_THRESHOLD_MS)
    if (execution.status === 'running') {
      const staleThresholdMs = this.getStaleThresholdMs();
      const isStale = !execution.lastHeartbeat || now - execution.lastHeartbeat > staleThresholdMs;

      if (isStale) {
        logger
          .withFields({
            sessionId: this.sessionId,
            executionId: activeExecutionId,
            lastHeartbeat: execution.lastHeartbeat,
            staleDurationMs: execution.lastHeartbeat ? now - execution.lastHeartbeat : 'never',
            staleThresholdMs,
          })
          .info('Marking stale execution as failed');

        await this.failExecution({
          executionId: activeExecutionId,
          status: 'failed',
          error: 'Execution timeout - no heartbeat received',
          streamEventType: 'error',
        });
      }
    }

    if (execution.status === 'pending') {
      const pendingTimeoutMs = this.getPendingStartTimeoutMs();
      const isPendingTooLong = now - execution.startedAt > pendingTimeoutMs;

      if (isPendingTooLong) {
        logger
          .withFields({
            sessionId: this.sessionId,
            executionId: activeExecutionId,
            startedAt: execution.startedAt,
            pendingTimeoutMs,
          })
          .info('Marking stuck pending execution as failed');

        await this.failExecution({
          executionId: activeExecutionId,
          status: 'failed',
          error: 'Execution timeout - wrapper never connected',
          streamEventType: 'error',
        });
      }
    }
  }

  /**
   * Fail a running execution that hasn't received any non-heartbeat events
   * for HUNG_EXECUTION_TIMEOUT_MS. Skipped when lastEventAt is undefined
   * (other checks handle that case).
   */
  private async checkHungExecution(now: number): Promise<void> {
    const activeExecutionId = await this.executionQueries.getActiveExecutionId();
    if (!activeExecutionId) return;

    const execution = await this.executionQueries.get(activeExecutionId);
    if (!execution || execution.status !== 'running') return;
    if (execution.lastEventAt === undefined) return;

    if (now - execution.lastEventAt > HUNG_EXECUTION_TIMEOUT_MS) {
      logger
        .withFields({
          sessionId: this.sessionId,
          executionId: activeExecutionId,
          lastEventAt: execution.lastEventAt,
          hungDurationMs: now - execution.lastEventAt,
        })
        .info('Marking hung execution as failed');

      await this.failExecution({
        executionId: activeExecutionId,
        status: 'failed',
        error: 'Execution hung — no events received for 5 minutes',
        streamEventType: 'error',
      });
    }
  }

  /**
   * Fail a running execution that has exceeded its wall-clock deadline
   * (DEFAULT_MAX_RUNTIME_MS = 30 min).
   */
  private async checkMaxRuntime(now: number): Promise<void> {
    const activeExecutionId = await this.executionQueries.getActiveExecutionId();
    if (!activeExecutionId) return;

    const execution = await this.executionQueries.get(activeExecutionId);
    if (!execution || execution.status !== 'running') return;

    if (now - execution.startedAt > DEFAULT_MAX_RUNTIME_MS) {
      logger
        .withFields({
          sessionId: this.sessionId,
          executionId: activeExecutionId,
          startedAt: execution.startedAt,
          maxRuntimeMs: DEFAULT_MAX_RUNTIME_MS,
          elapsedMs: now - execution.startedAt,
        })
        .info('Marking execution as failed — exceeded maximum runtime');

      await this.failExecution({
        executionId: activeExecutionId,
        status: 'failed',
        error: 'Execution exceeded maximum runtime',
        streamEventType: 'error',
      });
    }
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

  /** Initial reaper interval used only by {@link ensureAlarmScheduled}.
   *  Steady-state intervals are {@link REAPER_IDLE_INTERVAL_MS} / {@link REAPER_ACTIVE_INTERVAL_MS}. */
  private getReaperIntervalMs(): number {
    const value = Number(this.env.REAPER_INTERVAL_MS);
    return Number.isFinite(value) && value > 0 ? value : REAPER_INTERVAL_MS_DEFAULT;
  }

  private getStaleThresholdMs(): number {
    const value = Number(this.env.STALE_THRESHOLD_MS);
    return Number.isFinite(value) && value > 0 ? value : STALE_THRESHOLD_MS;
  }

  private getPendingStartTimeoutMs(): number {
    const value = Number(this.env.PENDING_START_TIMEOUT_MS);
    return Number.isFinite(value) && value > 0 ? value : PENDING_START_TIMEOUT_MS_DEFAULT;
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

    const lastActivity = metadata.kiloServerLastActivity;
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

    // Check if there's an active execution - don't stop the server mid-run
    const activeExecutionId = await this.executionQueries.getActiveExecutionId();
    if (activeExecutionId !== null) {
      logger
        .withFields({
          sessionId: this.sessionId,
          executionId: activeExecutionId,
          idleMs,
        })
        .debug('Skipping idle kilo server cleanup - execution is active');
      return;
    }

    // Server has been idle too long and no active execution, stop it
    logger
      .withFields({
        sessionId: this.sessionId,
        idleMs,
        idleTimeoutMs,
      })
      .info('Stopping idle kilo server');

    try {
      const sandboxId =
        metadata.sandboxId ??
        (await generateSandboxId(
          this.env.PER_SESSION_SANDBOX_ORG_IDS,
          metadata.orgId,
          metadata.userId,
          metadata.sessionId,
          metadata.botId
        ));
      const sandbox = getSandbox(getSandboxNamespace(this.env, sandboxId), sandboxId);

      const rpcStart = Date.now();
      logger
        .withFields({ sessionId: this.sessionId, sandboxId })
        .debug('Starting stopKiloServer RPC');

      await stopWrapper(sandbox, metadata.sessionId);

      logger
        .withFields({ sessionId: this.sessionId, sandboxId, rpcElapsedMs: Date.now() - rpcStart })
        .debug('stopKiloServer RPC completed');

      // Clear the activity timestamp since server is stopped
      // Must merge with existing metadata since updateMetadata validates the full schema
      const updated = {
        ...metadata,
        kiloServerLastActivity: undefined,
        version: Date.now(),
      };
      await this.updateMetadata(updated);

      logger
        .withFields({ sessionId: this.sessionId, sandboxId })
        .info('Idle kilo server stopped successfully');
    } catch (error) {
      // Log but don't fail - server may already be stopped or sandbox recycled
      logger
        .withFields({
          sessionId: this.sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
        .warn('Failed to stop idle kilo server (may already be stopped)');
    }
  }

  /**
   * Reset the sandbox container's sleep timer so it stays alive during an
   * active execution.
   *
   * The wrapper heartbeat travels over an outbound WebSocket that bypasses
   * `containerFetch()`, so it never calls `renewActivityTimeout()`.  Calling
   * `setSleepAfter()` with the same value is a lightweight RPC that resets
   * the timer without changing the configuration.
   *
   * Called from the DO context's `updateHeartbeat` callback (debounced
   * to every 30 s by the ingest handler) while an execution is running.
   */
  private async keepContainerAlive(): Promise<void> {
    try {
      const metadata = await this.getMetadata();
      if (!metadata) return;

      const sandboxId =
        metadata.sandboxId ??
        (await generateSandboxId(
          this.env.PER_SESSION_SANDBOX_ORG_IDS,
          metadata.orgId,
          metadata.userId,
          metadata.sessionId,
          metadata.botId
        ));
      const sandbox = getSandbox(getSandboxNamespace(this.env, sandboxId), sandboxId);
      await sandbox.setSleepAfter(SANDBOX_SLEEP_AFTER_SECONDS);
    } catch (error) {
      logger
        .withFields({
          sessionId: this.sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
        .warn('Failed to reset sandbox sleep timer');
    }
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
  async updateExecutionStatus(
    params: UpdateExecutionStatusParams,
    opts?: { suppressCallback?: boolean }
  ): Promise<Result<ExecutionMetadata, UpdateStatusError>> {
    const result = await this.executionQueries.updateStatus(params);

    if (result.ok && this.isTerminalStatus(params.status) && !opts?.suppressCallback) {
      await this.enqueueCallbackNotification(
        params.executionId,
        params.status,
        params.error,
        params.gateResult
      );
    }

    return result;
  }

  /**
   * Cancel any pending disconnect grace period.
   * Clears the storage-persisted state so the next alarm ignores it.
   * Called when the wrapper reconnects or when another codepath fails
   * the execution.
   */
  private async cancelDisconnectGrace(): Promise<void> {
    await this.ctx.storage.delete(DISCONNECT_GRACE_KEY);
  }

  /**
   * Start the disconnect grace period for a wrapper that just disconnected.
   * Persists state to DO storage (survives hibernation) and reschedules the
   * alarm to fire at the grace deadline so it runs even if the DO sleeps.
   */
  private async startDisconnectGrace(
    executionId: ExecutionId,
    wsCloseCode: number,
    wsCloseReason: string
  ): Promise<void> {
    const now = Date.now();

    logger
      .withFields({
        sessionId: this.sessionId,
        executionId,
        wsCloseCode,
        wsCloseReason,
        graceMs: DISCONNECT_GRACE_MS,
      })
      .warn('Wrapper disconnected — starting grace period before marking as failed');

    const graceState: DisconnectGraceState = {
      executionId,
      disconnectedAt: now,
      wsCloseCode,
      wsCloseReason,
    };
    await this.ctx.storage.put(DISCONNECT_GRACE_KEY, graceState);

    // Reschedule alarm to fire at the grace deadline. The alarm handler
    // always reschedules itself afterward, so the normal reaper cadence
    // self-heals once this fires.
    await this.ctx.storage.setAlarm(now + DISCONNECT_GRACE_MS);
  }

  /**
   * Check and handle an expired disconnect grace period.
   * Called from alarm() before normal reaper duties.
   * Re-checks whether the wrapper reconnected or the execution completed
   * during the grace window before failing it.
   */
  private async checkDisconnectGrace(): Promise<void> {
    const graceState = await this.ctx.storage.get<DisconnectGraceState>(DISCONNECT_GRACE_KEY);
    if (!graceState) return;

    const elapsed = Date.now() - graceState.disconnectedAt;
    if (elapsed < DISCONNECT_GRACE_MS) return; // alarm fired early (e.g. reaper cadence)

    // Grace period has elapsed — clear the state first to avoid re-processing
    await this.ctx.storage.delete(DISCONNECT_GRACE_KEY);

    const { executionId, wsCloseCode, wsCloseReason } = graceState;

    // Re-check: wrapper may have reconnected during grace period
    const ingestHandler = await this.getIngestHandler();
    if (ingestHandler.hasActiveConnection(executionId)) {
      logger
        .withFields({ executionId })
        .info('Wrapper reconnected during grace period — skipping failure');
      return;
    }

    // Re-check execution state (may have completed normally during grace period)
    const currentExecution = await this.executionQueries.get(executionId);
    if (
      !currentExecution ||
      (currentExecution.status !== 'running' && currentExecution.status !== 'pending')
    ) {
      logger
        .withFields({
          executionId,
          status: currentExecution?.status,
        })
        .info('Execution no longer active during grace period — skipping failure');
      return;
    }

    logger.withFields({ executionId }).warn('Grace period expired — marking execution as failed');

    await this.failExecution({
      executionId,
      status: 'failed',
      error: 'Wrapper disconnected',
      streamEventType: 'wrapper_disconnected',
      streamPayload: { wsCloseCode, wsCloseReason },
    });
  }

  /**
   * Fail an execution with full cleanup.
   * Idempotent — safe to call if execution is already terminal.
   *
   * Performs:
   * 1. Update execution status to terminal (enqueues callback)
   * 2. Clear active execution (safety net)
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

    // Clear disconnect grace state — prevents double-failure if another codepath
    // already failed the execution while a grace period was pending.
    await this.cancelDisconnectGrace();

    // Snapshot active execution before updateStatus clears it — we need this to
    // decide whether to clean up the interrupt flag afterward.
    const wasActive = (await this.executionQueries.getActiveExecutionId()) === executionId;

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

    // 2. Clear active execution + interrupt only if this was the active execution.
    //    updateStatus already clears active_execution_id internally when it matches,
    //    so the clear here is a safety net. We skip both clears when this execution
    //    wasn't active to avoid clobbering a newer execution that started in between.
    if (wasActive) {
      const activeId = await this.executionQueries.getActiveExecutionId();
      if (activeId === executionId) {
        await this.executionQueries.clearActiveExecution();
      }
      await this.executionQueries.clearInterrupt();
    }

    // 4. Broadcast to /stream clients
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
   * Set the active execution for this session.
   */
  async setActiveExecution(executionId: ExecutionId): Promise<Result<void, SetActiveError>> {
    return this.executionQueries.setActiveExecution(executionId);
  }

  /**
   * Clear the active execution.
   */
  async clearActiveExecution(): Promise<void> {
    return this.executionQueries.clearActiveExecution();
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
   * Get the currently active execution ID.
   */
  async getActiveExecutionId(): Promise<ExecutionId | null> {
    return this.executionQueries.getActiveExecutionId();
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

  /**
   * Build an execution plan for the orchestrator.
   */
  private buildExecutionPlan(params: {
    executionId: ExecutionId;
    sandboxId: string;
    sessionId: SessionId;
    userId: UserId;
    orgId?: string;
    mode: ExecutionMode;
    prompt: string;
    model?: string;
    variant?: string;
    autoCommit?: boolean;
    condenseOnComplete?: boolean;
    messageId?: string;
    images?: Images;
    initContext?: InitializeContext;
    resumeContext?: TokenResumeContext;
    existingMetadata?: CloudAgentSessionState;
    kiloSessionId?: string;
  }): ExecutionPlan {
    const workspace = params.initContext
      ? {
          shouldPrepare: true as const,
          sandboxId: params.sandboxId,
          initContext: params.initContext,
          existingMetadata: params.existingMetadata
            ? {
                workspacePath: params.existingMetadata.workspacePath ?? '',
                kiloSessionId: params.existingMetadata.kiloSessionId ?? '',
                branchName: params.existingMetadata.branchName ?? '',
                sandboxId: params.existingMetadata.sandboxId,
                sessionHome: params.existingMetadata.sessionHome,
                upstreamBranch: params.existingMetadata.upstreamBranch,
                appendSystemPrompt: params.existingMetadata.appendSystemPrompt,
                githubRepo: params.existingMetadata.githubRepo,
                gitUrl: params.existingMetadata.gitUrl,
                createdOnPlatform: params.existingMetadata.createdOnPlatform,
              }
            : undefined,
        }
      : {
          shouldPrepare: false as const,
          sandboxId: params.sandboxId,
          resumeContext: {
            kiloSessionId: params.kiloSessionId ?? '',
            workspacePath: params.existingMetadata?.workspacePath ?? '',
            kilocodeToken: params.resumeContext?.kilocodeToken ?? '',
            kilocodeModel: params.resumeContext?.kilocodeModel,
            branchName: params.existingMetadata?.branchName ?? '',
            githubToken: params.resumeContext?.githubToken,
            gitToken: params.resumeContext?.gitToken,
            createdOnPlatform: params.existingMetadata?.createdOnPlatform,
          },
          existingMetadata: params.existingMetadata
            ? {
                workspacePath: params.existingMetadata.workspacePath ?? '',
                kiloSessionId: params.existingMetadata.kiloSessionId ?? '',
                branchName: params.existingMetadata.branchName ?? '',
                sandboxId: params.existingMetadata.sandboxId,
                sessionHome: params.existingMetadata.sessionHome,
                upstreamBranch: params.existingMetadata.upstreamBranch,
                appendSystemPrompt: params.existingMetadata.appendSystemPrompt,
                githubRepo: params.existingMetadata.githubRepo,
                gitUrl: params.existingMetadata.gitUrl,
                createdOnPlatform: params.existingMetadata.createdOnPlatform,
              }
            : undefined,
        };

    return {
      executionId: params.executionId,
      sessionId: params.sessionId,
      userId: params.userId,
      orgId: params.orgId,
      prompt: params.prompt,
      mode: params.mode,
      workspace,
      wrapper: {
        kiloSessionId: params.kiloSessionId,
        model: params.model ? { modelID: params.model.replace(/^kilo\//, '') } : undefined,
        variant: params.variant,
        autoCommit: params.autoCommit,
        condenseOnComplete: params.condenseOnComplete,
      },
      images: params.images,
      messageId: params.messageId,
    };
  }

  /**
   * Get or create the execution orchestrator.
   */
  private getOrCreateOrchestrator(): ExecutionOrchestrator {
    if (!this.orchestrator) {
      const deps: OrchestratorDeps = {
        getSandbox: async (sandboxId: string) => {
          return getSandbox(getSandboxNamespace(this.env, sandboxId), sandboxId, {
            sleepAfter: SANDBOX_SLEEP_AFTER_SECONDS,
          });
        },
        getSessionStub: (userId, sessionId) => {
          const doKey = `${userId}:${sessionId}`;
          const id = this.env.CLOUD_AGENT_SESSION.idFromName(doKey);
          return this.env.CLOUD_AGENT_SESSION.get(id);
        },
        getIngestUrl: (sessionId, userId) => {
          const workerUrl = this.env.WORKER_URL || 'http://localhost:8788';
          // Encode userId to handle OAuth IDs like "oauth/google:123" that contain slashes
          return `${workerUrl}/sessions/${encodeURIComponent(userId)}/${sessionId}/ingest`;
        },
        env: this.env,
      };
      this.orchestrator = new ExecutionOrchestrator(deps);
    }
    return this.orchestrator;
  }

  private buildStartResult(executionId: ExecutionId): StartExecutionV2Result {
    return {
      success: true,
      executionId,
      status: 'started',
    };
  }

  private buildStartError(
    code: Extract<StartExecutionV2Result, { success: false }>['code'],
    error: string,
    activeExecutionId?: ExecutionId
  ): StartExecutionV2Result {
    return {
      success: false,
      code,
      error,
      activeExecutionId,
    };
  }

  /**
   * Refresh a managed GitLab token via GIT_TOKEN_SERVICE. Logs and returns
   * the current value if the refresh fails with a transient reason so callers
   * can keep running with the last-known token (best effort). Successful
   * refreshes are persisted to metadata so a later refresh failure falls back
   * to the most recent working token rather than a stale prepare-time token.
   *
   * Access-revocation reasons (`no_integration_found`, `invalid_org_id`) fail
   * closed by throwing `BAD_REQUEST`: the stored token is no longer authorized
   * (integration was removed, or user lost access to the org) and continuing
   * to use it would bypass revocation.
   *
   * `gitlabTokenManaged === false` (explicitly set during prepare when the
   * caller supplied their own PAT) skips refresh. `undefined` — i.e. sessions
   * prepared before this flag existed — is treated as managed for backwards
   * compatibility, since the previous code path relied on the web app
   * injecting a fresh managed token on every `sendMessage`.
   */
  private async refreshManagedGitLabToken(
    metadata: CloudAgentSessionState,
    current: string | undefined
  ): Promise<string | undefined> {
    if (metadata.platform !== 'gitlab' || metadata.gitlabTokenManaged === false) {
      return current;
    }
    const result = await resolveManagedGitLabToken(this.env, {
      userId: metadata.userId,
      orgId: metadata.orgId,
    });
    if (result.success) {
      if (result.token !== current) {
        await this.updateGitToken(result.token);
      }
      return result.token;
    }
    if (result.reason === 'no_integration_found' || result.reason === 'invalid_org_id') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'No GitLab integration found. Please connect your GitLab account first.',
      });
    }
    logger
      .withFields({ reason: result.reason, sessionId: metadata.sessionId })
      .warn('Managed GitLab token refresh failed; using last-known value');
    return current;
  }

  /**
   * Start a V2 execution using direct execution (no queue).
   * This method performs validation, checks for active execution, and executes directly.
   *
   * Returns 409 Conflict (EXECUTION_IN_PROGRESS) if an execution is already active.
   */
  async startExecutionV2(request: StartExecutionV2Request): Promise<StartExecutionV2Result> {
    const sessionId = await this.requireSessionId();
    const executionId = createExecutionId();

    // Maps TRPCError codes to StartExecutionV2Result error codes.
    const mapTRPCCodeToResultCode = (
      trpcCode: string
    ): Extract<StartExecutionV2Result, { success: false }>['code'] => {
      switch (trpcCode) {
        case 'BAD_REQUEST':
          return 'BAD_REQUEST';
        case 'NOT_FOUND':
          return 'NOT_FOUND';
        default:
          return 'INTERNAL';
      }
    };

    try {
      // Check if there's already an active execution - return 409 if so
      const activeExecutionId = await this.executionQueries.getActiveExecutionId();
      if (activeExecutionId) {
        return this.buildStartError(
          'EXECUTION_IN_PROGRESS',
          `Execution ${activeExecutionId} is in progress`,
          activeExecutionId
        );
      }

      if (request.kind === 'initiate') {
        // Validate githubRepo requires authentication
        if (request.githubRepo && !request.githubToken) {
          return this.buildStartError(
            'BAD_REQUEST',
            'GitHub authentication required for this repository'
          );
        }

        const kiloSessionId = crypto.randomUUID();
        const normalizedModel = normalizeKilocodeModel(request.model);
        if (!normalizedModel) {
          return this.buildStartError('BAD_REQUEST', 'No model specified');
        }

        const sandboxId = await generateSandboxId(
          this.env.PER_SESSION_SANDBOX_ORG_IDS,
          request.orgId,
          request.userId,
          sessionId,
          request.botId
        );

        const prepareResult = await this.prepare({
          sessionId,
          userId: request.userId,
          orgId: request.orgId,
          kiloSessionId,
          prompt: request.prompt,
          mode: request.mode,
          model: normalizedModel,
          variant: request.variant,
          kilocodeToken: request.authToken,
          githubRepo: request.githubRepo,
          githubToken: request.githubToken,
          gitUrl: request.gitUrl,
          gitToken: request.gitToken,
          envVars: request.envVars,
          encryptedSecrets: request.encryptedSecrets,
          setupCommands: request.setupCommands,
          mcpServers: request.mcpServers,
          autoCommit: request.autoCommit,
          upstreamBranch: request.upstreamBranch,
          sandboxId,
        });

        if (!prepareResult.success) {
          return this.buildStartError(
            'INTERNAL',
            prepareResult.error ?? 'Failed to prepare session'
          );
        }

        // Transition to initiated state
        const initiateResult = await this.tryInitiate();
        if (
          !initiateResult.success &&
          initiateResult.error !== 'Session has already been initiated'
        ) {
          return this.buildStartError(
            'INTERNAL',
            initiateResult.error ?? 'Failed to initiate session'
          );
        }
        const initContext: InitializeContext = {
          kilocodeToken: request.authToken,
          kilocodeModel: request.model,
          githubRepo: request.githubRepo,
          githubToken: request.githubToken,
          gitUrl: request.gitUrl,
          gitToken: request.gitToken,
          envVars: request.envVars,
          encryptedSecrets: request.encryptedSecrets,
          setupCommands: request.setupCommands,
          mcpServers: request.mcpServers,
          upstreamBranch: request.upstreamBranch,
          botId: request.botId,
          platform: request.platform,
          createdOnPlatform: request.createdOnPlatform,
        };

        const plan = this.buildExecutionPlan({
          executionId,
          sandboxId,
          sessionId,
          userId: request.userId,
          orgId: request.orgId,
          mode: request.mode,
          prompt: request.prompt,
          model: normalizedModel,
          variant: request.variant,
          autoCommit: request.autoCommit,
          condenseOnComplete: request.condenseOnComplete,
          initContext,
          kiloSessionId,
        });

        return await this.executeDirectly(plan);
      }

      if (request.kind === 'initiatePrepared') {
        const metadata = await this.getMetadata();
        if (!metadata) {
          return this.buildStartError('NOT_FOUND', 'Session not found');
        }
        if (!metadata.preparedAt) {
          return this.buildStartError('BAD_REQUEST', 'Session has not been prepared');
        }
        if (metadata.initiatedAt) {
          return this.buildStartError('BAD_REQUEST', 'Session has already been initiated');
        }
        if (!metadata.prompt || !metadata.mode || !metadata.model) {
          return this.buildStartError(
            'BAD_REQUEST',
            'Session is missing required fields (prompt, mode, model)'
          );
        }

        // Transition to initiated state
        const initiateResult = await this.tryInitiate();
        if (
          !initiateResult.success &&
          initiateResult.error !== 'Session has already been initiated'
        ) {
          return this.buildStartError(
            'INTERNAL',
            initiateResult.error ?? 'Failed to initiate session'
          );
        }

        const token = request.authToken || metadata.kilocodeToken || '';
        let githubToken = metadata.githubToken;
        if (metadata.githubInstallationId) {
          const appType = metadata.githubAppType || 'standard';
          githubToken = await this.env.GIT_TOKEN_SERVICE.getToken(
            metadata.githubInstallationId,
            appType
          );
        }
        if (metadata.githubRepo && !githubToken) {
          return this.buildStartError(
            'BAD_REQUEST',
            'GitHub authentication required for this repository'
          );
        }

        const gitToken = await this.refreshManagedGitLabToken(metadata, metadata.gitToken);

        const sandboxId =
          metadata.sandboxId ??
          (await generateSandboxId(
            this.env.PER_SESSION_SANDBOX_ORG_IDS,
            metadata.orgId,
            metadata.userId,
            metadata.sessionId,
            metadata.botId
          ));
        const initContext: InitializeContext = {
          kilocodeToken: token,
          kilocodeModel: metadata.model,
          githubRepo: metadata.githubRepo,
          githubToken,
          gitUrl: metadata.gitUrl,
          gitToken,
          envVars: metadata.envVars,
          encryptedSecrets: metadata.encryptedSecrets,
          setupCommands: metadata.setupCommands,
          mcpServers: metadata.mcpServers,
          upstreamBranch: metadata.upstreamBranch,
          botId: request.botId,
          kiloSessionId: metadata.kiloSessionId,
          isPreparedSession: true,
          githubAppType: metadata.githubAppType,
          platform: metadata.platform,
          createdOnPlatform: metadata.createdOnPlatform,
        };

        const plan = this.buildExecutionPlan({
          executionId,
          sandboxId,
          sessionId,
          userId: metadata.userId as UserId,
          orgId: metadata.orgId,
          mode: metadata.mode as ExecutionMode,
          prompt: metadata.prompt,
          model: metadata.model,
          variant: metadata.variant,
          autoCommit: metadata.autoCommit,
          condenseOnComplete: metadata.condenseOnComplete,
          messageId: metadata.initialMessageId,
          images: metadata.images,
          initContext,
          existingMetadata: metadata,
          kiloSessionId: metadata.kiloSessionId,
        });

        return await this.executeDirectly(plan);
      }

      // Follow-up message (kind === 'followup')
      const metadata = await this.getMetadata();
      if (!metadata) {
        return this.buildStartError('NOT_FOUND', 'Session not found');
      }
      if (!metadata.initiatedAt) {
        return this.buildStartError('BAD_REQUEST', 'Session has not been initiated yet');
      }

      if (request.tokenOverrides?.githubToken && metadata.githubRepo) {
        await this.updateGithubToken(request.tokenOverrides.githubToken);
        metadata.githubToken = request.tokenOverrides.githubToken;
      }
      if (request.tokenOverrides?.gitToken && metadata.gitUrl) {
        await this.updateGitToken(request.tokenOverrides.gitToken);
        metadata.gitToken = request.tokenOverrides.gitToken;
      }
      const mode = (request.mode ?? metadata.mode ?? 'code') as ExecutionMode;
      const model = normalizeKilocodeModel(request.model ?? metadata.model);
      const variant = request.variant ?? metadata.variant;
      if (!model) {
        return this.buildStartError(
          'BAD_REQUEST',
          'No model specified and session has no default model'
        );
      }

      // Token overrides win: only generate from installation ID if no override provided
      let githubToken = request.tokenOverrides?.githubToken ?? metadata.githubToken;
      if (!request.tokenOverrides?.githubToken && metadata.githubInstallationId) {
        const appType = metadata.githubAppType || 'standard';
        githubToken = await this.env.GIT_TOKEN_SERVICE.getToken(
          metadata.githubInstallationId,
          appType
        );
      }
      if (metadata.githubRepo && !githubToken) {
        return this.buildStartError(
          'BAD_REQUEST',
          'GitHub authentication required for this repository'
        );
      }

      // Refresh GitLab token if auto-managed (override wins when provided)
      const overrideGitToken = request.tokenOverrides?.gitToken;
      const gitToken = overrideGitToken
        ? overrideGitToken
        : await this.refreshManagedGitLabToken(metadata, metadata.gitToken);

      const sandboxId =
        metadata.sandboxId ??
        (await generateSandboxId(
          this.env.PER_SESSION_SANDBOX_ORG_IDS,
          metadata.orgId,
          metadata.userId,
          metadata.sessionId,
          metadata.botId
        ));
      const resumeContext: TokenResumeContext = {
        kilocodeToken: metadata.kilocodeToken ?? '',
        kilocodeModel: model,
        githubToken,
        gitToken,
      };

      const plan = this.buildExecutionPlan({
        executionId,
        sandboxId,
        sessionId,
        userId: metadata.userId as UserId,
        orgId: metadata.orgId,
        mode,
        prompt: request.prompt,
        model,
        variant,
        autoCommit: request.autoCommit ?? metadata.autoCommit,
        condenseOnComplete: request.condenseOnComplete ?? metadata.condenseOnComplete,
        messageId: request.messageId,
        images: request.images,
        resumeContext,
        existingMetadata: metadata,
        kiloSessionId: metadata.kiloSessionId,
      });

      // Suppress failure callback for followup executions: the caller
      // (orchestrator) receives the error synchronously via the tRPC
      // response and has its own fallback logic.  Enqueuing a callback
      // here would race with the fallback session's callbacks and
      // corrupt the new review's state (see PLAN-callback-race-fix.md).
      return await this.executeDirectly(plan, { suppressCallbackOnError: true });
    } catch (error) {
      // Handle ExecutionError specifically for proper error code mapping
      if (isExecutionError(error)) {
        if (error.code === 'EXECUTION_IN_PROGRESS') {
          return this.buildStartError(
            'EXECUTION_IN_PROGRESS',
            error.message,
            error.activeExecutionId as ExecutionId
          );
        }
        // Retryable errors pass through specific code -> 503 in tRPC handler
        if (error.retryable) {
          // error.code is a RetryableErrorCode which matches RetryableResultCode
          return this.buildStartError(
            error.code as Extract<StartExecutionV2Result, { success: false }>['code'],
            error.message
          );
        }
        return this.buildStartError('INTERNAL', error.message);
      }
      if (error instanceof TRPCError) {
        return this.buildStartError(mapTRPCCodeToResultCode(error.code), error.message);
      }
      return this.buildStartError(
        'INTERNAL',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Execute a plan directly using the orchestrator.
   * This replaces the queue-based enqueueExecution pattern.
   *
   * @param suppressCallbackOnError — when true, a pre-start failure (e.g.
   *   workspace restore) will NOT enqueue a callback notification.  The caller
   *   is expected to handle the error synchronously (used by the followup path
   *   where the orchestrator falls back to a fresh session on failure).
   */
  private async executeDirectly(
    plan: ExecutionPlan,
    opts?: { suppressCallbackOnError?: boolean }
  ): Promise<StartExecutionV2Result> {
    const { executionId, sessionId, mode } = plan;

    logger.withFields({ sessionId, executionId }).info('executeDirectly called');

    // Add execution metadata to the DO
    const ingestToken = executionId;
    const addResult = await this.executionQueries.add({
      executionId,
      mode,
      streamingMode: 'websocket',
      ingestToken,
    });

    if (!addResult.ok) {
      logger
        .withFields({ sessionId, executionId, error: addResult.error })
        .warn('Failed to add execution (may already exist)');
    }

    // Set this as the active execution
    const setActiveResult = await this.executionQueries.setActiveExecution(executionId);
    if (!setActiveResult.ok) {
      logger
        .withFields({ sessionId, executionId, error: setActiveResult.error })
        .error('Failed to set active execution');
      return this.buildStartError('INTERNAL', 'Failed to set active execution');
    }

    // Reschedule the alarm to the active interval — the idle alarm may be up
    // to an hour away, but we need the reaper checking every 2 min while an
    // execution is running (stale detection, hung execution, max runtime, etc.).
    await this.ctx.storage.setAlarm(Date.now() + REAPER_ACTIVE_INTERVAL_MS);

    // Execute via orchestrator
    try {
      const orchestrator = this.getOrCreateOrchestrator();

      const emitProgress = (step: string, message: string) => {
        const now = Date.now();
        this.broadcastVolatileEvent({
          executionId,
          sessionId,
          streamEventType: 'preparing',
          payload: JSON.stringify({ step, message }),
          timestamp: now,
        });
        // cloud.status mirrors the preparation step
        this.broadcastVolatileEvent({
          executionId,
          sessionId,
          streamEventType: 'cloud.status',
          payload: JSON.stringify({
            cloudStatus: { type: 'preparing' as const, step, message },
          }),
          timestamp: now,
        });
      };

      const result = await orchestrator.execute(plan, { onProgress: emitProgress });

      // Emit cloud.status = ready after successful execution start
      this.broadcastVolatileEvent({
        executionId,
        sessionId,
        streamEventType: 'cloud.status',
        payload: JSON.stringify({ cloudStatus: { type: 'ready' } }),
        timestamp: Date.now(),
      });

      logger
        .withFields({ sessionId, executionId, kiloSessionId: result.kiloSessionId })
        .info('Execution started successfully');

      return this.buildStartResult(executionId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      try {
        this.broadcastVolatileEvent({
          executionId,
          sessionId,
          streamEventType: 'cloud.status',
          payload: JSON.stringify({ cloudStatus: { type: 'error', message: errorMessage } }),
          timestamp: Date.now(),
        });
      } catch {
        // Best-effort — must not prevent failExecution from running.
      }

      try {
        await this.failExecution({
          executionId,
          status: 'failed',
          error: errorMessage,
          streamEventType: 'error',
          suppressCallback: opts?.suppressCallbackOnError,
        });
      } catch (failError) {
        // failExecution itself threw — force-clear the active execution as a
        // last-resort safety net so the session is not permanently locked.
        logger
          .withFields({ sessionId, executionId, error: String(failError) })
          .error(
            'failExecution threw during executeDirectly cleanup — force-clearing active execution'
          );
        try {
          await this.executionQueries.clearActiveExecution();
        } catch {
          // Storage write failed — the reaper alarm will catch this.
        }
      }

      throw error;
    }
  }

  /**
   * Called when an execution completes (successfully, failed, or interrupted).
   *
   * Updates the execution status and clears the active execution.
   * With direct execution model, there's no queue to advance.
   *
   * @param executionId - ID of the completed execution
   * @param status - Final status of the execution
   * @param error - Optional error message for failed executions
   */
  async onExecutionComplete(
    executionId: ExecutionId,
    status: 'completed' | 'failed' | 'interrupted',
    error?: string
  ): Promise<void> {
    const sessionId = await this.resolveSessionId();
    logger.withFields({ sessionId, executionId, status, error }).info('onExecutionComplete called');

    // Snapshot active execution before updateStatus clears it — we need this to
    // decide whether to clean up the interrupt flag afterward.
    const wasActive = (await this.executionQueries.getActiveExecutionId()) === executionId;

    // Update execution status
    const updateResult = await this.updateExecutionStatus({
      executionId,
      status,
      error,
      completedAt: Date.now(),
    });

    if (!updateResult.ok) {
      logger
        .withFields({ sessionId, executionId, error: updateResult.error })
        .warn('Failed to update execution status');
    }

    // Clear active execution + interrupt only if this was the active execution.
    // updateStatus already clears active_execution_id internally when it matches,
    // so the clear here is a safety net. We skip both clears when this execution
    // wasn't active to avoid clobbering a newer execution that started in between.
    if (wasActive) {
      const activeExecutionId = await this.executionQueries.getActiveExecutionId();
      if (activeExecutionId === executionId) {
        await this.executionQueries.clearActiveExecution();
      }
      await this.executionQueries.clearInterrupt();
    }

    logger.withFields({ sessionId, executionId }).info('Execution complete - session is idle');
  }
}
