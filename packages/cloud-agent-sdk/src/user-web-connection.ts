import * as z from 'zod';
import {
  createBaseConnection,
  type Connection,
  type ConnectionLifecycleHooks,
} from './base-connection';
import { cloudAgentSdkRuntime } from './runtime';
import {
  browserFailureReasonSchema,
  browserProviderOutboundMessageSchema,
  normalizedBrowserCapabilitiesSchema,
  sessionEventPayloadSchema,
  userWebCommandErrorDataSchema,
  webInboundMessageSchema,
  webInboundWithBrowserMessageSchema,
  type BrowserJobHandle,
  type BrowserJobSnapshot,
  type BrowserProviderInboundMessage,
  type BrowserProviderOutboundMessage,
  type SessionEventPayload,
  type WebInboundMessage,
  type WebInboundWithBrowserMessage,
} from './schemas';

const BROWSER_PROVIDER_REQUEST_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 30_000;
const INITIAL_AUTH_RETRY_BASE_MS = 1_000;
const INITIAL_AUTH_RETRY_CAP_MS = 30_000;
export const VIEWER_PING_INTERVAL_MS = 20_000;
export const VIEWER_PONG_TIMEOUT_MS = 10_000;

type UserWebSessionEventName = SessionEventPayload['type'];
type UserWebSessionEventData<T extends UserWebSessionEventName> = Extract<
  SessionEventPayload,
  { type: T }
>['data'];
type CliEvent = Omit<Extract<WebInboundMessage, { type: 'event' }>, 'type'>;
type SystemEvent = Omit<Extract<WebInboundMessage, { type: 'system' }>, 'type'>;

class UserWebCommandError extends Error {
  readonly code: string;

  constructor(error: { code: string; message: string }) {
    super(error.message);
    this.name = 'UserWebCommandError';
    this.code = error.code;
  }
}

/**
 * Error class used to wrap a *delivered* (non-structured, bare-string) command
 * error response. The message is preserved verbatim so generic `catch (e)`
 * consumers see the same string the relay/CLI emitted; the new class only
 * lets downstream callers distinguish a delivered error from a transport-level
 * failure (timeout, connection destroyed, socket gone — those stay plain
 * `Error`).
 *
 * Structured `UserWebCommandError` responses (relay envelopes with a `.code`)
 * are NOT wrapped — they already carry enough info.
 */
class CommandDeliveredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandDeliveredError';
  }
}

type BrowserProviderLease = Extract<BrowserProviderInboundMessage, { type: 'provider_lease_ack' }>;
type BrowserProviderSnapshot = Extract<
  BrowserProviderInboundMessage,
  { type: 'provider_snapshot' }
>;
type BrowserProviderStatusResult = Extract<
  BrowserProviderInboundMessage,
  { type: 'provider_status_result' }
>;
type BrowserProviderRegisterWire = Extract<
  BrowserProviderOutboundMessage,
  { type: 'provider_register' }
>;
type BrowserProviderHeartbeatWire = Extract<
  BrowserProviderOutboundMessage,
  { type: 'provider_heartbeat' }
>;
type BrowserProviderStatusWire = Extract<
  BrowserProviderOutboundMessage,
  { type: 'provider_status' }
>;
type BrowserProviderRegistration = Omit<
  BrowserProviderRegisterWire,
  'type' | 'requestId' | 'enabled'
>;
type BrowserProviderApprovalInput = Omit<
  Extract<BrowserProviderOutboundMessage, { type: 'provider_approval' }>,
  'type'
>;
type BrowserProviderCancelInput = Omit<
  Extract<BrowserProviderOutboundMessage, { type: 'provider_cancel' }>,
  'type'
>;
type BrowserProviderResultInput = Omit<
  Extract<BrowserProviderOutboundMessage, { type: 'provider_result' }>,
  'type'
>;
type BrowserProviderQuiescenceInput = Omit<
  Extract<BrowserProviderOutboundMessage, { type: 'provider_quiesced' }>,
  'type'
>;
type BrowserProviderUnavailableInput = Omit<
  Extract<BrowserProviderOutboundMessage, { type: 'provider_unavailable' }>,
  'type'
>;
type BrowserProviderErrorCode =
  | BrowserProviderUnavailableInput['reason']
  | 'disabled'
  | 'disconnected'
  | 'not_negotiated'
  | 'request_timeout';

class BrowserProviderError extends Error {
  constructor(
    readonly code: BrowserProviderErrorCode,
    readonly retryable: boolean
  ) {
    // Never include relay text, validation issues, registration proofs, or socket errors.
    super(`Browser provider request failed: ${code}`);
    this.name = 'BrowserProviderError';
  }
}

const browserProviderErrorSchema = z.object({
  source: z.literal('relay'),
  code: browserFailureReasonSchema,
  retryable: z.boolean(),
});

type BrowserProviderState =
  | { status: 'disabled' | 'disconnected' | 'negotiating' | 'ready' }
  | { status: 'registered'; lease: BrowserProviderLease }
  | { status: 'unavailable'; reason: BrowserProviderErrorCode; retryable: boolean };

/** Additive API; the legacy UserWebConnection structural contract remains unchanged. */
type BrowserProviderConnection = {
  getBrowserProviderState: () => BrowserProviderState;
  onBrowserProviderStateChange: (listener: (state: BrowserProviderState) => void) => () => void;
  /** Snapshots and history reconcile persisted state. Only provider_job offers new work for approval. */
  onBrowserProviderMessage: (
    listener: (message: BrowserProviderInboundMessage) => void
  ) => () => void;
  /** Requires an explicitly retained, negotiated connection. Keeps only stable registration data for reconnect. */
  registerBrowserProvider: (input: BrowserProviderRegistration) => Promise<BrowserProviderLease>;
  /** Renews the current lease and reconciles only its generation. */
  heartbeatBrowserProvider: (cursor?: string) => Promise<BrowserProviderSnapshot>;
  /** Reads history without execution authority. Explicit proof is used only for this request. */
  requestBrowserProviderStatus: (
    cursor?: string,
    identity?: Pick<BrowserProviderRegistration, 'providerId' | 'providerProof'>
  ) => Promise<BrowserProviderStatusResult>;
  /** Sends consent only. Wait for a running snapshot before starting browser actions. */
  approveBrowserProviderJob: (input: BrowserProviderApprovalInput) => void;
  cancelBrowserProviderJob: (input: BrowserProviderCancelInput) => void;
  sendBrowserProviderResult: (input: BrowserProviderResultInput) => void;
  quiesceBrowserProviderJob: (input: BrowserProviderQuiescenceInput) => void;
  markBrowserProviderUnavailable: (input: BrowserProviderUnavailableInput) => void;
};

