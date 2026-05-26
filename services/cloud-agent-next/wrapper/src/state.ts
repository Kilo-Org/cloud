/**
 * WrapperState - Single source of truth for wrapper state.
 *
 * All wrapper state is centralized here. Other modules receive a WrapperState
 * instance and interact with it through methods. This makes state transitions
 * explicit, simplifies testing, and prevents scattered state bugs.
 *
 * Session-level multi-message model:
 * - Session context: shared connection parameters across messages
 * - Message tracking: each message has state 'accepted' | 'active' | 'completed'
 * - At most one 'active' message at a time; others are 'accepted' (queued)
 * - Wrapper is idle only when no messages are pending
 */

import type { IngestEvent } from '../../src/shared/protocol.js';
import type { LogUploader } from './log-uploader.js';
export type { LogUploader } from './log-uploader.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionContext = {
  kiloSessionId: string;
  ingestUrl: string;
  ingestToken?: string;
  workerAuthToken: string;
  platform?: string;
  wrapperRunId?: string;
  wrapperGeneration?: number;
  wrapperConnectionId?: string;
  agentSessionId?: string;
};

export type MessageState = 'accepted' | 'active' | 'completed';

export type MessageInfo = {
  messageId: string;
  state: MessageState;
  autoCommit: boolean;
  condenseOnComplete: boolean;
  model?: string;
  upstreamBranch?: string;
};

export type LastError = {
  code: string;
  messageId?: string;
  message: string;
  timestamp: number;
};

export type WrapperStatus = {
  state: 'idle' | 'active';
  sessionId?: string;
  pendingMessages: string[];
  lastError?: LastError;
};

// ---------------------------------------------------------------------------
// WrapperState Class
// ---------------------------------------------------------------------------

export class WrapperState {
  private _isActive = false;

  // Session-level context (set on first bind, updated on subsequent binds)
  private session: SessionContext | null = null;

  // Per-message tracking
  private messages: Map<string, MessageInfo> = new Map();

  // The currently active messageId (Kilo is processing it)
  private _activeMessageId: string | null = null;

  // Connection state - managed externally, stored here for reference
  private _ingestWs: WebSocket | null = null;
  private _sseAbortController: AbortController | null = null;

  // Activity tracking
  private lastActivityAt = Date.now();
  private _lastError: LastError | null = null;

  // Last root-session assistant message ID (tracked from message.updated kilocode events)
  private _lastAssistantMessageId: string | null = null;

  private _observedGateResult: 'pass' | 'fail' | null = null;

  // Config of the most recently completed message, captured before active message advances
  private _completedMessageConfig: {
    autoCommit: boolean;
    condenseOnComplete: boolean;
    model?: string;
    upstreamBranch?: string;
  } | null = null;

  // Callbacks for sending events to ingest
  private _sendToIngestFn: ((event: IngestEvent) => void) | null = null;

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

  get observedGateResult(): 'pass' | 'fail' | undefined {
    return this._observedGateResult ?? undefined;
  }

  observeGateResult(gateResult: 'pass' | 'fail'): void {
    this._observedGateResult = gateResult;
  }

  consumeObservedGateResult(): 'pass' | 'fail' | undefined {
    const gateResult = this.observedGateResult;
    this._observedGateResult = null;
    return gateResult;
  }

  // ---------------------------------------------------------------------------
  // Status for API Responses
  // ---------------------------------------------------------------------------

