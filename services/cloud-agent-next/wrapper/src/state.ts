import type { IngestEvent } from '../../src/shared/protocol.js';
import type { WrapperCommitCoAuthor } from '../../src/shared/wrapper-bootstrap.js';
import type { LogUploader } from './log-uploader.js';
export type { LogUploader } from './log-uploader.js';

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

export type FinalizationConfig = {
  autoCommit: boolean;
  condenseOnComplete: boolean;
  model?: string;
  upstreamBranch?: string;
  commitCoAuthor?: WrapperCommitCoAuthor;
};

export type LastError = {
  code: string;
  messageId?: string;
  message: string;
  timestamp: number;
};

export type WrapperStatus = {
  state: 'idle' | 'active' | 'finalizing';
  sessionId?: string;
  pendingMessages: string[];
  lastError?: LastError;
};

export class WrapperState {
  private session: SessionContext | null = null;
  private admittedMessages = new Map<string, FinalizationConfig>();
  private latestAdmittedFinalizationConfig: FinalizationConfig | null = null;
  private _deliveryAcknowledgementsInFlight = 0;
  private _admissionsBlocked = false;
  private _blockedWrapperRunId: string | undefined;
  private _isFinalizing = false;
  private _ingestWs: WebSocket | null = null;
  private _sseAbortController: AbortController | null = null;
  private lastActivityAt = Date.now();
  private _lastError: LastError | null = null;
  private _lastAssistantMessageId: string | null = null;
  private _observedGateResult: 'pass' | 'fail' | null = null;
  private _sendToIngestFn: ((event: IngestEvent) => void) | null = null;
  private _logUploader: LogUploader | null = null;

  get isIdle(): boolean {
    return !this.isActive;
  }

  get isActive(): boolean {
    return (
      this.hasPendingMessages || this._deliveryAcknowledgementsInFlight > 0 || this._isFinalizing
    );
  }

  get isFinalizing(): boolean {
    return this._isFinalizing;
  }

  get admissionsBlocked(): boolean {
    return this._admissionsBlocked;
  }

  beginFinalizing(): boolean {
    if (
      this._isFinalizing ||
      !this.hasPendingMessages ||
      this._deliveryAcknowledgementsInFlight > 0
    ) {
      return false;
    }
    this._isFinalizing = true;
    this.blockAdmissions();
    return true;
  }

  blockAdmissions(): void {
    this._admissionsBlocked = true;
    this._blockedWrapperRunId = this.session?.wrapperRunId;
  }

  get finalizingWrapperRunId(): string | undefined {
    return this._blockedWrapperRunId ?? this.session?.wrapperRunId;
  }

  get isConnected(): boolean {
    return this._ingestWs !== null && this._ingestWs.readyState === WebSocket.OPEN;
  }

  get ingestWs(): WebSocket | null {
    return this._ingestWs;
  }

  get sseAbortController(): AbortController | null {
    return this._sseAbortController;
  }

  setConnections(ws: WebSocket, sseAbortController: AbortController): void {
    this._ingestWs = ws;
    this._sseAbortController = sseAbortController;
  }

  clearConnectionRefs(): void {
    this._sseAbortController = null;
    this._ingestWs = null;
  }

  setSendToIngestFn(fn: ((event: IngestEvent) => void) | null): void {
    this._sendToIngestFn = fn;
  }

  /**
   * Clear the send fn only if `fn` is still the active one, so a channel
   * closing late cannot clobber a newer connection's send fn.
   */
  clearSendToIngestFn(fn: (event: IngestEvent) => void): void {
    if (this._sendToIngestFn === fn) this._sendToIngestFn = null;
  }

  sendToIngest(event: IngestEvent): void {
    this._sendToIngestFn?.(event);
  }

  get logUploader(): LogUploader | null {
    return this._logUploader;
  }

  setLogUploader(uploader: LogUploader | null): void {
    this._logUploader?.stop();
    this._logUploader = uploader;
  }

  updateActivity(): void {
    this.lastActivityAt = Date.now();
  }

  getIdleMs(now: number): number {
    return now - this.lastActivityAt;
  }

  setLastError(error: LastError): void {
    this._lastError = error;
  }

  getLastError(): LastError | null {
    return this._lastError;
  }

  clearLastError(): void {
    this._lastError = null;
  }

  get lastAssistantMessageId(): string | null {
    return this._lastAssistantMessageId;
  }

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

  getStatus(): WrapperStatus {
    return {
      state: this._isFinalizing ? 'finalizing' : this.isActive ? 'active' : 'idle',
      sessionId: this.session?.kiloSessionId,
      pendingMessages: this.pendingMessageIds,
      lastError: this._lastError ?? undefined,
    };
  }

  get hasSession(): boolean {
    return this.session !== null;
  }

  get currentSession(): SessionContext | null {
    return this.session;
  }

  bindSession(context: SessionContext): { changed: boolean } {
    if (!this.session) {
      this.session = context;
      this._admissionsBlocked = false;
      this._blockedWrapperRunId = undefined;
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
    this.clearAllMessages();
    this._lastAssistantMessageId = null;
  }

  beginDeliveryAcknowledgement(): boolean {
    if (this._admissionsBlocked || this._isFinalizing) return false;
    this._deliveryAcknowledgementsInFlight++;
    this.updateActivity();
    return true;
  }

  endDeliveryAcknowledgement(): void {
    if (this._deliveryAcknowledgementsInFlight > 0) {
      this._deliveryAcknowledgementsInFlight--;
    }
  }

  get deliveryAcknowledgementsInFlight(): number {
    return this._deliveryAcknowledgementsInFlight;
  }

  acceptMessage(messageId: string, config: FinalizationConfig): boolean {
    if (this.admittedMessages.has(messageId)) return false;
    this.admittedMessages.set(messageId, config);
    this.latestAdmittedFinalizationConfig = config;
    this.updateActivity();
    return true;
  }

  get hasPendingMessages(): boolean {
    return this.admittedMessages.size > 0;
  }

  get pendingMessageIds(): string[] {
    return [...this.admittedMessages.keys()];
  }

  get batchFinalizationConfig(): FinalizationConfig | null {
    return this.latestAdmittedFinalizationConfig;
  }

  getMessageConfig(messageId: string): FinalizationConfig | null {
    return this.admittedMessages.get(messageId) ?? null;
  }

  removeMessage(messageId: string): void {
    const removedLatest =
      this.latestAdmittedFinalizationConfig === this.admittedMessages.get(messageId);
    this.admittedMessages.delete(messageId);
    if (removedLatest) {
      this.latestAdmittedFinalizationConfig = [...this.admittedMessages.values()].at(-1) ?? null;
    }
  }

  clearAllMessages(): void {
    this.admittedMessages.clear();
    this.latestAdmittedFinalizationConfig = null;
    this._deliveryAcknowledgementsInFlight = 0;
    this._isFinalizing = false;
    this._observedGateResult = null;
  }
}