type UserWebConnectionConfig = {
  websocketUrl: string;
  getAuthToken: () => string | Promise<string>;
  onError?: (message: string) => void;
  onReconnect?: () => void;
  lifecycleHooks?: ConnectionLifecycleHooks;
  maxReconnectAttempts?: number;
  /** Old callers omit this flag and stay disabled. This compatibility default is permanent. */
  browserProvider?: boolean;
};

type SendCommandToConnectionInput = {
  command: string;
  data: unknown;
  expectedConnectionId: string;
  // Stable intent id forwarded to the relay for durable dedupe (D8).
  mutationId?: string;
};

type UserWebConnection = {
  retain: () => () => void;
  /** @deprecated Retain the connection explicitly with retain() instead. */
  connect: () => void;
  /** @deprecated Release the function returned by retain() instead. */
  disconnect: () => void;
  destroy: () => void;
  /**
   * Returns the current high-level transport readiness. `true` once the base
   * connection has reported its first successful message after open (or
   * re-open); `false` otherwise — including during reconnect attempts and
   * after a final release or `destroy()`.
   */
  isConnected: () => boolean;
  /**
   * Subscribes to transport-readiness transitions. The listener fires only
   * when the boolean value actually changes. The returned function
   * unsubscribes. Safe to call on a destroyed connection: the listener is
   * never invoked and the unsubscribe is a no-op.
   */
  onConnectionChange: (listener: (connected: boolean) => void) => () => void;
  // The boolean readiness API (old form) stays the readiness source for existing consumers; the exhaustion signal is additive and owns only recovery UI. Removal condition: none — the boolean API is permanent.
  isReconnectExhausted: () => boolean;
  onReconnectExhaustionChange: (listener: (exhausted: boolean) => void) => () => void;
  retryConnection: () => void;
  subscribeToCliSession: (sessionId: string) => () => void;
  sendCommand: (
    sessionId: string,
    command: string,
    data: unknown,
    expectedOwnerConnectionId?: string,
    // Stable intent id forwarded to the relay for durable dedupe.
    // Absent on legacy paths that do not re-issue (D5).
    mutationId?: string
  ) => Promise<unknown>;
  /**
   * Send a viewer command that is scoped to a specific CLI connection and has
   * no associated session (e.g. a connection-scoped runtime probe). The wire
   * frame includes `connectionId` and omits `sessionId`. Shares the existing
   * correlated command lifecycle: timeout, open/disconnect handling, and
   * structured `UserWebCommandError` errors.
   */
  sendCommandToConnection: (input: SendCommandToConnectionInput) => Promise<unknown>;
  onCliEvent: (sessionId: string, listener: (event: CliEvent) => void) => () => void;
  onSystemEvent: (listener: (event: SystemEvent) => void) => () => void;
  onReconnect: (listener: () => void) => () => void;
  onSessionEvent: <T extends UserWebSessionEventName>(
    event: T,
    listener: (data: UserWebSessionEventData<T>) => void
  ) => () => void;
};

/**
 * Resolve a delivered command-error payload into an `Error` subclass.
 *
 * - A bare-string delivered error is wrapped in `CommandDeliveredError` so
 *   downstream consumers can distinguish it from transport-level failures
 *   (which stay plain `Error`).
 * - A structured relay envelope that matches `userWebCommandErrorDataSchema`
 *   becomes a `UserWebCommandError` (already has a `.code`).
 * - A malformed structured payload collapses to a plain `Error('Command failed')`
 *   — the relay envelope wasn't trustworthy so this is not a real "delivered"
 *   message.
 */
function parseCommandError(error: unknown): Error {
  if (typeof error === 'string') return new CommandDeliveredError(error);

  const parsed = userWebCommandErrorDataSchema.safeParse(error);
  if (parsed.success) return new UserWebCommandError(parsed.data);
  return new Error('Command failed');
}

