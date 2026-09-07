import { withTimeoutAndAbort } from '../utils.js';
import {
  emitControlDiagnostic,
  type ControlDiagnosticReporter,
} from '../../../src/shared/control-diagnostics.js';
import type { SandboxHeartbeatPayload } from '../../../src/shared/sandbox-control-protocol.js';
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
  getHeartbeatPayload?: () => SandboxHeartbeatPayload;
  sampleHeartbeat?: (signal: AbortSignal) => Promise<void>;
  isReady?: () => boolean;
  onDiagnostic?: ControlDiagnosticReporter;
};

type SandboxControlEventFeedOptions = {
  signal: AbortSignal;
  open: (signal: AbortSignal) => Promise<{ stream?: AsyncIterable<unknown> }>;
  consume: (stream: AsyncIterable<unknown>) => Promise<void>;
  onUnexpectedClose: (error: unknown) => void;
  onDiagnostic?: ControlDiagnosticReporter;
  now?: () => number;
};

export const SANDBOX_CONTROL_REPORT_INTERVAL_MS = 15_000;
export const KILO_FEED_FRESHNESS_TIMEOUT_MS = 30_000;
export const KILO_CONTROL_REQUEST_TIMEOUT_MS = 10_000;

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

export async function startSandboxControlEventFeed(
  options: SandboxControlEventFeedOptions
): Promise<{ isFresh: () => boolean }> {
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const now = options.now ?? Date.now;
  let feed: { stream?: AsyncIterable<unknown> };
  let iterator: AsyncIterator<unknown>;
  let first: IteratorResult<unknown>;
  emitControlDiagnostic(options.onDiagnostic, 'control.feed', { phase: 'opening' });
  try {
    feed = await withTimeoutAndAbort(options.open(signal), {
      signal,
      timeoutMs: KILO_FEED_FRESHNESS_TIMEOUT_MS,
      timeoutMessage: 'Kilo global event feed startup timed out',
      abortMessage: 'Kilo global event feed cancelled',
    });
    if (!feed.stream) {
      throw new Error('Kilo global event feed is unavailable');
    }
    iterator = feed.stream[Symbol.asyncIterator]();
    first = await withTimeoutAndAbort(iterator.next(), {
      signal,
      timeoutMs: KILO_FEED_FRESHNESS_TIMEOUT_MS,
      timeoutMessage: 'Kilo global event feed startup timed out',
      abortMessage: 'Kilo global event feed cancelled',
    });
    signal.throwIfAborted();
    if (first.done) {
      throw new Error('Kilo global event feed ended before startup');
    }
  } catch (error) {
    emitControlDiagnostic(options.onDiagnostic, 'control.feed', { phase: 'start_failed' });
    controller.abort();
    throw error;
  }

  let lastEventAt = now();
  let eventsReceived = 1;
  const diagnostic = (phase: string): void =>
    emitControlDiagnostic(options.onDiagnostic, 'control.feed', {
      phase,
      lastEventAt,
      ageMs: Math.max(0, now() - lastEventAt),
      eventsReceived,
    });
  diagnostic('started');
  const isFresh = () => !signal.aborted && now() - lastEventAt < KILO_FEED_FRESHNESS_TIMEOUT_MS;
  const fail = (error: unknown, phase: 'stale' | 'ended' | 'failed'): void => {
    if (signal.aborted) return;
    diagnostic(phase);
    controller.abort();
    options.onUnexpectedClose(error);
  };
  const freshnessTimer = setInterval(() => {
    if (!isFresh())
      fail(
        new KiloEventFeedError('feed_stale', 'Kilo global event feed stopped responding'),
        'stale'
      );
    else diagnostic('freshness');
  }, 10_000);
  freshnessTimer.unref();
  signal.addEventListener('abort', () => clearInterval(freshnessTimer), { once: true });

  async function* establishedFeed(): AsyncGenerator<unknown> {
    try {
      yield first.value;
      while (!signal.aborted) {
        const next = await iterator.next();
        if (signal.aborted || next.done) return;
        if (isFeedConnectedEvent(next.value)) {
          diagnostic('reconnected');
          throw new KiloEventFeedError(
            'feed_reconnected',
            'Kilo global event feed reconnected with a delivery gap'
          );
        }
        lastEventAt = now();
        eventsReceived += 1;
        yield next.value;
      }
    } finally {
      await iterator.return?.();
    }
  }

  void options.consume(establishedFeed()).then(
    () => fail(new KiloEventFeedError('feed_ended', 'Kilo global event feed ended'), 'ended'),
    error => fail(error, 'failed')
  );
  return { isFresh };
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
  const sampleAbort = new AbortController();
  let closed = false;
  let heartbeatSequence = 0;
  let lastSentAt: number | undefined;
  const diagnostic = (phase: string): void =>
    emitControlDiagnostic(options.onDiagnostic, 'control.heartbeat', {
      phase,
      sequence: heartbeatSequence,
      lastSentAt,
      sinceLastSentMs: lastSentAt === undefined ? undefined : Date.now() - lastSentAt,
    });

  function stopHeartbeat(): void {
    sampleAbort.abort();
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    diagnostic('stopped');
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
    let payload: SandboxHeartbeatPayload;
    try {
      payload = options.getHeartbeatPayload();
    } catch {
      diagnostic('send_threw');
      log('sandbox control heartbeat failed');
      return;
    }
    if (closed) return;
    try {
      if (!active.sendEvent?.('sandbox.heartbeat', payload)) {
        diagnostic('send_failed');
        handleDisconnected();
      } else {
        lastSentAt = Date.now();
        diagnostic('sent');
      }
    } catch {
      diagnostic('send_threw');
      handleDisconnected();
    }
  }

  function handleConnected(active: SandboxControlClient): void {
    if (closed || options.isReady?.() === false) return;
    if (!active.sendEvent?.('sandbox.ready', { kiloReady: true, globalFeedAttached: true })) {
      handleDisconnected();
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
    onDisconnected: handleDisconnected,
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
      handleConnected(client);
    })
    .catch(() => {
      if (!closed) {
        log('sandbox control client failed');
        handleDisconnected();
      }
    });

  return client;
}