  getStatus(): WrapperStatus {
    return {
      state: this.isActive ? 'active' : 'idle',
      sessionId: this.session?.kiloSessionId,
      pendingMessages: this.pendingMessageIds,
      lastError: this._lastError ?? undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Session Context
  // ---------------------------------------------------------------------------

  get hasSession(): boolean {
    return this.session !== null;
  }

  get currentSession(): SessionContext | null {
    return this.session;
  }

  bindSession(context: SessionContext): { changed: boolean } {
    if (!this.session) {
      this.session = context;
      this._lastError = null;
      this.updateActivity();
      return { changed: true };
    }
    const changed =
      this.session.ingestUrl !== context.ingestUrl ||
      this.session.ingestToken !== context.ingestToken ||
      this.session.workerAuthToken !== context.workerAuthToken ||
      this.session.platform !== context.platform ||
      this.session.wrapperRunId !== context.wrapperRunId ||
      this.session.wrapperGeneration !== context.wrapperGeneration ||
      this.session.wrapperConnectionId !== context.wrapperConnectionId;
    if (changed) {
      this.session = context;
      this.updateActivity();
    }
    return { changed };
  }

  clearSession(): void {
    this._logUploader?.stop();
    this._logUploader = null;
    this.session = null;
    this.messages.clear();
    this._activeMessageId = null;
    this._isActive = false;
    this._lastAssistantMessageId = null;
    this._observedGateResult = null;
    this._completedMessageConfig = null;
  }

  // ---------------------------------------------------------------------------
  // Message Tracking
  // ---------------------------------------------------------------------------

  acceptMessage(
    messageId: string,
    config: {
      autoCommit: boolean;
      condenseOnComplete: boolean;
      model?: string;
      upstreamBranch?: string;
    }
  ): void {
    const info: MessageInfo = {
      messageId,
      state: !this._activeMessageId ? 'active' : 'accepted',
      ...config,
    };
    this.messages.set(messageId, info);
    if (!this._activeMessageId) {
      this._activeMessageId = messageId;
      this._isActive = true;
    }
    this.updateActivity();
  }

  completeActiveMessage(): MessageInfo | null {
    if (!this._activeMessageId) return null;
    const info = this.messages.get(this._activeMessageId);
    if (info) info.state = 'completed';
    const completedInfo = info ?? null;

    let nextActive: string | null = null;
    for (const [id, msg] of this.messages) {
      if (msg.state === 'accepted') {
        nextActive = id;
        break;
      }
    }

    this._activeMessageId = nextActive;
    if (nextActive) {
      const nextInfo = this.messages.get(nextActive);
      if (nextInfo) nextInfo.state = 'active';
    } else {
      this._isActive = false;
    }

    return completedInfo;
  }

  completeMessage(messageId: string): MessageInfo | null {
    if (messageId !== this._activeMessageId) return null;
    const info = this.messages.get(messageId);
    if (!info) return null;

    info.state = 'completed';

    let nextActive: string | null = null;
    for (const [id, msg] of this.messages) {
      if (msg.state === 'accepted') {
        nextActive = id;
        break;
      }
    }

    this._activeMessageId = nextActive;
    if (nextActive) {
      const nextInfo = this.messages.get(nextActive);
      if (nextInfo) nextInfo.state = 'active';
    } else {
      this._isActive = false;
    }

    return info;
  }

  get activeMessageId(): string | null {
    return this._activeMessageId;
  }

  get hasPendingMessages(): boolean {
    for (const msg of this.messages.values()) {
      if (msg.state !== 'completed') return true;
    }
    return false;
  }

  get pendingMessageIds(): string[] {
    const ids: string[] = [];
    for (const msg of this.messages.values()) {
      if (msg.state !== 'completed') ids.push(msg.messageId);
    }
    return ids;
  }

  get activeMessageConfig(): {
    autoCommit: boolean;
    condenseOnComplete: boolean;
    model?: string;
    upstreamBranch?: string;
  } | null {
    if (!this._activeMessageId) return null;
    const info = this.messages.get(this._activeMessageId);
    if (!info) return null;
    return {
      autoCommit: info.autoCommit,
      condenseOnComplete: info.condenseOnComplete,
      model: info.model,
      upstreamBranch: info.upstreamBranch,
    };
  }

  get completedMessageConfig(): {
    autoCommit: boolean;
    condenseOnComplete: boolean;
    model?: string;
    upstreamBranch?: string;
  } | null {
    return this._completedMessageConfig;
  }

  setCompletedMessageConfig(config: {
    autoCommit: boolean;
    condenseOnComplete: boolean;
    model?: string;
    upstreamBranch?: string;
  }): void {
    this._completedMessageConfig = config;
  }

  clearCompletedMessageConfig(): void {
    this._completedMessageConfig = null;
  }

  getMessageConfig(messageId: string): {
    autoCommit: boolean;
    condenseOnComplete: boolean;
    model?: string;
    upstreamBranch?: string;
  } | null {
    const info = this.messages.get(messageId);
    if (!info) return null;
    return {
      autoCommit: info.autoCommit,
      condenseOnComplete: info.condenseOnComplete,
      model: info.model,
      upstreamBranch: info.upstreamBranch,
    };
  }

  updateMessageConfig(
    messageId: string,
    config: {
      autoCommit?: boolean;
      condenseOnComplete?: boolean;
      model?: string;
      upstreamBranch?: string;
    }
  ): void {
    const info = this.messages.get(messageId);
    if (!info) return;
    if (config.autoCommit !== undefined) info.autoCommit = config.autoCommit;
    if (config.condenseOnComplete !== undefined)
      info.condenseOnComplete = config.condenseOnComplete;
    if (config.model !== undefined) info.model = config.model;
    if (config.upstreamBranch !== undefined) info.upstreamBranch = config.upstreamBranch;
  }

  removeMessage(messageId: string): void {
    this.messages.delete(messageId);
    if (this._activeMessageId === messageId) {
      let nextActive: string | null = null;
      for (const [id, msg] of this.messages) {
        if (msg.state === 'accepted') {
          nextActive = id;
          break;
        }
      }
      if (nextActive) {
        this._activeMessageId = nextActive;
        const nextInfo = this.messages.get(nextActive);
        if (nextInfo) nextInfo.state = 'active';
      } else {
        this._activeMessageId = null;
        this._isActive = false;
      }
    }
  }

  clearAllMessages(): void {
    this.messages.clear();
    this._activeMessageId = null;
    this._isActive = false;
    this._observedGateResult = null;
    this._completedMessageConfig = null;
  }
}