function createUserWebConnection(
  config: UserWebConnectionConfig
): UserWebConnection & BrowserProviderConnection {
  const connectionId = cloudAgentSdkRuntime.randomUUID();
  const browserProviderEnabled = config.browserProvider ?? false;
  let providerNegotiated = false;
  let providerEpoch = 0;
  let providerState: BrowserProviderState = {
    status: browserProviderEnabled ? 'disconnected' : 'disabled',
  };
  let providerRegistration: BrowserProviderRegistration | null = null;
  let providerLease: BrowserProviderLease | null = null;
  // A lost lease can still acknowledge drained work, but cannot authorize another action.
  let providerBinding: Pick<BrowserProviderLease, 'providerId' | 'generation'> | null = null;
  let providerLeaseTimer: ReturnType<typeof setTimeout> | null = null;
  let providerHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  const providerListeners = new Set<(message: BrowserProviderInboundMessage) => void>();
  const providerStateListeners = new Set<(state: BrowserProviderState) => void>();
  const providerSnapshots = new Map<string, BrowserJobSnapshot>();
  const dispatchedProviderJobs = new Set<string>();
  const cancelledProviderJobs = new Set<string>();
  const pendingProviderRequests = new Map<
    string,
    {
      wire: BrowserProviderRegisterWire | BrowserProviderHeartbeatWire | BrowserProviderStatusWire;
      acknowledged: boolean;
      resolve: (
        reply: BrowserProviderLease | BrowserProviderSnapshot | BrowserProviderStatusResult
      ) => void;
      reject: (error: BrowserProviderError) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let token = '';
  let baseConnection: Connection | null = null;
  let currentWs: WebSocket | null = null;
  let destroyed = false;
  let started = false;
  let generation = 0;
  let connectPromise: Promise<void> | null = null;
  let retainCount = 0;
  let commandRetainCount = 0;
  let legacyRetained = false;
  // True once the current base connection's socket has opened (i.e. the one-use
  // ingest ticket was consumed at the upgrade). Drives the pre-connect auth
  // refresh so only reconnects mint a fresh ticket, not the initial connect.
  let hasEverOpened = false;
  let pingInterval: ReturnType<typeof setInterval> | null = null;
  let pongTimeout: ReturnType<typeof setTimeout> | null = null;
  let initialAuthRetryTimeout: ReturnType<typeof setTimeout> | null = null;
  let initialAuthRetryAttempt = 0;
  let outstandingPingNonce: string | null = null;
  const preSocketLifecycleCleanupFns: Array<() => void> = [];
  let preSocketLifecycleRegistered = false;
  const subscriptionCounts = new Map<string, number>();
  const cliListeners = new Map<string, Set<(event: CliEvent) => void>>();
  const systemListeners = new Set<(event: SystemEvent) => void>();
  const reconnectListeners = new Set<() => void>();
  const sessionListeners = new Map<UserWebSessionEventName, Set<(data: never) => void>>();
  const pendingCommands = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const pendingOpenWaiters = new Set<{
    resolve: (ws: WebSocket) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  // Wrapper-owned transport-readiness state. The base connection deliberately
  // emits no callback on `destroy()`, so transitions around full release /
  // destroy are driven here rather than from base-connection callbacks.
  let connected = false;
  const connectionChangeListeners = new Set<(connected: boolean) => void>();

  function setConnected(value: boolean): void {
    if (connected === value) return;
    connected = value;
    for (const listener of connectionChangeListeners) listener(value);
  }

  // Wrapper-owned reconnect-exhaustion snapshot, mirroring `connected`. The base
  // connection fires the two-edge callback; the wrapper keeps a synchronous
  // snapshot so `isReconnectExhausted()` reads it without crossing the base
  // boundary and listeners fire only on value changes.
  let exhausted = false;
  const exhaustionChangeListeners = new Set<(exhausted: boolean) => void>();

  function setExhausted(value: boolean): void {
    if (exhausted === value) return;
    exhausted = value;
    for (const listener of exhaustionChangeListeners) listener(value);
  }

  function setProviderState(state: BrowserProviderState): void {
    if (state.status === providerState.status && state.status !== 'registered') {
      if (state.status !== 'unavailable') return;
      if (
        providerState.status === 'unavailable' &&
        state.reason === providerState.reason &&
        state.retryable === providerState.retryable
      )
        return;
    }
    providerState = state;
    for (const listener of providerStateListeners) {
      if (providerState !== state) break;
      listener(state);
    }
  }

  function invalidateProvider(error: BrowserProviderError, disconnected = false): void {
    if (!browserProviderEnabled) return;
    providerEpoch += 1;
    providerLease = null;
    if (providerLeaseTimer !== null) clearTimeout(providerLeaseTimer);
    if (providerHeartbeatTimer !== null) clearTimeout(providerHeartbeatTimer);
    providerLeaseTimer = null;
    providerHeartbeatTimer = null;
    for (const [id, pending] of pendingProviderRequests) {
      if (!disconnected && pending.wire.type === 'provider_status') continue;
      clearTimeout(pending.timer);
      pendingProviderRequests.delete(id);
      pending.reject(error);
    }
    if (disconnected) {
      currentWs = null;
      providerNegotiated = false;
      providerBinding = null;
      providerSnapshots.clear();
      dispatchedProviderJobs.clear();
      cancelledProviderJobs.clear();
    }
    // Fence actions and reject requests before notifying the owner, including during teardown.
    setProviderState(
      disconnected
        ? { status: 'disconnected' }
        : { status: 'unavailable', reason: error.code, retryable: error.retryable }
    );
  }

  function requireProviderSocket(): WebSocket {
    if (!browserProviderEnabled) throw new BrowserProviderError('disabled', false);
    if (destroyed || !hasLifetime() || !currentWs || currentWs.readyState !== WebSocket.OPEN) {
      const error = new BrowserProviderError('disconnected', true);
      if (currentWs) {
        invalidateProvider(error, true);
        clearLiveness();
        setConnected(false);
      }
      throw error;
    }
    if (!providerNegotiated) {
      if (providerState.status === 'unavailable')
        throw new BrowserProviderError(providerState.reason, providerState.retryable);
      throw new BrowserProviderError('not_negotiated', true);
    }
    return currentWs;
  }

  function requireProviderLease(): BrowserProviderLease {
    requireProviderSocket();
    if (providerLease && Date.parse(providerLease.leaseExpiresAt) <= Date.now()) {
      invalidateProvider(new BrowserProviderError('lease_expired', true));
    }
    if (!providerLease) {
      throw providerState.status === 'unavailable'
        ? new BrowserProviderError(providerState.reason, providerState.retryable)
        : new BrowserProviderError('provider_unavailable', true);
    }
    return providerLease;
  }

  function validateProviderMessage(input: unknown): BrowserProviderOutboundMessage {
    const parsed = browserProviderOutboundMessageSchema.safeParse(input);
    if (!parsed.success) throw new BrowserProviderError('invalid_request', false);
    return parsed.data;
  }

  function sendProviderWire(wire: BrowserProviderOutboundMessage): void {
    const ws = requireProviderSocket();
    try {
      ws.send(JSON.stringify(wire));
    } catch {
      const error = new BrowserProviderError('disconnected', true);
      invalidateProvider(error, true);
      replaceUnresponsiveSocket();
      throw error;
    }
  }

  function rejectProviderRequest(requestId: string, error: BrowserProviderError): void {
    const pending = pendingProviderRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingProviderRequests.delete(requestId);
    pending.reject(error);
  }

  function requestProvider(
    wire: BrowserProviderRegisterWire | BrowserProviderHeartbeatWire | BrowserProviderStatusWire
  ): Promise<BrowserProviderLease | BrowserProviderSnapshot | BrowserProviderStatusResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new BrowserProviderError('request_timeout', true);
        if (wire.type === 'provider_status') rejectProviderRequest(wire.requestId, error);
        else invalidateProvider(error);
      }, BROWSER_PROVIDER_REQUEST_TIMEOUT_MS);
      pendingProviderRequests.set(wire.requestId, {
        wire,
        acknowledged: false,
        resolve,
        reject,
        timer,
      });
      try {
        sendProviderWire(wire);
      } catch {
        rejectProviderRequest(wire.requestId, new BrowserProviderError('disconnected', true));
      }
    });
  }

  function finishProviderRequest(
    requestId: string,
    reply: BrowserProviderLease | BrowserProviderSnapshot | BrowserProviderStatusResult
  ): void {
    const pending = pendingProviderRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingProviderRequests.delete(requestId);
    pending.resolve(reply);
  }

  async function registerBrowserProvider(
    input: BrowserProviderRegistration
  ): Promise<BrowserProviderLease> {
    const ws = requireProviderSocket();
    if (
      providerLease ||
      [...pendingProviderRequests.values()].some(
        pending => pending.wire.type === 'provider_register'
      )
    ) {
      throw new BrowserProviderError('invalid_request', false);
    }
    const wire = validateProviderMessage({
      ...input,
      type: 'provider_register',
      enabled: true,
      requestId: cloudAgentSdkRuntime.randomUUID(),
    });
    if (wire.type !== 'provider_register') throw new BrowserProviderError('invalid_request', false);
    // Recovery is an explicit, one-shot assertion. Never replay it after a lost acknowledgement.
    const registration = {
      providerId: wire.providerId,
      providerProof: wire.providerProof,
      generation: wire.generation,
      label: wire.label,
    };
    providerRegistration = registration;
    try {
      const reply = await requestProvider(wire);
      if (reply.type !== 'provider_lease_ack')
        throw new BrowserProviderError('invalid_request', false);
      return reply;
    } finally {
      // A rejected registration can leave a fence whose history still needs reconciliation.
      if (
        currentWs === ws &&
        providerRegistration === registration &&
        providerNegotiated &&
        hasLifetime() &&
        !destroyed
      )
        void requestBrowserProviderStatus().catch(() => {});
    }
  }

  async function requestBrowserProviderStatus(
    cursor?: string,
    identity?: Pick<BrowserProviderRegistration, 'providerId' | 'providerProof'>
  ): Promise<BrowserProviderStatusResult> {
    requireProviderSocket();
    const provider = identity ?? providerRegistration;
    if (!provider) throw new BrowserProviderError('provider_unavailable', true);
    const wire = validateProviderMessage({
      type: 'provider_status',
      requestId: cloudAgentSdkRuntime.randomUUID(),
      providerId: provider.providerId,
      providerProof: provider.providerProof,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (wire.type !== 'provider_status') throw new BrowserProviderError('invalid_request', false);
    const reply = await requestProvider(wire);
    if (reply.type !== 'provider_status_result')
      throw new BrowserProviderError('invalid_request', false);
    return reply;
  }

  async function heartbeatBrowserProvider(cursor?: string): Promise<BrowserProviderSnapshot> {
    const lease = requireProviderLease();
    const wire = validateProviderMessage({
      type: 'provider_heartbeat',
      requestId: cloudAgentSdkRuntime.randomUUID(),
      providerId: lease.providerId,
      generation: lease.generation,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (wire.type !== 'provider_heartbeat')
      throw new BrowserProviderError('invalid_request', false);
    const reply = await requestProvider(wire);
    if (reply.type !== 'provider_snapshot')
      throw new BrowserProviderError('invalid_request', false);
    return reply;
  }

  function renewProviderLease(lease: BrowserProviderLease): void {
    if (providerLeaseTimer !== null) clearTimeout(providerLeaseTimer);
    if (providerHeartbeatTimer !== null) clearTimeout(providerHeartbeatTimer);
    const remaining = Date.parse(lease.leaseExpiresAt) - Date.now();
    if (remaining <= 0) {
      invalidateProvider(new BrowserProviderError('lease_expired', true));
      return;
    }
    providerLease = lease;
    providerLeaseTimer = setTimeout(
      () => invalidateProvider(new BrowserProviderError('lease_expired', true)),
      remaining
    );
    providerHeartbeatTimer = setTimeout(
      () => {
        providerHeartbeatTimer = null;
        void heartbeatBrowserProvider().catch(() => {});
      },
      Math.max(1, Math.floor(remaining / 2))
    );
    setProviderState({ status: 'registered', lease });
  }

  function matchesProviderJob(left: BrowserJobHandle, right: BrowserJobHandle): boolean {
    return (
      left.providerId === right.providerId &&
      left.browserTaskId === right.browserTaskId &&
      left.jobId === right.jobId &&
      left.invocationId === right.invocationId
    );
  }

  function sendProviderUpdate(input: BrowserProviderOutboundMessage): void {
    const wire = validateProviderMessage(input);
    if (
      wire.type === 'provider_register' ||
      wire.type === 'provider_heartbeat' ||
      wire.type === 'provider_status'
    )
      throw new BrowserProviderError('invalid_request', false);
    if (
      wire.type === 'provider_unavailable' &&
      wire.providerId === providerRegistration?.providerId &&
      wire.generation === providerRegistration.generation
    ) {
      // Keep the owner's disable intent even if this socket cannot deliver it.
      providerRegistration = null;
      if (!providerLease) invalidateProvider(new BrowserProviderError(wire.reason, false));
    }
    requireProviderSocket();
    const binding = wire.type === 'provider_quiesced' ? providerBinding : requireProviderLease();
    if (
      !binding ||
      wire.providerId !== binding.providerId ||
      wire.generation !== binding.generation
    )
      throw new BrowserProviderError('owner_mismatch', false);
    if (wire.type !== 'provider_unavailable') {
      const job = providerSnapshots.get(wire.jobId);
      if (!job || !matchesProviderJob(job, wire) || job.generation !== wire.generation)
        throw new BrowserProviderError('owner_mismatch', false);
      if (wire.type === 'provider_approval' || wire.type === 'provider_result') {
        if (
          !dispatchedProviderJobs.has(wire.jobId) ||
          cancelledProviderJobs.has(wire.jobId) ||
          job.status !== (wire.type === 'provider_approval' ? 'awaiting_approval' : 'running')
        )
          throw new BrowserProviderError('invalid_request', false);
      }
      if (wire.type === 'provider_result') {
        const tab = job.approvedTab;
        if (
          !tab ||
          tab.tabId !== wire.tab.tabId ||
          tab.title !== wire.tab.title ||
          tab.url !== wire.tab.url ||
          tab.effectiveMode !== wire.tab.effectiveMode
        )
          throw new BrowserProviderError('invalid_request', false);
      }
      if (
        wire.type === 'provider_quiesced' &&
        ((!job.result && !cancelledProviderJobs.has(job.jobId)) ||
          (job.approvedTab && job.approvedTab.tabId !== wire.tabId))
      )
        throw new BrowserProviderError('invalid_request', false);
    }
    sendProviderWire(wire);
    if (wire.type === 'provider_unavailable') {
      providerRegistration = null;
      invalidateProvider(new BrowserProviderError(wire.reason, false));
    }
  }

  function emitProviderMessage(message: BrowserProviderInboundMessage, epoch: number): void {
    for (const listener of providerListeners) {
      if (
        destroyed ||
        !hasLifetime() ||
        !currentWs ||
        !providerNegotiated ||
        epoch !== providerEpoch
      )
        break;
      listener(message);
    }
  }

  function handleProviderMessage(message: BrowserProviderInboundMessage): void {
    if (!providerNegotiated || !currentWs || destroyed || !hasLifetime()) return;
    const epoch = providerEpoch;
    switch (message.type) {
      case 'provider_lease_ack': {
        const pending = pendingProviderRequests.get(message.requestId);
        if (
          !pending ||
          pending.wire.type === 'provider_status' ||
          pending.acknowledged ||
          message.providerId !== pending.wire.providerId
        )
          return;
        const registering = pending.wire.type === 'provider_register';
        if (
          registering
            ? message.generation <= pending.wire.generation
            : message.generation !== providerLease?.generation ||
              message.generation !== pending.wire.generation
        )
          return;
        // A suspended timer cannot turn a late heartbeat into renewed execution authority.
        if (
          !registering &&
          providerLease &&
          Date.parse(providerLease.leaseExpiresAt) <= Date.now()
        ) {
          invalidateProvider(new BrowserProviderError('lease_expired', true));
          return;
        }
        if (registering) {
          providerBinding = { providerId: message.providerId, generation: message.generation };
          providerSnapshots.clear();
          dispatchedProviderJobs.clear();
          cancelledProviderJobs.clear();
          if (providerRegistration) providerRegistration.generation = message.generation;
        }
        pending.acknowledged = true;
        renewProviderLease(message);
        if (epoch !== providerEpoch || !providerLease) return;
        if (registering) finishProviderRequest(message.requestId, message);
        emitProviderMessage(message, epoch);
        return;
      }
      case 'provider_status_result': {
        const pending = pendingProviderRequests.get(message.requestId);
        if (
          !pending ||
          pending.wire.type !== 'provider_status' ||
          message.providerId !== pending.wire.providerId
        )
          return;
        // History never enters the live snapshot cache or changes execution authority.
        finishProviderRequest(message.requestId, message);
        emitProviderMessage(message, epoch);
        return;
      }
      case 'provider_snapshot': {
        if (
          message.providerId !== providerBinding?.providerId ||
          message.generation !== providerBinding.generation
        )
          return;
        if (message.requestId) {
          const pending = pendingProviderRequests.get(message.requestId);
          if (!pending || pending.wire.type !== 'provider_heartbeat' || !pending.acknowledged)
            return;
        }
        if (providerLease && Date.parse(providerLease.leaseExpiresAt) <= Date.now()) {
          invalidateProvider(new BrowserProviderError('lease_expired', true));
          return;
        }
        const jobs = message.jobs.filter(job => {
          if (job.status === 'running' && !providerLease) return false;
          const previous = providerSnapshots.get(job.jobId);
          if (
            previous &&
            (!matchesProviderJob(previous, job) ||
              (previous.result && previous.status !== job.status) ||
              (previous.status === 'running' &&
                (job.status === 'queued' || job.status === 'awaiting_approval')))
          )
            return false;
          providerSnapshots.set(job.jobId, job);
          return true;
        });
        const snapshot = { ...message, jobs };
        if (message.requestId) finishProviderRequest(message.requestId, snapshot);
        emitProviderMessage(snapshot, epoch);
        return;
      }
      case 'provider_job': {
        if (
          message.job.providerId !== providerLease?.providerId ||
          message.job.generation !== providerLease.generation
        )
          return;
        if (Date.parse(providerLease.leaseExpiresAt) <= Date.now()) {
          invalidateProvider(new BrowserProviderError('lease_expired', true));
          return;
        }
        const job = message.job;
        const previous = providerSnapshots.get(job.jobId);
        if (
          dispatchedProviderJobs.has(job.jobId) ||
          cancelledProviderJobs.has(job.jobId) ||
          (previous &&
            (!matchesProviderJob(previous, job) ||
              (previous.status !== 'queued' && previous.status !== 'awaiting_approval')))
        )
          return;
        providerSnapshots.set(job.jobId, job);
        dispatchedProviderJobs.add(job.jobId);
        emitProviderMessage(message, epoch);
        return;
      }
      case 'provider_job_cancel': {
        if (
          message.providerId !== providerBinding?.providerId ||
          message.generation !== providerBinding.generation ||
          cancelledProviderJobs.has(message.jobId)
        )
          return;
        const job = providerSnapshots.get(message.jobId);
        if (job && !matchesProviderJob(job, message)) return;
        cancelledProviderJobs.add(message.jobId);
        const leaseLost =
          message.reason === 'lease_expired' ||
          message.reason === 'provider_lost' ||
          message.reason === 'provider_unavailable' ||
          message.reason === 'effects_uncertain' ||
          message.reason === 'approval_timeout' ||
          message.reason === 'execution_timeout' ||
          message.reason === 'invocation_expired' ||
          (message.reason === 'cancelled' && job?.approvedTab !== undefined);
        if (leaseLost) {
          invalidateProvider(
            new BrowserProviderError(message.reason, message.reason !== 'effects_uncertain')
          );
        }
        emitProviderMessage(message, leaseLost ? epoch + 1 : epoch);
        return;
      }
      default: {
        const exhaustive: never = message;
        return exhaustive;
      }
    }
  }

  function hasLifetime(): boolean {
    return retainCount > 0;
  }

  function sendWire(value: unknown): void {
    if (!currentWs || currentWs.readyState !== WebSocket.OPEN) return;
    currentWs.send(JSON.stringify(value));
  }

  function sendSubscribe(sessionId: string): void {
    sendWire({ type: 'subscribe', sessionId });
  }

  function sendUnsubscribe(sessionId: string): void {
    sendWire({ type: 'unsubscribe', sessionId });
  }

  function clearPongTimeout(): void {
    if (pongTimeout !== null) {
      clearTimeout(pongTimeout);
      pongTimeout = null;
    }
    outstandingPingNonce = null;
  }

  function clearLiveness(): void {
    if (pingInterval !== null) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
    clearPongTimeout();
  }

  function clearInitialAuthRetry(): void {
    if (initialAuthRetryTimeout !== null) {
      clearTimeout(initialAuthRetryTimeout);
      initialAuthRetryTimeout = null;
    }
    initialAuthRetryAttempt = 0;
  }

  function scheduleInitialAuthRetry(expectedGeneration: number): void {
    if (destroyed || !hasLifetime() || expectedGeneration !== generation) return;

    const exponentialDelay = Math.min(
      INITIAL_AUTH_RETRY_CAP_MS,
      INITIAL_AUTH_RETRY_BASE_MS * Math.pow(2, initialAuthRetryAttempt)
    );
    const delay = Math.floor(exponentialDelay * (0.5 + Math.random()));
    initialAuthRetryAttempt += 1;
    initialAuthRetryTimeout = setTimeout(() => {
      initialAuthRetryTimeout = null;
      if (destroyed || !hasLifetime() || expectedGeneration !== generation) return;
      startConnection(false);
    }, delay);
  }

  function requestPreSocketRecovery(): void {
    if (destroyed || !hasLifetime() || baseConnection || started || connectPromise) return;
    if (initialAuthRetryTimeout !== null) {
      clearTimeout(initialAuthRetryTimeout);
      initialAuthRetryTimeout = null;
    }
    startConnection(false);
  }

  function addPreSocketLifecycleListeners(): void {
    if (!config.lifecycleHooks || preSocketLifecycleRegistered || baseConnection) return;
    preSocketLifecycleRegistered = true;
    if (config.lifecycleHooks.onVisibilityChange) {
      preSocketLifecycleCleanupFns.push(
        config.lifecycleHooks.onVisibilityChange(requestPreSocketRecovery, () => {})
      );
    }
    if (config.lifecycleHooks.onPageshow) {
      preSocketLifecycleCleanupFns.push(
        config.lifecycleHooks.onPageshow(event => {
          if (event.persisted) requestPreSocketRecovery();
        })
      );
    }
    if (config.lifecycleHooks.onOnline) {
      preSocketLifecycleCleanupFns.push(config.lifecycleHooks.onOnline(requestPreSocketRecovery));
    }
  }

  function removePreSocketLifecycleListeners(): void {
    for (const cleanup of preSocketLifecycleCleanupFns) cleanup();
    preSocketLifecycleCleanupFns.length = 0;
    preSocketLifecycleRegistered = false;
  }

  function replaceUnresponsiveSocket(): void {
    if (destroyed || !hasLifetime()) return;
    clearPongTimeout();
    currentWs = null;
    baseConnection?.reconnectWithRefreshedAuth?.();
  }

  function sendPing(): void {
    if (destroyed || !hasLifetime() || outstandingPingNonce !== null) return;
    if (!currentWs || currentWs.readyState !== WebSocket.OPEN) return;

    const nonce = cloudAgentSdkRuntime.randomUUID();
    outstandingPingNonce = nonce;
    sendWire({
      type: 'ping',
      nonce,
      ...(browserProviderEnabled ? { capabilities: { browserJobsV1: true } } : {}),
    });
    pongTimeout = setTimeout(replaceUnresponsiveSocket, VIEWER_PONG_TIMEOUT_MS);
  }

  function startLiveness(): void {
    clearLiveness();
    if (!hasLifetime()) return;
    pingInterval = setInterval(sendPing, VIEWER_PING_INTERVAL_MS);
  }

  function rejectPending(message: string): void {
    for (const waiter of pendingOpenWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
      pendingOpenWaiters.delete(waiter);
    }
    for (const [id, pending] of pendingCommands) {
      clearTimeout(pending.timer);
      pendingCommands.delete(id);
      pending.reject(new Error(message));
    }
  }

  function resolveOpenWaiters(ws: WebSocket): void {
    for (const waiter of pendingOpenWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(ws);
      pendingOpenWaiters.delete(waiter);
    }
  }

  function retainConnection(): () => void {
    if (destroyed) return () => {};
    retainCount += 1;
    if (retainCount === 1) {
      addPreSocketLifecycleListeners();
      startConnection();
    }

    let released = false;
    return () => {
      if (released || destroyed) return;
      released = true;
      retainCount -= 1;
      if (retainCount === 0) stopConnection('Connection disconnected');
    };
  }

  function waitForOpen(): Promise<WebSocket> {
    if (destroyed) return Promise.reject(new Error('Connection destroyed'));
    if (currentWs && currentWs.readyState === WebSocket.OPEN) return Promise.resolve(currentWs);
    if (!started && !connectPromise) return Promise.reject(new Error('Failed to get auth token'));
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          pendingOpenWaiters.delete(waiter);
          reject(new Error('WebSocket is not connected'));
        }, COMMAND_TIMEOUT_MS),
      };
      pendingOpenWaiters.add(waiter);
    });
  }

  function handleInboundMessage(msg: WebInboundWithBrowserMessage): void {
    if (destroyed || !hasLifetime() || !currentWs) return;
    switch (msg.type) {
      case 'pong': {
        if (msg.nonce !== outstandingPingNonce) return;
        clearPongTimeout();
        if (!browserProviderEnabled) return;
        const supported = normalizedBrowserCapabilitiesSchema.parse(msg.capabilities).browserJobsV1;
        if (!supported) {
          providerNegotiated = false;
          invalidateProvider(new BrowserProviderError('unsupported', false));
        } else if (!providerNegotiated) {
          providerNegotiated = true;
          setProviderState({ status: 'ready' });
          if (providerRegistration && providerNegotiated && hasLifetime() && !destroyed) {
            void registerBrowserProvider(providerRegistration).catch(() => {});
          }
        }
        return;
      }
      case 'event':
        for (const key of [msg.sessionId, msg.parentSessionId]) {
          if (!key) continue;
          for (const listener of cliListeners.get(key) ?? []) listener(msg);
        }
        return;
      case 'system': {
        for (const listener of systemListeners) listener(msg);
        const parsed = sessionEventPayloadSchema.safeParse({ type: msg.event, data: msg.data });
        if (parsed.success) {
          for (const listener of sessionListeners.get(parsed.data.type) ?? []) {
            listener(parsed.data.data as never);
          }
        }
        return;
      }
      case 'response': {
        const providerRequest = pendingProviderRequests.get(msg.id);
        if (providerRequest) {
          const parsed = browserProviderErrorSchema.safeParse(msg.error);
          const error = parsed.success
            ? new BrowserProviderError(parsed.data.code, parsed.data.retryable)
            : new BrowserProviderError('invalid_request', false);
          if (providerRequest.wire.type === 'provider_status') rejectProviderRequest(msg.id, error);
          else invalidateProvider(error);
          return;
        }
        const pending = pendingCommands.get(msg.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingCommands.delete(msg.id);
        if (msg.error) pending.reject(parseCommandError(msg.error));
        else pending.resolve(msg.result);
        return;
      }
      case 'provider_lease_ack':
      case 'provider_snapshot':
      case 'provider_status_result':
      case 'provider_job':
      case 'provider_job_cancel':
        handleProviderMessage(msg);
        return;
      default: {
        const exhaustive: never = msg;
        return exhaustive;
      }
    }
  }

  function createLifecycleHooks(): ConnectionLifecycleHooks | undefined {
    const lifecycleHooks = config.lifecycleHooks;
    if (!lifecycleHooks) return undefined;
    return {
      onVisibilityChange: lifecycleHooks.onVisibilityChange
        ? (onResume, onHidden) =>
            lifecycleHooks.onVisibilityChange?.(() => {
              onResume();
              sendPing();
            }, onHidden) ?? (() => {})
        : undefined,
      onPageshow: lifecycleHooks.onPageshow,
      onOnline: lifecycleHooks.onOnline
        ? handler =>
            lifecycleHooks.onOnline?.(() => {
              handler();
              sendPing();
            }) ?? (() => {})
        : undefined,
    };
  }

  function buildUrl(): string {
    const url = new URL(config.websocketUrl);
    url.searchParams.set('ticket', token);
    url.searchParams.set('connectionId', connectionId);
    return url.toString();
  }

  function ensureBaseConnection(): void {
    if (baseConnection) return;
    removePreSocketLifecycleListeners();
    hasEverOpened = false;
    const expectedGeneration = generation;
    baseConnection = createBaseConnection<WebInboundWithBrowserMessage>({
      lifecycleHooks: createLifecycleHooks(),
      maxReconnectAttempts: config.maxReconnectAttempts,
      onReconnectExhaustionChange: setExhausted,
      buildUrl,
      parseMessage: (data: unknown) => {
        if (typeof data !== 'string') return null;
        try {
          const parsed: unknown = JSON.parse(data);
          const schema =
            browserProviderEnabled && providerNegotiated
              ? webInboundWithBrowserMessageSchema
              : webInboundMessageSchema;
          const result = schema.safeParse(parsed);
          if (!result.success) return null;
          return { type: 'event', payload: result.data };
        } catch {
          return null;
        }
      },
      onEvent: handleInboundMessage,
      onOpen: ws => {
        if (
          destroyed ||
          expectedGeneration !== generation ||
          !hasLifetime() ||
          ws.readyState !== WebSocket.OPEN
        )
          return;
        hasEverOpened = true;
        currentWs = ws;
        resolveOpenWaiters(ws);
        for (const sessionId of subscriptionCounts.keys()) sendSubscribe(sessionId);
        startLiveness();
        if (browserProviderEnabled) {
          setProviderState({ status: 'negotiating' });
          sendPing();
        }
      },
      onConnected: () => {
        setConnected(true);
      },
      onReconnected: () => {
        setConnected(true);
        config.onReconnect?.();
        for (const listener of reconnectListeners) listener();
      },
      onReplacingConnection: () => {
        invalidateProvider(new BrowserProviderError('disconnected', true), true);
        if (browserProviderEnabled) {
          clearLiveness();
          setConnected(false);
        }
        rejectPending('Connection lost during reconnect');
      },
      onDisconnected: () => {
        currentWs = null;
        clearLiveness();
        invalidateProvider(new BrowserProviderError('disconnected', true), true);
        setConnected(false);
      },
      onUnexpectedDisconnect: () => {
        invalidateProvider(new BrowserProviderError('disconnected', true), true);
        if (browserProviderEnabled) clearLiveness();
        rejectPending('Connection lost during reconnect');
        setConnected(false);
      },
      onError: config.onError,
      isAuthFailure: event => event.code === 4001 || event.code === 1008,
      // The ingest ticket is one-use (consumed at the `/api/user/web` upgrade).
      // Refresh it before a reconnect so a non-auth-failure close (e.g. 1006)
      // does not retry with an already-consumed ticket and loop forever. The
      // initial connect already mints a fresh ticket in `startConnection`, so
      // `hasEverOpened` (set on first `onOpen`) scopes the refresh to reconnects.
      shouldRefreshAuthBeforeConnect: () => hasEverOpened,
      refreshAuth: async () => {
        if (browserProviderEnabled) {
          invalidateProvider(new BrowserProviderError('disconnected', true), true);
          clearLiveness();
          setConnected(false);
          token = '';
        }
        try {
          const refreshed = await config.getAuthToken();
          if (
            !browserProviderEnabled ||
            (!destroyed && expectedGeneration === generation && hasLifetime())
          )
            token = refreshed;
        } catch (error) {
          // The base connection logs refresh failures. Never pass it a proof-bearing error.
          if (browserProviderEnabled) throw new Error('Failed to get auth token');
          throw error;
        }
      },
    });
  }

  function startConnection(newLifetime = true): void {
    if (destroyed || started || connectPromise) return;

    started = true;
    if (newLifetime) {
      generation += 1;
      clearInitialAuthRetry();
    }
    const expectedGeneration = generation;

    const openWithToken = (value: string): void => {
      if (!started || destroyed || !hasLifetime() || expectedGeneration !== generation) return;
      clearInitialAuthRetry();
      token = value;
      ensureBaseConnection();
      baseConnection?.connect();
    };
    const rejectAuthFailure = (): void => {
      if (expectedGeneration !== generation) return;
      started = false;
      invalidateProvider(new BrowserProviderError('provider_unavailable', true));
      rejectPending('Failed to get auth token');
      config.onError?.('Failed to get auth token');
      scheduleInitialAuthRetry(expectedGeneration);
    };

    try {
      const tokenResult = config.getAuthToken();
      if (typeof tokenResult === 'string') {
        openWithToken(tokenResult);
        return;
      }

      connectPromise = tokenResult.then(openWithToken, rejectAuthFailure).finally(() => {
        if (expectedGeneration === generation) connectPromise = null;
      });
    } catch {
      rejectAuthFailure();
    }
  }

  function stopConnection(message: string): void {
    generation += 1;
    connectPromise = null;
    started = false;
    currentWs = null;
    clearLiveness();
    clearInitialAuthRetry();
    removePreSocketLifecycleListeners();
    invalidateProvider(new BrowserProviderError('disconnected', true), true);
    rejectPending(message);
    baseConnection?.destroy();
    baseConnection = null;
    // `base-connection.destroy()` deliberately emits no `onDisconnected`
    // callback, so the wrapper must drive the disconnected transition itself
    // before the next `startConnection()` reopens from a false baseline.
    setConnected(false);
    setExhausted(false);
  }

  function connect(): void {
    if (destroyed || legacyRetained) return;
    legacyRetained = true;
    retainConnection();
  }

  type RawCommandWire = {
    command: string;
    data: unknown;
    connectionId?: string;
    sessionId?: string;
    // Stable intent id forwarded to the relay for durable dedupe (D8).
    // Absent on legacy paths that do not re-issue; the relay falls back to
    // a per-wire random correlation id.
    mutationId?: string;
  };

  /**
   * Shared private sender for both `sendCommand` and `sendCommandToConnection`.
   * Owns the command-scoped connection retain, the pending-commands map
   * entry, and the 30s timeout — so the two public entry points only differ in
   * the wire shape (`sessionId` present vs omitted). `connectionId` is always
   * serialized; the relay tolerates it without a `sessionId`.
   */
  function sendRawCommand(wire: RawCommandWire): Promise<unknown> {
    const hasOwnerLifetime = retainCount > commandRetainCount;
    const releaseCommandLifetime = hasOwnerLifetime ? null : retainConnection();
    if (releaseCommandLifetime) commandRetainCount += 1;
    let commandLifetimeReleased = false;
    const releaseLifetime = () => {
      if (commandLifetimeReleased) return;
      commandLifetimeReleased = true;
      if (releaseCommandLifetime) {
        commandRetainCount -= 1;
        releaseCommandLifetime();
      }
    };

    return new Promise((resolve, reject) => {
      const resolveCommand = (value: unknown) => {
        releaseLifetime();
        resolve(value);
      };
      const rejectCommand = (reason: Error) => {
        releaseLifetime();
        reject(reason);
      };
      void waitForOpen().then(
        ws => {
          if (destroyed || !hasLifetime() || ws.readyState !== WebSocket.OPEN) {
            rejectCommand(
              new Error(destroyed ? 'Connection destroyed' : 'Connection disconnected')
            );
            return;
          }

          const id = cloudAgentSdkRuntime.randomUUID();
          const timer = setTimeout(() => {
            pendingCommands.delete(id);
            rejectCommand(new Error('Command timed out'));
          }, COMMAND_TIMEOUT_MS);
          pendingCommands.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
          ws.send(
            JSON.stringify({
              type: 'command',
              id,
              command: wire.command,
              ...(wire.sessionId ? { sessionId: wire.sessionId } : {}),
              ...(wire.connectionId ? { connectionId: wire.connectionId } : {}),
              ...(wire.mutationId ? { mutationId: wire.mutationId } : {}),
              data: wire.data,
            })
          );
        },
        reason => {
          rejectCommand(reason instanceof Error ? reason : new Error('WebSocket is not connected'));
        }
      );
    });
  }

  return {
    getBrowserProviderState: () => providerState,
    onBrowserProviderStateChange(listener) {
      if (destroyed) return () => {};
      providerStateListeners.add(listener);
      return () => {
        providerStateListeners.delete(listener);
      };
    },
    onBrowserProviderMessage(listener) {
      if (destroyed) return () => {};
      providerListeners.add(listener);
      return () => {
        providerListeners.delete(listener);
      };
    },
    registerBrowserProvider,
    heartbeatBrowserProvider,
    requestBrowserProviderStatus,
    approveBrowserProviderJob: input => sendProviderUpdate({ ...input, type: 'provider_approval' }),
    cancelBrowserProviderJob: input => sendProviderUpdate({ ...input, type: 'provider_cancel' }),
    sendBrowserProviderResult: input => sendProviderUpdate({ ...input, type: 'provider_result' }),
    quiesceBrowserProviderJob: input => sendProviderUpdate({ ...input, type: 'provider_quiesced' }),
    markBrowserProviderUnavailable: input =>
      sendProviderUpdate({ ...input, type: 'provider_unavailable' }),
    retain: retainConnection,
    connect,
    disconnect() {
      if (!legacyRetained || destroyed) return;
      legacyRetained = false;
      retainCount -= 1;
      if (retainCount === 0) stopConnection('Connection disconnected');
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      legacyRetained = false;
      retainCount = 0;
      commandRetainCount = 0;
      stopConnection('Connection destroyed');
      providerRegistration = null;
      providerListeners.clear();
      providerStateListeners.clear();
      subscriptionCounts.clear();
      cliListeners.clear();
      systemListeners.clear();
      reconnectListeners.clear();
      sessionListeners.clear();
      connectionChangeListeners.clear();
      exhaustionChangeListeners.clear();
    },
    isConnected: () => connected,
    onConnectionChange(listener) {
      if (destroyed) return () => {};
      connectionChangeListeners.add(listener);
      return () => {
        connectionChangeListeners.delete(listener);
      };
    },
    isReconnectExhausted: () => exhausted,
    onReconnectExhaustionChange(listener) {
      if (destroyed) return () => {};
      exhaustionChangeListeners.add(listener);
      return () => {
        exhaustionChangeListeners.delete(listener);
      };
    },
    retryConnection() {
      baseConnection?.retryReconnect();
    },
    subscribeToCliSession(sessionId) {
      if (destroyed) return () => {};
      const releaseConnection = retainConnection();
      const current = subscriptionCounts.get(sessionId) ?? 0;
      subscriptionCounts.set(sessionId, current + 1);
      if (current === 0) sendSubscribe(sessionId);
      let released = false;
      return () => {
        if (released || destroyed) return;
        released = true;
        const count = subscriptionCounts.get(sessionId) ?? 0;
        if (count <= 1) {
          subscriptionCounts.delete(sessionId);
          sendUnsubscribe(sessionId);
        } else {
          subscriptionCounts.set(sessionId, count - 1);
        }
        releaseConnection();
      };
    },
    sendCommand(sessionId, command, data, expectedOwnerConnectionId, mutationId) {
      return sendRawCommand({
        command,
        // `expectedOwnerConnectionId` undefined still flows through `connectionId`
        // as a top-level field on the wire (the relay tolerates a `connectionId`
        // without a `sessionId`), so reuse the shared sender.
        ...(expectedOwnerConnectionId ? { connectionId: expectedOwnerConnectionId } : {}),
        sessionId,
        data,
        ...(mutationId ? { mutationId } : {}),
      });
    },
    sendCommandToConnection(input) {
      return sendRawCommand({
        command: input.command,
        connectionId: input.expectedConnectionId,
        data: input.data,
        ...(input.mutationId ? { mutationId: input.mutationId } : {}),
      });
    },
    onCliEvent(sessionId, listener) {
      const listeners = cliListeners.get(sessionId) ?? new Set<(event: CliEvent) => void>();
      listeners.add(listener);
      cliListeners.set(sessionId, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) cliListeners.delete(sessionId);
      };
    },
    onSystemEvent(listener) {
      systemListeners.add(listener);
      return () => systemListeners.delete(listener);
    },
    onReconnect(listener) {
      reconnectListeners.add(listener);
      return () => reconnectListeners.delete(listener);
    },
    onSessionEvent(event, listener) {
      const listeners = sessionListeners.get(event) ?? new Set<(data: never) => void>();
      listeners.add(listener as (data: never) => void);
      sessionListeners.set(event, listeners);
      return () => {
        listeners.delete(listener as (data: never) => void);
        if (listeners.size === 0) sessionListeners.delete(event);
      };
    },
  };
}

export {
  createUserWebConnection,
  BrowserProviderError,
  CommandDeliveredError,
  UserWebCommandError,
};
export type {
  BrowserProviderApprovalInput,
  BrowserProviderCancelInput,
  BrowserProviderConnection,
  BrowserProviderErrorCode,
  BrowserProviderLease,
  BrowserProviderQuiescenceInput,
  BrowserProviderRegistration,
  BrowserProviderResultInput,
  BrowserProviderSnapshot,
  BrowserProviderState,
  BrowserProviderStatusResult,
  BrowserProviderUnavailableInput,
  SendCommandToConnectionInput,
  UserWebConnection,
  UserWebConnectionConfig,
  UserWebSessionEventName,
  UserWebSessionEventData,
  SessionEventPayload,
  CliEvent as UserWebCliEvent,
  SystemEvent as UserWebSystemEvent,
};
