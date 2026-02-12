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
import {
  createExecutionQueries,
  createEventQueries,
  createLeaseQueries,
  createCommandQueueQueries,
  type ExecutionQueries,
  type EventQueries,
  type LeaseQueries,
  type LeaseAcquireError,
  type CommandQueueQueries,
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
import type {
  ExecutionMessage,
  ExecutionMode,
  StartExecutionV2Request,
  StartExecutionV2Result,
  WrapperLaunchPlan,
  InitializeContext,
  ResumeContext,
} from '../queue/types.js';
import type { Env as WorkerEnv } from '../types.js';
import { generateSandboxId } from '../sandbox-id.js';
import { buildWrapperArgs, buildWrapperEnvBase } from '../queue/wrapper-plan.js';
import { GitHubTokenService } from '../services/github-token-service.js';
import { validateStreamTicket } from '../auth.js';

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

export class CloudAgentSession extends DurableObject {
  private executionQueries: ExecutionQueries;
  private eventQueries: EventQueries;
  private leaseQueries: LeaseQueries;
  private commandQueueQueries: CommandQueueQueries;
  private streamHandler?: StreamHandler;
  private ingestHandler?: IngestHandler;
  private streamHandlerSessionId?: SessionId;
  private ingestHandlerSessionId?: SessionId;
  private sessionId?: SessionId;

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
    this.commandQueueQueries = createCommandQueueQueries(ctx.storage.sql);

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
        maybeStartNextExecution: () => this.maybeStartNextExecution(),
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
   * Try to start the next queued execution.
   * Public wrapper around tryAdvanceQueueInternal for use by ingest handlers.
   */
  async maybeStartNextExecution(): Promise<void> {
    await this.tryAdvanceQueueInternal();
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
    platform?: 'github' | 'gitlab';
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

      // Try to advance queue if no active execution but queue has items
      await this.tryAdvanceQueue();
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

  /**
   * Purge expired queue entries and mark their executions as failed.
   * Returns the number of entries purged.
   */
  private async purgeExpiredQueueEntries(): Promise<number> {
    const QUEUE_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
    const now = Date.now();
    let purgedCount = 0;
    const sessionId = await this.resolveSessionId();
    if (!sessionId) {
      return 0;
    }

    // Loop through and purge expired entries
    let nextCommand = this.commandQueueQueries.peekOldest(sessionId);
    while (nextCommand && now - nextCommand.created_at > QUEUE_EXPIRY_MS) {
      const expiredMessage = JSON.parse(nextCommand.message_json) as ExecutionMessage;
      const expiredExecutionId = expiredMessage.executionId;

      logger
        .withFields({
          sessionId,
          executionId: expiredExecutionId,
          age: now - nextCommand.created_at,
        })
        .info('Purging expired queue entry');

      // Mark the execution as failed due to expiry
      await this.updateExecutionStatus({
        executionId: expiredExecutionId,
        status: 'failed',
        error: 'queue_expired',
        completedAt: now,
      });

      // Remove from queue
      this.commandQueueQueries.dequeueById(nextCommand.id);
      purgedCount++;

      // Check next entry
      nextCommand = this.commandQueueQueries.peekOldest(sessionId);
    }

    return purgedCount;
  }

  /**
   * Internal method to advance the queue - sends the oldest valid command if no active execution.
   * Used by both enqueueExecution and alarm reaper.
   * Returns info about what was sent, or null if nothing was sent.
   *
   * CRITICAL: Uses blockConcurrencyWhile to prevent re-entrancy during await EXECUTION_QUEUE.send().
   * Without this, another request could enter while we're awaiting send, see active=null, and
   * dispatch the same or next command again, breaking FIFO and causing duplicate executions.
   */
  private async tryAdvanceQueueInternal(): Promise<{ executionId: ExecutionId } | null> {
    const QUEUE_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
    const now = Date.now();
    const sessionId = await this.resolveSessionId();
    if (!sessionId) {
      return null;
    }

    // Loop to find a valid (non-expired) command
    // This purging can happen outside blockConcurrencyWhile since it's idempotent
    let nextCommand = this.commandQueueQueries.peekOldest(sessionId);

    while (nextCommand) {
      // Check if command is expired
      if (now - nextCommand.created_at > QUEUE_EXPIRY_MS) {
        const expiredMessage = JSON.parse(nextCommand.message_json) as ExecutionMessage;
        const expiredExecutionId = expiredMessage.executionId;

        logger
          .withFields({
            sessionId,
            executionId: expiredExecutionId,
            age: now - nextCommand.created_at,
          })
          .info('Queue command expired - marking as failed');

        // Mark the execution as failed due to expiry
        await this.updateExecutionStatus({
          executionId: expiredExecutionId,
          status: 'failed',
          error: 'queue_expired',
          completedAt: now,
        });

        // Remove from queue
        this.commandQueueQueries.dequeueById(nextCommand.id);

        // Try the next command
        nextCommand = this.commandQueueQueries.peekOldest(sessionId);
        continue;
      }

      // Found a valid, non-expired command
      break;
    }

    if (!nextCommand) {
      return null;
    }

    // Use blockConcurrencyWhile for atomic dispatch
    // This prevents another request from entering during the await on EXECUTION_QUEUE.send()
    return await this.ctx.blockConcurrencyWhile(async () => {
      // Double-check active execution hasn't changed while we were purging expired
      const activeExecutionId = await this.executionQueries.getActiveExecutionId();
      if (activeExecutionId !== null) {
        return null; // Another request took over
      }

      const nextMessage = JSON.parse(nextCommand.message_json) as ExecutionMessage;
      const nextExecutionId = nextMessage.executionId;

      logger
        .withFields({ sessionId, executionId: nextExecutionId })
        .info('Attempting to advance queue (atomically)');

      // Set active FIRST (optimistic lock)
      // If send fails, we'll clear it below
      const setActiveResult = await this.executionQueries.setActiveExecution(nextExecutionId);
      if (!setActiveResult.ok) {
        logger
          .withFields({
            sessionId,
            executionId: nextExecutionId,
            error: setActiveResult.error,
          })
          .error('Failed to set active execution');
        return null;
      }

      // Try to send to queue
      try {
        await (this.env as unknown as WorkerEnv).EXECUTION_QUEUE.send(nextMessage);
      } catch (error) {
        // Send failed - clear active and leave in queue for retry
        await this.executionQueries.clearActiveExecution();
        logger
          .withFields({
            sessionId,
            executionId: nextExecutionId,
            error: error instanceof Error ? error.message : String(error),
          })
          .error('Failed to send queued command - cleared active, will retry later');
        return null;
      }

      // Successfully sent - now dequeue
      // Order matters: we keep the queue entry until send succeeds
      this.commandQueueQueries.dequeueById(nextCommand.id);

      logger
        .withFields({ sessionId, executionId: nextExecutionId })
        .info('Successfully advanced queue');

      return { executionId: nextExecutionId };
    });
  }

  /**
   * Try to advance the queue if no active execution but queue has items.
   * This handles the case where onExecutionComplete failed to send the next command.
   * Called by the alarm reaper.
   */
  private async tryAdvanceQueue(): Promise<void> {
    await this.tryAdvanceQueueInternal();
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
  // Command Queue RPC Methods
  // ---------------------------------------------------------------------------

  private buildLaunchPlan(params: {
    executionId: ExecutionId;
    sandboxId: string;
    sessionId: SessionId;
    userId: string;
    orgId?: string;
    mode: string;
    autoCommit?: boolean;
    condenseOnComplete?: boolean;
    appendSystemPrompt?: string;
    promptFile: string;
    initContext?: InitializeContext;
    resumeContext?: ResumeContext;
    existingMetadata?: CloudAgentSessionState;
    kilocodeToken?: string;
    kiloSessionId?: string;
    upstreamBranch?: string;
  }): WrapperLaunchPlan {
    // Generate file path for appendSystemPrompt if provided (avoids command injection)
    const appendSystemPromptFile = params.appendSystemPrompt
      ? `/tmp/append-system-prompt-${params.executionId}.txt`
      : undefined;

    const wrapperArgs = buildWrapperArgs({
      executionId: params.executionId,
      mode: params.mode,
      promptFile: params.promptFile,
      autoCommit: params.autoCommit,
      condenseOnComplete: params.condenseOnComplete,
      idleTimeoutMs: this.getWrapperIdleTimeoutMs(),
      appendSystemPromptFile,
    });
    const wrapperEnv = buildWrapperEnvBase({
      sessionId: params.sessionId,
      userId: params.userId,
      orgId: params.orgId,
      kilocodeToken: params.kilocodeToken,
      kiloSessionId: params.kiloSessionId,
      upstreamBranch: params.upstreamBranch,
    });

    return {
      executionId: params.executionId,
      sandboxId: params.sandboxId,
      promptFile: params.promptFile,
      appendSystemPromptFile,
      workspace: {
        shouldPrepare: Boolean(params.initContext),
        initContext: params.initContext,
        resumeContext: params.resumeContext,
        existingMetadata: params.existingMetadata,
      },
      wrapper: {
        args: wrapperArgs,
        env: wrapperEnv,
      },
    };
  }

  private getWrapperIdleTimeoutMs(): number | undefined {
    const value = Number((this.env as unknown as WorkerEnv).WRAPPER_IDLE_TIMEOUT_MS);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }

  private buildStartResult(
    executionId: ExecutionId,
    status: 'started' | 'queued'
  ): StartExecutionV2Result {
    return {
      success: true,
      executionId,
      status,
    };
  }

  private buildStartError(
    code: Extract<StartExecutionV2Result, { success: false }>['code'],
    error: string
  ): StartExecutionV2Result {
    return {
      success: false,
      code,
      error,
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
   * Start a V2 execution using DO-orchestrated planning.
   * This method performs validation, applies token overrides, and enqueues the execution.
   */
  async startExecutionV2(request: StartExecutionV2Request): Promise<StartExecutionV2Result> {
    const sessionId = await this.requireSessionId();
    const executionId = createExecutionId();
    const promptFile = `/tmp/prompt-${executionId}.txt`;
    // Maps TRPCError codes to StartExecutionV2Result error codes.
    // Note: BAD_GATEWAY (GitHub API failures) maps to INTERNAL since
    // StartExecutionV2Result doesn't have a BAD_GATEWAY code.
    // Callers should check error message for "GitHub" to distinguish.
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
      if (request.kind === 'initiate') {
        // Validate githubRepo requires authentication
        if (request.githubRepo && !request.githubToken) {
          return this.buildStartError(
            'BAD_REQUEST',
            'GitHub authentication required for this repository'
          );
        }

        const kiloSessionId = crypto.randomUUID();
        const prepareResult = await this.prepare({
          sessionId,
          userId: request.userId,
          orgId: request.orgId,
          kiloSessionId,
          prompt: request.prompt,
          mode: request.mode,
          model: request.model,
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

        const message: ExecutionMessage = {
          executionId,
          sessionId,
          userId: request.userId,
          orgId: request.orgId,
          mode: request.mode,
          prompt: request.prompt,
          sandboxId,
          appendSystemPrompt: request.appendSystemPrompt,
          planVersion: 'v2',
          launchPlan: this.buildLaunchPlan({
            executionId,
            sandboxId,
            sessionId,
            userId: request.userId,
            orgId: request.orgId,
            mode: request.mode,
            autoCommit: request.autoCommit,
            condenseOnComplete: request.condenseOnComplete,
            appendSystemPrompt: request.appendSystemPrompt,
            promptFile,
            initContext,
            kilocodeToken: request.authToken,
            kiloSessionId,
            upstreamBranch: request.upstreamBranch,
          }),
        };

        const enqueueResult = await this.enqueueExecution(message, true);
        return this.buildStartResult(executionId, enqueueResult.status);
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

        const message: ExecutionMessage = {
          executionId,
          sessionId,
          userId: metadata.userId as UserId,
          orgId: metadata.orgId,
          mode: metadata.mode as ExecutionMode,
          prompt: metadata.prompt,
          sandboxId,
          appendSystemPrompt: metadata.appendSystemPrompt,
          planVersion: 'v2',
          launchPlan: this.buildLaunchPlan({
            executionId,
            sandboxId,
            sessionId,
            userId: metadata.userId,
            orgId: metadata.orgId,
            mode: metadata.mode as ExecutionMode,
            autoCommit: metadata.autoCommit,
            condenseOnComplete: metadata.condenseOnComplete,
            appendSystemPrompt: metadata.appendSystemPrompt,
            promptFile,
            initContext,
            existingMetadata: metadata,
            kilocodeToken: token,
            kiloSessionId: metadata.kiloSessionId,
            upstreamBranch: metadata.upstreamBranch,
          }),
        };

        const enqueueResult = await this.enqueueExecution(message, true);
        return this.buildStartResult(executionId, enqueueResult.status);
      }

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
      const model = request.model ?? metadata.model;
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
      const resumeContext: ResumeContext = {
        kilocodeToken: metadata.kilocodeToken ?? '',
        kilocodeModel: model,
        githubToken,
        gitToken: request.tokenOverrides?.gitToken,
      };

      const resolvedAppendSystemPrompt = request.appendSystemPrompt ?? metadata.appendSystemPrompt;
      const message: ExecutionMessage = {
        executionId,
        sessionId,
        userId: metadata.userId as UserId,
        orgId: metadata.orgId,
        mode,
        prompt: request.prompt,
        sandboxId,
        appendSystemPrompt: resolvedAppendSystemPrompt,
        planVersion: 'v2',
        launchPlan: this.buildLaunchPlan({
          executionId,
          sandboxId,
          sessionId,
          userId: metadata.userId,
          orgId: metadata.orgId,
          mode,
          autoCommit: request.autoCommit ?? metadata.autoCommit,
          condenseOnComplete: request.condenseOnComplete ?? metadata.condenseOnComplete,
          appendSystemPrompt: resolvedAppendSystemPrompt,
          promptFile,
          resumeContext,
          existingMetadata: metadata,
          kilocodeToken: metadata.kilocodeToken,
          kiloSessionId: metadata.kiloSessionId,
          upstreamBranch: metadata.upstreamBranch,
        }),
      };

      const enqueueResult = await this.enqueueExecution(message, false);
      return this.buildStartResult(executionId, enqueueResult.status);
    } catch (error) {
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
   * Enqueue an execution for processing.
   *
   * If no execution is currently active, the execution will start immediately.
   * Otherwise, it will be queued and processed when the current execution completes.
   *
   * @param message - The execution message to enqueue (will be sent to EXECUTION_QUEUE)
   * @param isInitialize - Whether this is the first execution (triggers session state transition)
   * @returns Status indicating whether execution started or was queued
   */
  async enqueueExecution(
    message: ExecutionMessage,
    isInitialize: boolean
  ): Promise<{ status: 'started' | 'queued' }> {
    const { executionId, sessionId } = message;

    logger.withFields({ sessionId, executionId, isInitialize }).info('enqueueExecution called');

    const resolvedSessionId = await this.requireSessionId(sessionId);

    // If this is the first execution, transition session state
    if (isInitialize) {
      const initiateResult = await this.tryInitiate();
      if (!initiateResult.success) {
        // Check if this is a "not prepared" error vs "already initiated" (idempotent)
        if (initiateResult.error === 'Session has not been prepared') {
          // This is a real error - session must be prepared first
          logger
            .withFields({ sessionId, error: initiateResult.error })
            .error('Cannot initiate unprepared session');
          throw new Error('Session has not been prepared');
        }
        // 'Session has already been initiated' is acceptable (idempotent)
        logger
          .withFields({ sessionId, error: initiateResult.error })
          .info('Session already initiated - continuing');
      }
    }

    // Purge expired queue entries before checking depth
    // This prevents blocking users with stale commands that will never run
    const expiredCount = await this.purgeExpiredQueueEntries();
    if (expiredCount > 0) {
      logger.withFields({ sessionId, expiredCount }).info('Purged expired commands before enqueue');
    }

    // Check queue depth BEFORE adding execution (enforce max depth of 3 pending)
    // This prevents creating orphaned execution records on rejection
    const currentQueuedCount = this.commandQueueQueries.count(resolvedSessionId);
    const MAX_QUEUE_DEPTH = 3;
    if (currentQueuedCount >= MAX_QUEUE_DEPTH) {
      logger
        .withFields({ sessionId, executionId, queuedCount: currentQueuedCount })
        .warn('Queue is full - rejecting enqueue');
      throw new Error(`Queue is full (max ${MAX_QUEUE_DEPTH} pending commands)`);
    }

    // Add execution metadata to the DO (tracks execution in executions table)
    // Generate ingest token for WebSocket authentication (using executionId as token for now)
    const ingestToken = executionId;
    const addResult = await this.executionQueries.add({
      executionId,
      mode: message.mode,
      streamingMode: 'websocket',
      ingestToken,
    });

    if (!addResult.ok) {
      logger
        .withFields({ sessionId, executionId, error: addResult.error })
        .warn('Failed to add execution (may already exist)');
    }

    // ALWAYS insert into command_queue for strict FIFO ordering
    // This eliminates race conditions where two enqueues both see active=null
    const messageJson = JSON.stringify(message);
    this.commandQueueQueries.enqueue(resolvedSessionId, executionId, messageJson);

    const queuedCount = this.commandQueueQueries.count(resolvedSessionId);

    logger
      .withFields({ sessionId, executionId, queuedCount })
      .info('Execution added to command queue');

    // Try to advance the queue (will send if no active execution)
    const advanced = await this.tryAdvanceQueueInternal();

    if (advanced && advanced.executionId === executionId) {
      // This execution was sent immediately
      logger.withFields({ sessionId, executionId }).info('Execution started immediately');
      return { status: 'started' };
    } else {
      // Execution is queued behind others
      const activeExecutionId = await this.executionQueries.getActiveExecutionId();
      logger
        .withFields({ sessionId, executionId, activeExecutionId, queuedCount })
        .info('Execution queued');
      return { status: 'queued' };
    }
  }

  /**
   * Called when an execution completes (successfully, failed, or interrupted).
   *
   * Updates the execution status, clears the active execution,
   * and dispatches the next queued command if one exists.
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

    // Try to advance the queue (send next command if any)
    const advanced = await this.tryAdvanceQueueInternal();

    if (advanced) {
      const remainingCount = sessionId ? this.commandQueueQueries.count(sessionId) : 0;
      logger
        .withFields({
          sessionId,
          completedExecutionId: executionId,
          nextExecutionId: advanced.executionId,
          remainingCount,
        })
        .info('Started next queued execution');
    } else {
      logger
        .withFields({ sessionId, executionId })
        .info('No more queued commands - session is idle');
    }
  }

  /**
   * Get the count of queued commands for this session.
   *
   * @returns Number of commands waiting in the queue
   */
  getQueuedCount(): number {
    if (!this.sessionId) return 0;
    return this.commandQueueQueries.count(this.sessionId);
  }
}
