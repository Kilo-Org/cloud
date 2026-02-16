/**
 * SQLite-backed Durable Object for cloud agent session metadata.
 * Automatically cleans up after 90 days of inactivity.
 * Uses RPC methods for type-safe communication.
 */

import { DurableObject } from 'cloudflare:workers';
import { TRPCError } from '@trpc/server';
import type { CloudAgentSessionState, OperationResult, MCPServerConfig } from './types.js';
import { MetadataSchema, type Images } from './schemas.js';
import type { EncryptedSecrets } from '../router/schemas.js';
import type { CallbackJob, CallbackTarget } from '../callbacks/index.js';
import { logger } from '../logger.js';
import { Limits } from '../schema.js';
import { runMigrations } from './migrations.js';
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
import type { ExecutionId, SessionId, UserId } from '../types/ids.js';
import type {
  ExecutionMetadata,
  AddExecutionParams,
  UpdateExecutionStatusParams,
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
import type { WrapperCommand } from '../shared/protocol.js';
import { STALE_THRESHOLD_MS } from '../core/lease.js';
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
import type { Env as WorkerEnv } from '../types.js';
import { generateSandboxId } from '../sandbox-id.js';

import { GitHubTokenService } from '../services/github-token-service.js';
import { validateStreamTicket } from '../auth.js';
import { getSandbox } from '@cloudflare/sandbox';
import { stopKiloServer } from '../kilo/server-manager.js';

// ---------------------------------------------------------------------------
// Alarm Constants
// ---------------------------------------------------------------------------

/** Reaper alarm interval: 5 minutes */
const REAPER_INTERVAL_MS_DEFAULT = 5 * 60 * 1000;
const PENDING_START_TIMEOUT_MS_DEFAULT = 5 * 60 * 1000;

/** Event retention period: 90 days (aligns with session TTL) */
const EVENT_RETENTION_MS = Limits.SESSION_TTL_MS;

/** Storage key for tracking last activity timestamp */
const LAST_ACTIVITY_KEY = 'last_activity';

/** Kilo server idle timeout: 15 minutes */
const KILO_SERVER_IDLE_TIMEOUT_MS_DEFAULT = 15 * 60 * 1000;

export class CloudAgentSession extends DurableObject {
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
    error?: string
  ): Promise<void> {
    const metadata = await this.getMetadata();
    const callbackQueue = (this.env as unknown as WorkerEnv).CALLBACK_QUEUE;

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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Extract sessionId from DO name pattern: "userId:sessionId"
    // The DO name is set by the worker when creating the stub
    const doName = ctx.id.name;
    const sessionIdPart = doName?.split(':')[1];
    this.sessionId = sessionIdPart ? (sessionIdPart as SessionId) : undefined;

    // Initialize query modules with storage
    this.executionQueries = createExecutionQueries(ctx.storage);
    this.eventQueries = createEventQueries(ctx.storage.sql);
    this.leaseQueries = createLeaseQueries(ctx.storage.sql);

    // Run schema migrations on first access to this DO instance.
    // blockConcurrencyWhile blocks all concurrent requests until completed,
    // ensuring migrations complete before any handlers execute.
    // Also ensures reaper alarm is scheduled.
    void ctx.blockConcurrencyWhile(async () => {
      await runMigrations(ctx);
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
      this.streamHandler = createStreamHandler(this.ctx, this.eventQueries, sessionId);
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
        linkKiloSessionInBackend: (id: string) => this.linkKiloSessionInBackend(id),
        updateUpstreamBranch: (branch: string) => this.updateUpstreamBranch(branch),
        clearActiveExecution: () => this.clearActiveExecution(),
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
        },
        updateExecutionStatus: async (
          executionId: string,
          status: 'completed' | 'failed' | 'interrupted',
          error?: string
        ) => {
          await this.updateExecutionStatus({
            executionId: executionId as ExecutionId,
            status,
            error,
            completedAt: Date.now(),
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
      return streamHandler.handleStreamRequest(request);
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
      ingestHandler.handleIngestClose(ws);
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

  /**
   * Link the kiloSessionId to the backend for analytics/tracking.
   * Called when a session_created event is received from the CLI.
   *
   * @param kiloSessionId - The kilo CLI session ID to link
   */
  async linkKiloSessionInBackend(kiloSessionId: string): Promise<void> {
    const metadata = await this.getMetadata();
    if (!metadata?.kilocodeToken) {
      throw new Error('Cannot link session: missing kilocodeToken');
    }

    const backendUrl = (this.env as unknown as WorkerEnv).KILOCODE_BACKEND_BASE_URL;
    if (!backendUrl) {
      throw new Error('Cannot link session: KILOCODE_BACKEND_BASE_URL not configured');
    }

    const response = await fetch(`${backendUrl}/api/cloud-sessions/linkSessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${metadata.kilocodeToken}`,
      },
      body: JSON.stringify({
        cloudSessionId: this.sessionId,
        kiloSessionId: kiloSessionId,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Backend link failed: ${response.status} ${text}`);
    }
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
    kilocodeToken?: string;
    githubRepo?: string;
    githubToken?: string;
    githubInstallationId?: string;
    githubAppType?: 'standard' | 'lite';
    gitUrl?: string;
    gitToken?: string;
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
    // Workspace metadata (set during prepareSession)
    workspacePath?: string;
    sessionHome?: string;
    branchName?: string;
    sandboxId?: string;
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
   * Atomically update a prepared session - only succeeds if prepared but not initiated.
   * Single DO request ensures atomicity.
   * Validates updated metadata against MetadataSchema before storing.
   */
  async tryUpdate(updates: {
    mode?: string | null;
    model?: string | null;
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
    if (metadata.initiatedAt) {
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

      // Run cleanup tasks
      await this.cleanupStaleExecutions(now);
      this.cleanupOldEvents(now);
      this.cleanupExpiredLeases(now);

      // Check if kilo server should be stopped due to inactivity
      await this.cleanupIdleKiloServer(now);
    } catch (error) {
      logger
        .withFields({
          doId: this.ctx.id.toString(),
          sessionId: this.sessionId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        })
        .error('Error during alarm reaper');
    }

    // Schedule next alarm run
    await this.ctx.storage.setAlarm(now + this.getReaperIntervalMs());
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

        // Mark as failed
        await this.updateExecutionStatus({
          executionId: activeExecutionId,
          status: 'failed',
          error: 'Execution timeout - no heartbeat received',
          completedAt: now,
        });

        // Clear active execution (updateStatus should do this, but ensure it)
        await this.executionQueries.clearActiveExecution();

        // Clear interrupt flag if set
        await this.executionQueries.clearInterrupt();
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

        await this.updateExecutionStatus({
          executionId: activeExecutionId,
          status: 'failed',
          error: 'Execution timeout - wrapper never connected',
          completedAt: now,
        });

        await this.executionQueries.clearActiveExecution();
        await this.executionQueries.clearInterrupt();
      }
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

  private getReaperIntervalMs(): number {
    const value = Number((this.env as unknown as WorkerEnv).REAPER_INTERVAL_MS);
    return Number.isFinite(value) && value > 0 ? value : REAPER_INTERVAL_MS_DEFAULT;
  }

  private getStaleThresholdMs(): number {
    const value = Number((this.env as unknown as WorkerEnv).STALE_THRESHOLD_MS);
    return Number.isFinite(value) && value > 0 ? value : STALE_THRESHOLD_MS;
  }

  private getPendingStartTimeoutMs(): number {
    const value = Number((this.env as unknown as WorkerEnv).PENDING_START_TIMEOUT_MS);
    return Number.isFinite(value) && value > 0 ? value : PENDING_START_TIMEOUT_MS_DEFAULT;
  }

  private getKiloServerIdleTimeoutMs(): number {
    const value = Number((this.env as unknown as WorkerEnv).KILO_SERVER_IDLE_TIMEOUT_MS);
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
      const sandboxId = await generateSandboxId(metadata.orgId, metadata.userId, metadata.botId);
      const sandbox = getSandbox((this.env as unknown as WorkerEnv).Sandbox, sandboxId);

      await stopKiloServer(sandbox, metadata.sessionId);

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
   */
  async updateExecutionStatus(
    params: UpdateExecutionStatusParams
  ): Promise<Result<ExecutionMetadata, UpdateStatusError>> {
    const result = await this.executionQueries.updateStatus(params);

    if (result.ok && this.isTerminalStatus(params.status)) {
      await this.enqueueCallbackNotification(params.executionId, params.status, params.error);
    }

    return result;
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
    autoCommit?: boolean;
    condenseOnComplete?: boolean;
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
        autoCommit: params.autoCommit,
        condenseOnComplete: params.condenseOnComplete,
      },
    };
  }

  /**
   * Get or create the execution orchestrator.
   */
  private getOrCreateOrchestrator(): ExecutionOrchestrator {
    if (!this.orchestrator) {
      const deps: OrchestratorDeps = {
        getSandbox: async (sandboxId: string) =>
          getSandbox((this.env as unknown as WorkerEnv).Sandbox, sandboxId, { sleepAfter: 900 }),
        getSessionStub: (userId, sessionId) => {
          const doKey = `${userId}:${sessionId}`;
          const id = (this.env as unknown as WorkerEnv).CLOUD_AGENT_SESSION.idFromName(doKey);
          return (this.env as unknown as WorkerEnv).CLOUD_AGENT_SESSION.get(id);
        },
        getIngestUrl: (sessionId, userId) => {
          const workerUrl =
            (this.env as unknown as WorkerEnv).WORKER_URL || 'http://localhost:8788';
          // Encode userId to handle OAuth IDs like "oauth/google:123" that contain slashes
          return `${workerUrl}/sessions/${encodeURIComponent(userId)}/${sessionId}/ingest`;
        },
        env: this.env as unknown as WorkerEnv,
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

  private getGitHubTokenService(): GitHubTokenService {
    return new GitHubTokenService({
      GITHUB_TOKEN_CACHE: Reflect.get(this.env, 'GITHUB_TOKEN_CACHE'),
      GITHUB_APP_ID: Reflect.get(this.env, 'GITHUB_APP_ID'),
      GITHUB_APP_PRIVATE_KEY: Reflect.get(this.env, 'GITHUB_APP_PRIVATE_KEY'),
      GITHUB_LITE_APP_ID: Reflect.get(this.env, 'GITHUB_LITE_APP_ID'),
      GITHUB_LITE_APP_PRIVATE_KEY: Reflect.get(this.env, 'GITHUB_LITE_APP_PRIVATE_KEY'),
    });
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

        const prepareResult = await this.prepare({
          sessionId,
          userId: request.userId,
          orgId: request.orgId,
          kiloSessionId,
          prompt: request.prompt,
          mode: request.mode,
          model: normalizedModel,
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

        const sandboxId = await generateSandboxId(request.orgId, request.userId, request.botId);
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
          githubToken = await this.getGitHubTokenService().getToken(
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

        const sandboxId = await generateSandboxId(metadata.orgId, metadata.userId, request.botId);
        const initContext: InitializeContext = {
          kilocodeToken: token,
          kilocodeModel: metadata.model,
          githubRepo: metadata.githubRepo,
          githubToken,
          gitUrl: metadata.gitUrl,
          gitToken: metadata.gitToken,
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
          autoCommit: metadata.autoCommit,
          condenseOnComplete: metadata.condenseOnComplete,
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

      const mode = (request.mode ?? metadata.mode ?? 'build') as ExecutionMode;
      const model = normalizeKilocodeModel(request.model ?? metadata.model);
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
        githubToken = await this.getGitHubTokenService().getToken(
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

      const sandboxId = await generateSandboxId(metadata.orgId, metadata.userId, request.botId);
      const resumeContext: TokenResumeContext = {
        kilocodeToken: metadata.kilocodeToken ?? '',
        kilocodeModel: model,
        githubToken,
        gitToken: request.tokenOverrides?.gitToken,
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
        autoCommit: request.autoCommit ?? metadata.autoCommit,
        condenseOnComplete: request.condenseOnComplete ?? metadata.condenseOnComplete,
        resumeContext,
        existingMetadata: metadata,
        kiloSessionId: metadata.kiloSessionId,
      });

      return await this.executeDirectly(plan);
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
   */
  private async executeDirectly(plan: ExecutionPlan): Promise<StartExecutionV2Result> {
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

    // Execute via orchestrator
    try {
      const orchestrator = this.getOrCreateOrchestrator();
      const result = await orchestrator.execute(plan);

      logger
        .withFields({ sessionId, executionId, kiloSessionId: result.kiloSessionId })
        .info('Execution started successfully');

      return this.buildStartResult(executionId);
    } catch (error) {
      // Execution failed - clear active execution
      await this.executionQueries.clearActiveExecution();

      // Mark execution as failed
      await this.executionQueries.updateStatus({
        executionId,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        completedAt: Date.now(),
      });

      throw error; // Re-throw for caller handling
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

    // Check if this was the active execution
    const activeExecutionId = await this.executionQueries.getActiveExecutionId();
    if (activeExecutionId === executionId) {
      // Clear the active execution
      await this.executionQueries.clearActiveExecution();
    }

    // Clear any interrupt flag that may have been set
    await this.executionQueries.clearInterrupt();

    logger.withFields({ sessionId, executionId }).info('Execution complete - session is idle');
  }
}
