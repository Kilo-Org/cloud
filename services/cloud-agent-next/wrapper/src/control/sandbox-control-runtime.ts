import { logToFile, withTimeoutAndAbort } from '../utils.js';
import {
  emitControlDiagnostic,
  type ControlDiagnosticReporter,
} from '../../../src/shared/control-diagnostics.js';
import {
  MAX_SANDBOX_CONTROL_FRAME_BYTES,
  type SandboxHeartbeatPayload,
} from '../../../src/shared/sandbox-control-protocol.js';
import {
  createSandboxControlClient,
  type SandboxControlClient,
  type SandboxControlClientOptions,
  type SandboxControlRequestHandler,
} from './sandbox-control-client';

type ControlEnv = {
  SANDBOX_CONTROL_URL?: string | undefined;
  SANDBOX_CONTROL_CREDENTIAL?: string | undefined;
  PROVIDER_INSTANCE_ID?: string | undefined;
  wrapperInstanceId?: string | undefined;
};

type StartOptions = {
  wrapperVersion: string;
  createClient?: (options: SandboxControlClientOptions) => SandboxControlClient;
  onRequest?: SandboxControlRequestHandler;
  onConnected?: (client: SandboxControlClient) => void;
  onDisconnected?: () => void;
  onEventReceiptFailure?: () => void;
  onEventPublication?: SandboxControlClientOptions['onEventPublication'];
  onReconcile?: (phase: 'drain' | 'ready' | 'commit', deadlineAt: number) => Promise<void> | void;
  getHeartbeatPayload?: () => SandboxHeartbeatPayload;
  sampleHeartbeat?: (signal: AbortSignal) => Promise<void>;
  isReady?: () => boolean;
  onDiagnostic?: ControlDiagnosticReporter;
};

export type KiloFeedRecoveryReason = KiloEventFeedError['reason'];

/**
 * Per-connection hooks the SSE connection layer calls while it owns reconnection.
 * The episode owner (startSandboxControlEventFeed) supplies these; the SDK only
 * reports errors, so the wrapper state supplies the attempt identity.
 */
export type KiloFeedConnectionHooks = {
  /** Allocate a per-attempt abort window and return its composite signal. */
  beginAttempt(): AbortSignal;
  /** Abort only the current GET; leave the lifetime signal live. */
  abortAttempt(): void;
  /** Called once per real fetch, after admission. */
  onGetStart(): void;
  /** Called when the SDK is about to back off because a GET failed. */
  onSseError(error: unknown): void;
  /** Called when SDK backoff ends, before it admits the next GET. */
  onSleepWake(): void;
};

export type KiloFeedConnection = {
  hooks: KiloFeedConnectionHooks;
  /** Remaining recovery GETs for the one SDK generator this snapshot covers. */
  sseMaxRetryAttempts: number;
};

type SandboxControlEventFeedOptions = {
  signal: AbortSignal;
  open: (
    signal: AbortSignal,
    onActivity: () => void,
    onFrame: (frame: string) => void,
    connection: KiloFeedConnection
  ) => Promise<{ stream?: AsyncIterable<unknown> }>;
  consume: (stream: AsyncIterable<unknown>) => Promise<void>;
  deadlineAt?: number;
  onUnexpectedClose: (error: unknown) => void;
  onDiagnostic?: ControlDiagnosticReporter;
  now?: () => number;
  log?: (message: string) => void;
  identity?: { scopeId: string; runtimeId: string; directory?: string };
};

export const SANDBOX_CONTROL_REPORT_INTERVAL_MS = 15_000;
export const KILO_FEED_FRESHNESS_TIMEOUT_MS = 30_000;
export const KILO_CONTROL_REQUEST_TIMEOUT_MS = 10_000;
/** Absolute recovery budget for one feed episode, independent of byte freshness. */
export const KILO_FEED_RECOVERY_DEADLINE_MS = 120_000;
/** Recovery GETs per episode (excluding the pre-episode startup GET); GET 6 is allowed, GET 7 refused. */
export const KILO_FEED_RECOVERY_MAX_ATTEMPTS = 6;

export class KiloEventFeedError extends Error {
  constructor(
    readonly reason: 'feed_stale' | 'feed_reconnected' | 'feed_ended' | 'feed_failed',
    message: string
  ) {
    super(message);
  }
}

