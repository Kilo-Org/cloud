/**
 * WrapperState - Single source of truth for wrapper state.
 *
 * All wrapper state is centralized here. Other modules receive a WrapperState
 * instance and interact with it through methods. This makes state transitions
 * explicit, simplifies testing, and prevents scattered state bugs.
 *
 * State model:
 * - IDLE: _isActive == false
 * - ACTIVE: _isActive == true
 */

import type { IngestEvent } from '../../src/shared/protocol.js';
import type { LogUploader } from './log-uploader.js';
export type { LogUploader } from './log-uploader.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JobContext = {
  executionId?: string;
  kiloSessionId: string;
  ingestUrl: string;
  ingestToken: string;
  workerAuthToken: string;
};

export type LastError = {
  code: string;
  messageId?: string;
  message: string;
  timestamp: number;
};

export type WrapperStatus = {
  state: 'idle' | 'active';
  executionId?: string;
  sessionId?: string;
  lastError?: LastError;
};

// ---------------------------------------------------------------------------
// WrapperState Class
// ---------------------------------------------------------------------------

export class WrapperState {
  /** Stable agent session ID (always present, used for message ID generation in supervisor mode) */
  readonly agentSessionId: string;

  // Job context (set on the first turn-start request, cleared on reset or drain)
  private job: JobContext | null = null;

  // Whether the wrapper is actively processing a prompt
  private _isActive = false;

  // Connection state - managed externally, stored here for reference
  private _ingestWs: WebSocket | null = null;
  private _sseAbortController: AbortController | null = null;

  // Activity tracking
  private lastActivityAt = Date.now();
  private _lastError: LastError | null = null;

  // Message counter for ID generation
  private messageCounter = 0;

  // Last root-session assistant message ID (tracked from message.updated kilocode events)
  private _lastAssistantMessageId: string | null = null;

  // Callbacks for sending events to ingest
  private _sendToIngestFn: ((event: IngestEvent) => void) | null = null;

  /** Called when wrapper transitions idle → active. Set externally (e.g. by supervisor). */
  onBecameActive: (() => void) | null = null;

  constructor(agentSessionId: string) {
    this.agentSessionId = agentSessionId;
  }

  // Log uploader (set per-job, cleared on job end)
  private _logUploader: LogUploader | null = null;

  // ---------------------------------------------------------------------------
  // State Queries
  // ---------------------------------------------------------------------------

  get isIdle(): boolean {
    return !this._isActive;
  }

  get isActive(): boolean {
    return this._isActive;
  }

  get hasJob(): boolean {
    return this.job !== null;
  }

  get currentJob(): JobContext | null {
    return this.job;
  }

  // ---------------------------------------------------------------------------
  // Job Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start a new job. Idempotent for same executionId (shared-sandbox mode).
   * In supervisor mode (no executionId), always accepts unless currently active.
   * Throws if a different job is currently active (caller should return 409).
   */
  startJob(context: JobContext): void {
    if (context.executionId && this.job?.executionId === context.executionId) {
      return; // Idempotent: same executionId
    }

    if (this.job && this._isActive) {
      throw new Error(
        context.executionId
          ? `Cannot start new job while active (current: ${this.job.executionId})`
          : 'Cannot start new job while active'
      );
    }

    this.job = context;
    this._lastError = null;
    // In supervisor mode (no executionId), keep the counter monotonic across turns
    if (context.executionId) {
      this.messageCounter = 0;
    }
    this.updateActivity();
  }

  /**
   * Clear job context. Called on explicit reset or when draining.
   */
  clearJob(): void {
    this._logUploader?.stop();
    this._logUploader = null;
    const hadExecutionId = !!this.job?.executionId;
    this.job = null;
    this._isActive = false;
    // In supervisor mode (no executionId), keep counter monotonic
    if (hadExecutionId) {
      this.messageCounter = 0;
    }
    this._lastAssistantMessageId = null;
  }

  // ---------------------------------------------------------------------------
  // Active State Management
  // ---------------------------------------------------------------------------

  /**
   * Set whether the wrapper is actively processing a prompt.
   * Replaces addInflight/removeInflight — only one prompt is active at a time.
   */
  setActive(active: boolean): void {
    this._isActive = active;
    if (active) {
      this.updateActivity();
      this.onBecameActive?.();
    }
  }

