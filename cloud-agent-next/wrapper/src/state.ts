/**
 * WrapperState - Single source of truth for wrapper state.
 *
 * All wrapper state is centralized here. Other modules receive a WrapperState
 * instance and interact with it through methods. This makes state transitions
 * explicit, simplifies testing, and prevents scattered state bugs.
 *
 * State model:
 * - IDLE: inflight.size == 0 (no pending prompt completions)
 * - ACTIVE: inflight.size > 0 (one or more prompts waiting for completion)
 */

import type { IngestEvent } from '../../src/shared/protocol.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InflightEntry {
  messageId: string;
  startedAt: number;
  deadlineAt: number;
}

export interface JobContext {
  executionId: string;
  sessionId: string;
  userId: string;
  kiloSessionId: string;
  ingestUrl: string;
  ingestToken: string;
  kilocodeToken: string;
}

export interface LastError {
  code: string;
  messageId?: string;
  message: string;
  timestamp: number;
}

export interface WrapperStatus {
  state: 'idle' | 'active';
  executionId?: string;
  kiloSessionId?: string;
  inflight: string[];
  inflightCount: number;
  lastError?: LastError;
}

// ---------------------------------------------------------------------------
// WrapperState Class
// ---------------------------------------------------------------------------

export class WrapperState {
  // Job context (set on /job/start, cleared on idle timeout)
  private job: JobContext | null = null;

  // Inflight prompts (keyed by messageId)
  private inflight = new Map<string, InflightEntry>();

  // Connection state - managed externally, stored here for reference
  private _ingestWs: WebSocket | null = null;
  private _sseAbortController: AbortController | null = null;

  // Activity tracking
  private lastActivityAt = Date.now();
  private _lastError: LastError | null = null;

  // SSE activity tracking (separate from general activity - tracks actual SSE events)
  private lastSseEventAt = 0; // 0 means no SSE events received yet

  // Message counter for ID generation
  private messageCounter = 0;

  // Callbacks for sending events to ingest
  private _sendToIngestFn: ((event: IngestEvent) => void) | null = null;

  // ---------------------------------------------------------------------------
  // State Queries
  // ---------------------------------------------------------------------------

  get isIdle(): boolean {
    return this.inflight.size === 0;
  }

  get isActive(): boolean {
    return this.inflight.size > 0;
  }

  get hasJob(): boolean {
    return this.job !== null;
  }

  get currentJob(): JobContext | null {
    return this.job;
  }

  get inflightCount(): number {
    return this.inflight.size;
  }

  get inflightMessageIds(): string[] {
    return Array.from(this.inflight.keys());
  }

  // ---------------------------------------------------------------------------
  // Job Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start a new job. If a job with the same executionId is already active,
   * this is a no-op (idempotent). If a different job is active and has
   * inflight prompts, throws an error (caller should return 409).
   */
  startJob(context: JobContext): void {
    // Idempotent: same executionId returns early
    if (this.job && this.job.executionId === context.executionId) {
      return;
    }

    // Conflict: different job with inflight prompts
    if (this.job && this.job.executionId !== context.executionId && this.isActive) {
      throw new Error(`Cannot start new job while inflight > 0 (active: ${this.job.executionId})`);
    }

    // Start new job
    this.job = context;
    this._lastError = null;
    this.messageCounter = 0;
    this.updateActivity();
  }

  /**
   * Clear job context. Called on idle timeout or explicit reset.
   */
  clearJob(): void {
    this.job = null;
    this.inflight.clear();
    this.messageCounter = 0;
  }

  // ---------------------------------------------------------------------------
  // Inflight Management
  // ---------------------------------------------------------------------------

  /**
   * Add a prompt to the inflight map.
   */
  addInflight(messageId: string, deadlineAt: number): void {
    this.inflight.set(messageId, {
      messageId,
      startedAt: Date.now(),
      deadlineAt,
    });
    this.updateActivity();
  }

  /**
   * Remove a prompt from the inflight map.
   * Returns true if the messageId was found and removed.
   */
  removeInflight(messageId: string): boolean {
    const removed = this.inflight.delete(messageId);
    if (removed) {
      this.updateActivity();
    }
    return removed;
  }

  /**
   * Get all inflight entries that have exceeded their deadline.
   */
  getExpiredInflight(now: number): InflightEntry[] {
    const expired: InflightEntry[] = [];
    for (const entry of this.inflight.values()) {
      if (now >= entry.deadlineAt) {
        expired.push(entry);
      }
    }
    return expired;
  }

  /**
   * Clear all inflight entries. Called on abort or disconnect.
   */
  clearAllInflight(): void {
    this.inflight.clear();
  }

  /**
   * Check if a specific messageId is inflight.
   */
  hasInflight(messageId: string): boolean {
    return this.inflight.has(messageId);
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
   * Clear connection references and close if open.
   */
  clearConnections(): void {
    if (this._sseAbortController) {
      this._sseAbortController.abort();
      this._sseAbortController = null;
    }
    if (this._ingestWs) {
      try {
        this._ingestWs.close();
      } catch {
        // Ignore close errors
      }
      this._ingestWs = null;
    }
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
  // SSE Activity Tracking
  // ---------------------------------------------------------------------------

  /**
   * Record that an SSE event was received.
   */
  recordSseEvent(): void {
    this.lastSseEventAt = Date.now();
  }

  /**
   * Get milliseconds since last SSE event.
   * Returns null if no SSE events have been received yet.
   */
  getSseInactivityMs(now: number): number | null {
    if (this.lastSseEventAt === 0) return null;
    return now - this.lastSseEventAt;
  }

  /**
   * Check if SSE events have ever been received.
   */
  hasSseActivity(): boolean {
    return this.lastSseEventAt > 0;
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
  // Message ID Generation
  // ---------------------------------------------------------------------------

  /**
   * Generate the next messageId for this job.
   * Format: msg_<base-executionId>_<counter>
   */
  nextMessageId(): string {
    if (!this.job) {
      throw new Error('No job context - call startJob() first');
    }
    this.messageCounter++;
    // Strip known prefixes if present
    const base = this.job.executionId.replace(/^(exec_|execution_|msg_)/, '');
    return `msg_${base}_${this.messageCounter}`;
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
      kiloSessionId: this.job?.kiloSessionId,
      inflight: this.inflightMessageIds,
      inflightCount: this.inflightCount,
      lastError: this._lastError ?? undefined,
    };
  }
}