export async function withKiloRequestDeadline<T>(
  request: (signal: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  const signal = externalSignal
    ? AbortSignal.any([controller.signal, externalSignal])
    : controller.signal;
  try {
    signal.throwIfAborted();
    return await withTimeoutAndAbort(request(signal), {
      signal,
      timeoutMs: KILO_CONTROL_REQUEST_TIMEOUT_MS,
      timeoutMessage: 'Kilo request timed out',
      abortMessage: 'Kilo request cancelled',
    });
  } finally {
    controller.abort();
  }
}

export function observeKiloFeedResponse(
  response: Response,
  signal: AbortSignal,
  onActivity: () => void,
  onFrame?: (frame: string) => void
): Response {
  if (!response.body) return response;
  let frameBytes = 0;
  let lineBreaks = 0;
  let previousCR = false;
  let frame: number[] = [];
  return new Response(
    response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          signal.throwIfAborted();
          if (chunk.byteLength > 0) onActivity();
          for (const byte of chunk) {
            frameBytes++;
            frame.push(byte);
            if (frameBytes > MAX_SANDBOX_CONTROL_FRAME_BYTES)
              throw new KiloEventFeedError(
                'feed_failed',
                'Kilo event frame exceeds the transport budget'
              );
            if (byte === 13 || byte === 10) {
              if (!(byte === 10 && previousCR)) lineBreaks++;
              previousCR = byte === 13;
              if (lineBreaks >= 2) {
                onFrame?.(new TextDecoder().decode(Uint8Array.from(frame)));
                frameBytes = 0;
                lineBreaks = 0;
                frame = [];
              }
            } else {
              lineBreaks = 0;
              previousCR = false;
            }
          }
          controller.enqueue(chunk);
        },
      }),
      { signal }
    ),
    { status: response.status, statusText: response.statusText, headers: response.headers }
  );
}

function isFeedConnectedEvent(envelope: unknown): boolean {
  return (
    typeof envelope === 'object' &&
    envelope !== null &&
    'payload' in envelope &&
    typeof envelope.payload === 'object' &&
    envelope.payload !== null &&
    'type' in envelope.payload &&
    envelope.payload.type === 'server.connected'
  );
}

function isFeedConnectedFrame(frame: string): boolean {
  for (const line of frame.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    try {
      if (isFeedConnectedEvent(JSON.parse(line.slice('data:'.length).trimStart()))) return true;
    } catch {
      continue;
    }
  }
  return false;
}