  // ---------------------------------------------------------------------------
  // Connection Management
  // ---------------------------------------------------------------------------

  get isConnected(): boolean {
    return this._ingestWs !== null && this._ingestWs.readyState === WebSocket.OPEN;
  }

  get ingestWs(): WebSocket | null {
    return this._ingestWs;
  }

  get sseAbortController(): AbortController | null {
    return this._sseAbortController;
  }

  /**
   * Store connection references. Actual connection management is in connection.ts.
   */
  setConnections(ws: WebSocket, sseAbortController: AbortController): void {
    this._ingestWs = ws;
    this._sseAbortController = sseAbortController;
  }

  /**
   * Clear connection references. Does NOT close or abort — connection.ts
   * exclusively owns close semantics and calls this after its own cleanup.
   */
  clearConnectionRefs(): void {
    this._sseAbortController = null;
    this._ingestWs = null;
  }

  /**
   * Set the function used to send events to ingest.
   * This is set by connection.ts when connection is established.
   */
  setSendToIngestFn(fn: ((event: IngestEvent) => void) | null): void {
    this._sendToIngestFn = fn;
  }

  /**
   * Send an event to ingest WebSocket.
   * Silently drops the event if not connected (events are buffered in ConnectionManager).
   */
  sendToIngest(event: IngestEvent): void {
    if (!this._sendToIngestFn) {
      return;
    }
    this._sendToIngestFn(event);
  }

  // ---------------------------------------------------------------------------
  // Log Uploader
  // ---------------------------------------------------------------------------

  get logUploader(): LogUploader | null {
    return this._logUploader;
  }

  setLogUploader(uploader: LogUploader | null): void {
    this._logUploader?.stop();
    this._logUploader = uploader;
  }

  // ---------------------------------------------------------------------------
  // Activity Tracking
  // ---------------------------------------------------------------------------

  /**
   * Update last activity timestamp. Called on any meaningful action.
   */
  updateActivity(): void {
    this.lastActivityAt = Date.now();
  }

  /**
   * Get milliseconds since last activity.
   */
  getIdleMs(now: number): number {
    return now - this.lastActivityAt;
  }

  // ---------------------------------------------------------------------------
  // Error Tracking
  // ---------------------------------------------------------------------------

  /**
   * Set the last error. This is cached for Worker to poll via /job/status.
   */
  setLastError(error: LastError): void {
    this._lastError = error;
  }

  /**
   * Get the last error.
   */
  getLastError(): LastError | null {
    return this._lastError;
  }

  /**
   * Clear the last error.
   */
  clearLastError(): void {
    this._lastError = null;
  }

  // ---------------------------------------------------------------------------
  // Assistant Message ID Tracking
  // ---------------------------------------------------------------------------

  /**
   * Get the last root-session assistant message ID.
   * Tracked from message.updated kilocode events for autocommit association.
   */
  get lastAssistantMessageId(): string | null {
    return this._lastAssistantMessageId;
  }

  /**
   * Update the last assistant message ID.
   * Called by connection.ts when a message.updated event with role=assistant is seen.
   */
  setLastAssistantMessageId(messageId: string): void {
    this._lastAssistantMessageId = messageId;
  }

  // ---------------------------------------------------------------------------
  // Message ID Generation
  // ---------------------------------------------------------------------------

  /**
   * Generate the next messageId for this job.
   * Format: msg_<base-executionId>_<counter> (shared-sandbox) or msg_<sessionId>_<counter> (supervisor)
   */
  nextMessageId(): string {
    if (!this.job) {
      throw new Error('No job context - call startJob() first');
    }
    this.messageCounter++;
    if (this.job.executionId) {
      const base = this.job.executionId.replace(/^(exc_|exec_|execution_|msg_)/, '');
      return `msg_${base}_${this.messageCounter}`;
    }
    // Supervisor mode: session-stable, monotonic IDs
    return `msg_${this.agentSessionId}_${this.messageCounter}`;
  }

  // ---------------------------------------------------------------------------
  // Status for API Responses
  // ---------------------------------------------------------------------------

  /**
   * Get current wrapper status for /job/status endpoint.
   */
  getStatus(): WrapperStatus {
    return {
      state: this.isActive ? 'active' : 'idle',
      executionId: this.job?.executionId,
      sessionId: this.job?.kiloSessionId,
      lastError: this._lastError ?? undefined,
    };
  }
}
