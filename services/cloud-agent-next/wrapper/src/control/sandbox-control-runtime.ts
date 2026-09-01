import { withTimeoutAndAbort } from '../utils.js';
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
  getHeartbeatPayload?: () => unknown;
  isReady?: () => boolean;
};

type SandboxControlEventFeedOptions = {
  signal: AbortSignal;
  open: (signal: AbortSignal) => Promise<{ stream?: AsyncIterable<unknown> }>;
  consume: (stream: AsyncIterable<unknown>) => Promise<void>;
  onUnexpectedClose: (error: unknown) => void;
  now?: () => number;
};

const HEARTBEAT_INTERVAL_MS = 30_000;
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
    controller.abort();
    throw error;
  }

  let lastEventAt = now();
  const isFresh = () => !signal.aborted && now() - lastEventAt < KILO_FEED_FRESHNESS_TIMEOUT_MS;
  const fail = (error: unknown): void => {
    if (signal.aborted) return;
    controller.abort();
    options.onUnexpectedClose(error);
  };
  const freshnessTimer = setInterval(() => {
    if (!isFresh())
      fail(new KiloEventFeedError('feed_stale', 'Kilo global event feed stopped responding'));
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
          throw new KiloEventFeedError(
            'feed_reconnected',
            'Kilo global event feed reconnected with a delivery gap'
          );
        }
        lastEventAt = now();
        yield next.value;
      }
    } finally {
      await iterator.return?.();
    }
  }

  void options.consume(establishedFeed()).then(
    () => fail(new KiloEventFeedError('feed_ended', 'Kilo global event feed ended')),
    error => fail(error)
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
  let heartbeat: ReturnType<typeof setTimeout> | null = null;
  let heartbeatInFlight = false;
  let closed = false;

  function stopHeartbeat(): void {
    if (!heartbeat) return;
    clearTimeout(heartbeat);
    heartbeat = null;
  }

  function handleDisconnected(): void {
    if (closed) return;
    closed = true;
    stopHeartbeat();
    options.onDisconnected?.();
  }

  async function sendHeartbeat(active: SandboxControlClient): Promise<void> {
    if (
      closed ||
      heartbeatInFlight ||
      options.isReady?.() === false ||
      !options.getHeartbeatPayload
    )
      return;
    heartbeatInFlight = true;
    try {
      const payload = await options.getHeartbeatPayload();
      if (closed || options.isReady?.() === false) return;
      try {
        if (!active.sendEvent?.('sandbox.heartbeat', payload)) handleDisconnected();
      } catch {
        handleDisconnected();
      }
    } catch {
      if (!closed) log('sandbox control heartbeat failed');
    } finally {
      heartbeatInFlight = false;
      if (!closed && options.isReady?.() !== false) {
        heartbeat = setTimeout(() => {
          heartbeat = null;
          void sendHeartbeat(active);
        }, HEARTBEAT_INTERVAL_MS);
        heartbeat.unref();
      }
    }
  }

  function handleConnected(active: SandboxControlClient): void {
    if (closed || options.isReady?.() === false) return;
    if (!active.sendEvent?.('sandbox.ready', { kiloReady: true, globalFeedAttached: true })) {
      handleDisconnected();
      return;
    }
    if (options.getHeartbeatPayload) {
      stopHeartbeat();
      void sendHeartbeat(active);
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