export function feedDirectoryName(directory: string): string {
  const trimmed = directory.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

function feedTerminalMessage(
  cause: 'attempts_exhausted' | 'deadline_expired',
  reason: KiloFeedRecoveryReason
): string {
  return cause === 'deadline_expired'
    ? 'Kilo global event feed recovery deadline expired'
    : `Kilo global event feed recovery exhausted (${reason})`;
}

/**
 * Owns the /global/event recovery episode: per-attempt abort windows, the
 * admission-capped GET budget, the absolute episode deadline and the reopen of
 * the SDK generator. The SSE connection layer (the SDK) owns per-GET reconnect
 * and backoff; this function only decides when an episode starts and ends.
 */
export async function startSandboxControlEventFeed(
  options: SandboxControlEventFeedOptions
): Promise<{
  isFresh: () => boolean;
  isRecovering: () => boolean;
  usable: Promise<boolean>;
  close: () => void;
  settled: Promise<void>;
}> {
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const now = options.now ?? Date.now;
  const log = options.log ?? logToFile;
  const identity = options.identity
    ? `scopeId=${options.identity.scopeId} runtimeId=${options.identity.runtimeId}${
        options.identity.directory
          ? ` directory=${feedDirectoryName(options.identity.directory)}`
          : ''
      }`
    : '';
  const logFeed = (fields: string): void =>
    log(`control feed${identity ? ` ${identity}` : ''} ${fields}`);

  const startupDeadlineAt = Math.min(
    options.deadlineAt ?? Infinity,
    now() + KILO_FEED_FRESHNESS_TIMEOUT_MS
  );

  let lastEventAt = now();
  let attemptStartedAt: number | undefined;
  let attemptController: AbortController | undefined;
  let attemptId = 0;
  let gets = 0;
  let terminal = false;
  let closed = false;
  let started = false;
  let eventsReceived = 0;
  let iterator: AsyncIterator<unknown> | undefined;
  let disposed = false;
  let episode: { deadlineAt: number; reason: KiloFeedRecoveryReason } | undefined;

  const usable = Promise.withResolvers<boolean>();
  const settled = Promise.withResolvers<void>();
  let usableSettled = false;

  function settleUsable(value: boolean): void {
    if (usableSettled) return;
    usableSettled = true;
    usable.resolve(value);
  }

  function isFresh(): boolean {
    return !signal.aborted && now() - lastEventAt < KILO_FEED_FRESHNESS_TIMEOUT_MS;
  }

  function isRecovering(): boolean {
    return !signal.aborted && (episode !== undefined || (started && !isFresh()));
  }

  function diagnostic(phase: string, extra?: Record<string, string | number | undefined>): void {
    emitControlDiagnostic(options.onDiagnostic, 'control.feed', {
      phase,
      lastEventAt,
      ageMs: Math.max(0, now() - lastEventAt),
      eventsReceived,
      gets,
      ...extra,
    });
  }

  function feedTiming(): string {
    return `lastEventAt=${lastEventAt} ageMs=${Math.max(0, now() - lastEventAt)}`;
  }

  /** The single owner of the episode's GET budget. */
  function recoveryGetsExhausted(): boolean {
    return gets >= KILO_FEED_RECOVERY_MAX_ATTEMPTS;
  }

  /** The SDK snapshot is only evaluated when the episode still has GETs left. */
  function sdkRetrySnapshot(): number {
    return KILO_FEED_RECOVERY_MAX_ATTEMPTS - gets;
  }

  function beginEpisode(reason: KiloFeedRecoveryReason): void {
    if (episode || signal.aborted) return;
    episode = {
      deadlineAt: now() + KILO_FEED_RECOVERY_DEADLINE_MS,
      reason,
    };
    // The pre-episode startup GET is not part of the recovery budget.
    gets = 0;
    diagnostic('retry_scheduled', { detail: reason });
    logFeed(`phase=recovering reason=${reason} gets=${gets} ${feedTiming()}`);
  }

  function disarmAttempt(): void {
    attemptStartedAt = undefined;
    attemptController = undefined;
  }

  function abortAttempt(): void {
    const current = attemptController;
    disarmAttempt();
    current?.abort();
  }

  const hooks: KiloFeedConnectionHooks = {
    beginAttempt(): AbortSignal {
      if (signal.aborted) return signal;
      if (reportDeadlineIfExpired()) return AbortSignal.abort();
      if (recoveryGetsExhausted()) return AbortSignal.abort();
      gets += 1;
      attemptId += 1;
      attemptStartedAt = now();
      attemptController = new AbortController();
      return AbortSignal.any([signal, attemptController.signal]);
    },
    abortAttempt,
    onGetStart(): void {
      logFeed(`phase=get_start attempt=${attemptId} gets=${gets} ${feedTiming()}`);
    },
    onSseError(error: unknown): void {
      if (signal.aborted || closed) return;
      disarmAttempt();
      const reason = error instanceof KiloEventFeedError ? error.reason : 'feed_failed';
      beginEpisode(reason);
      logFeed(`phase=retry reason=${reason} attempt=${attemptId} gets=${gets} ${feedTiming()}`);
    },
    onSleepWake(): void {
      reportDeadlineIfExpired();
    },
  };

  const onActivity = (): void => {
    if (!signal.aborted) lastEventAt = now();
  };
  const onFrame = (frame: string): void => {
    if (!isFeedConnectedFrame(frame)) settleUsable(true);
  };

  function disposeIterator(): void {
    if (disposed || !iterator) return;
    disposed = true;
    try {
      const returned = iterator.return?.();
      if (returned) void returned.catch(() => undefined);
    } catch {
      // Ignore failed disposal.
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    disarmAttempt();
    clearInterval(watchdog);
    controller.abort();
    settleUsable(false);
    disposeIterator();
    settled.resolve();
  }

  function reportTerminal(
    reason: KiloFeedRecoveryReason,
    cause: 'attempts_exhausted' | 'deadline_expired'
  ): void {
    if (terminal || signal.aborted) return;
    terminal = true;
    clearInterval(watchdog);
    diagnostic('failed', { detail: reason });
    logFeed(`phase=terminal cause=${cause} reason=${reason} gets=${gets} ${feedTiming()}`);
    options.onUnexpectedClose(new KiloEventFeedError(reason, feedTerminalMessage(cause, reason)));
    close();
  }

  function reportDeadlineIfExpired(): boolean {
    if (!episode || now() < episode.deadlineAt) return false;
    reportTerminal(episode.reason, 'deadline_expired');
    return true;
  }

  function next(current: AsyncIterator<unknown>): Promise<IteratorResult<unknown>> {
    if (signal.aborted) return Promise.resolve({ done: true, value: undefined });
    let pending: Promise<IteratorResult<unknown>>;
    try {
      pending = Promise.resolve(current.next());
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (callback: () => void): void => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = (): void => finish(() => resolve({ done: true, value: undefined }));
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(
        result => finish(() => resolve(result)),
        error => finish(() => reject(error))
      );
      if (signal.aborted) onAbort();
    });
  }

  function markEvent(): boolean {
    if (reportDeadlineIfExpired()) return false;
    lastEventAt = now();
    eventsReceived += 1;
    if (episode) {
      diagnostic('reconnected');
      logFeed(`phase=recovered gets=${gets} ${feedTiming()}`);
      episode = undefined;
    }
    gets = 0;
    settleUsable(true);
    return true;
  }

  async function* establishedStream(
    current: AsyncIterator<unknown>,
    first: IteratorResult<unknown>
  ): AsyncGenerator<unknown> {
    try {
      if (!first.done) {
        if (isFeedConnectedEvent(first.value)) onActivity();
        else if (markEvent()) {
          yield first.value;
        } else {
          return;
        }
      }
      while (!signal.aborted) {
        const result = await next(current);
        if (signal.aborted || result.done) return;
        if (isFeedConnectedEvent(result.value)) {
          onActivity();
          continue;
        }
        if (!markEvent()) return;
        yield result.value;
      }
    } finally {
      disposeIterator();
    }
  }

  async function openStream(
    deadlineAt: number
  ): Promise<{ iterator: AsyncIterator<unknown>; first: IteratorResult<unknown> }> {
    const feed = await withTimeoutAndAbort(
      options.open(signal, onActivity, onFrame, {
        hooks,
        sseMaxRetryAttempts: sdkRetrySnapshot(),
      }),
      {
        signal,
        timeoutMs: Math.max(1, deadlineAt - now()),
        timeoutMessage: 'Kilo global event feed startup timed out',
        abortMessage: 'Kilo global event feed cancelled',
      }
    );
    if (!feed.stream) {
      throw new Error('Kilo global event feed is unavailable');
    }
    const streamIterator = feed.stream[Symbol.asyncIterator]();
    const first = await withTimeoutAndAbort(streamIterator.next(), {
      signal,
      timeoutMs: Math.max(1, deadlineAt - now()),
      timeoutMessage: 'Kilo global event feed startup timed out',
      abortMessage: 'Kilo global event feed cancelled',
    });
    return { iterator: streamIterator, first };
  }

  async function consumeCycle(
    current: AsyncIterator<unknown>,
    first: IteratorResult<unknown>
  ): Promise<{ error?: unknown }> {
    iterator = current;
    disposed = false;
    try {
      await options.consume(establishedStream(current, first));
      return {};
    } catch (error) {
      return { error };
    } finally {
      disposeIterator();
    }
  }

  /**
   * The single "attempt failed, maybe reopen" path. Reports terminal when the
   * episode deadline has expired or its GET budget is spent; otherwise returns a
   * fresh iterator/first. An open failure is retried here and never falls
   * through to consuming a previous stream.
   */
  async function reopenOrExhaust(): Promise<
    { iterator: AsyncIterator<unknown>; first: IteratorResult<unknown> } | undefined
  > {
    while (!signal.aborted && !terminal) {
      if (reportDeadlineIfExpired()) return undefined;
      if (recoveryGetsExhausted()) {
        reportTerminal(episode?.reason ?? 'feed_failed', 'attempts_exhausted');
        return undefined;
      }
      try {
        return await openStream(episode?.deadlineAt ?? now());
      } catch (error) {
        if (signal.aborted || terminal) return undefined;
        disarmAttempt();
        beginEpisode(error instanceof KiloEventFeedError ? error.reason : 'feed_failed');
      }
    }
    return undefined;
  }

  async function recoveryLoop(
    initialIterator: AsyncIterator<unknown>,
    initialFirst: IteratorResult<unknown>
  ): Promise<void> {
    let currentIterator = initialIterator;
    let currentFirst = initialFirst;
    while (!signal.aborted && !terminal) {
      const outcome = await consumeCycle(currentIterator, currentFirst);
      disarmAttempt();
      if (signal.aborted || terminal) return;
      const reason: KiloFeedRecoveryReason =
        outcome.error === undefined
          ? 'feed_ended'
          : outcome.error instanceof KiloEventFeedError
            ? outcome.error.reason
            : 'feed_failed';
      beginEpisode(reason);
      const opened = await reopenOrExhaust();
      if (!opened) return;
      currentIterator = opened.iterator;
      currentFirst = opened.first;
    }
  }

  const watchdog = setInterval(() => {
    if (!started || signal.aborted || terminal) return;
    if (reportDeadlineIfExpired()) return;
    if (!isFresh()) {
      if (
        attemptStartedAt !== undefined &&
        now() - attemptStartedAt >= KILO_FEED_FRESHNESS_TIMEOUT_MS
      ) {
        if (!episode) {
          beginEpisode('feed_stale');
          logFeed(`phase=stale attempt=${attemptId} gets=${gets} ${feedTiming()}`);
        }
        diagnostic('stale');
        abortAttempt();
      }
    } else {
      diagnostic('freshness');
    }
  }, 10_000);
  watchdog.unref();

  let first: IteratorResult<unknown>;
  emitControlDiagnostic(options.onDiagnostic, 'control.feed', { phase: 'opening' });
  logFeed('phase=opening');
  try {
    if (now() >= startupDeadlineAt) throw new Error('Kilo feed attempt expired');
    const opened = await openStream(startupDeadlineAt);
    iterator = opened.iterator;
    first = opened.first;
    signal.throwIfAborted();
    if (first.done) throw new Error('Kilo global event feed ended before startup');
  } catch (error) {
    emitControlDiagnostic(options.onDiagnostic, 'control.feed', { phase: 'start_failed' });
    logFeed('phase=start_failed');
    close();
    throw error;
  }

  started = true;
  lastEventAt = now();
  diagnostic('started');
  logFeed(`phase=started gets=${gets}`);

  signal.addEventListener(
    'abort',
    () => {
      clearInterval(watchdog);
      settleUsable(false);
      disposeIterator();
      settled.resolve();
    },
    { once: true }
  );

  void recoveryLoop(iterator, first).catch(() => undefined);

  return { isFresh, isRecovering, usable: usable.promise, close, settled: settled.promise };
}

export function maybeStartSandboxControlClient(
  env: ControlEnv,
  log: (message: string) => void,
  options: StartOptions
): SandboxControlClient | null {
  const url = env.SANDBOX_CONTROL_URL;
  const credential = env.SANDBOX_CONTROL_CREDENTIAL;
  const providerInstanceId = env.PROVIDER_INSTANCE_ID;
  if (!url || !credential || !providerInstanceId) {
    return null;
  }

  const createClient = options.createClient ?? createSandboxControlClient;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let sampling: Promise<void> | undefined;
  let sampleAbort = new AbortController();
  let closed = false;
  let connectedThroughCallback = false;
  let heartbeatSequence = 0;
  let lastSentAt: number | undefined;
  const diagnostic = (phase: string): void =>
    emitControlDiagnostic(options.onDiagnostic, 'control.heartbeat', {
      phase,
      sequence: heartbeatSequence,
      lastSentAt,
      sinceLastSentMs: lastSentAt === undefined ? undefined : Date.now() - lastSentAt,
    });
  // `phase=sent` means `sendEvent` returned, not that the worker received the
  // frame. File logs give the pre-pause send outcome and sequence for E2E
  // correlation; it is not receipt proof.
  const logHeartbeat = (phase: string): void =>
    log(
      `control heartbeat phase=${phase} sequence=${heartbeatSequence} lastSentAt=${lastSentAt ?? 0}`
    );

  function stopHeartbeat(): void {
    sampleAbort.abort();
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    diagnostic('stopped');
  }

  function handleConnectionLost(): void {
    if (closed) return;
    stopHeartbeat();
  }

  function handleDisconnected(): void {
    if (closed) return;
    closed = true;
    stopHeartbeat();
    options.onDisconnected?.();
  }

  function triggerSample(): void {
    const sample = options.sampleHeartbeat;
    if (closed || sampleAbort.signal.aborted || sampling || !sample) return;
    const pending = Promise.resolve().then(() => {
      if (!sampleAbort.signal.aborted) return sample(sampleAbort.signal);
    });
    sampling = pending;
    void pending.then(
      () => {
        if (sampling === pending) sampling = undefined;
      },
      () => {
        if (sampling === pending) sampling = undefined;
        if (!sampleAbort.signal.aborted) log('sandbox control heartbeat sampling failed');
      }
    );
  }

  function sendHeartbeat(active: SandboxControlClient): void {
    if (closed || sampleAbort.signal.aborted) return;
    if (options.isReady?.() === false) {
      stopHeartbeat();
      return;
    }
    if (!options.getHeartbeatPayload) return;
    heartbeatSequence += 1;
    diagnostic('sending');
    logHeartbeat('sending');
    let payload: SandboxHeartbeatPayload;
    try {
      payload = options.getHeartbeatPayload();
    } catch {
      diagnostic('send_threw');
      logHeartbeat('send_threw');
      log('sandbox control heartbeat failed');
      return;
    }
    if (closed) return;
    try {
      if (!active.sendEvent?.('sandbox.heartbeat', payload)) {
        diagnostic('send_failed');
        logHeartbeat('send_failed');
        handleConnectionLost();
      } else {
        lastSentAt = Date.now();
        diagnostic('sent');
        logHeartbeat('sent');
      }
    } catch {
      diagnostic('send_threw');
      logHeartbeat('send_threw');
      handleConnectionLost();
    }
  }

  function handleConnected(active: SandboxControlClient): void {
    if (closed || options.isReady?.() === false) return;
    if (sampleAbort.signal.aborted) sampleAbort = new AbortController();
    if (!active.sendEvent?.('sandbox.ready', { kiloReady: true, globalFeedAttached: true })) {
      handleConnectionLost();
      return;
    }
    sendHeartbeat(active);
    triggerSample();
    if (!closed && !sampleAbort.signal.aborted && options.getHeartbeatPayload) {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        sendHeartbeat(active);
        triggerSample();
      }, SANDBOX_CONTROL_REPORT_INTERVAL_MS);
      heartbeat.unref();
    }
    options.onConnected?.(active);
  }

  const client = createClient({
    url,
    credential,
    providerInstanceId,
    ...(env.wrapperInstanceId ? { wrapperInstanceId: env.wrapperInstanceId } : {}),
    wrapperVersion: options.wrapperVersion,
    log,
    onConnectionLost: handleConnectionLost,
    onReconnectExhausted: handleDisconnected,
    ...(options.onEventReceiptFailure
      ? { onEventReceiptFailure: options.onEventReceiptFailure }
      : {}),
    ...(options.onEventPublication ? { onEventPublication: options.onEventPublication } : {}),
    onConnected: () => {
      connectedThroughCallback = true;
      handleConnected(client);
    },
    ...(options.onReconcile ? { onReconcile: options.onReconcile } : {}),
    ...(options.onRequest ? { onRequest: options.onRequest } : {}),
    ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
  });

  const originalClose = client.close.bind(client);
  client.close = () => {
    closed = true;
    stopHeartbeat();
    originalClose();
  };

  void client
    .connect()
    .then(() => {
      if (!connectedThroughCallback) handleConnected(client);
    })
    .catch(() => {
      if (!closed) {
        log('sandbox control client failed');
        handleDisconnected();
      }
    });

  return client;
}
