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
  getHeartbeatPayload?: () => unknown;
  isReady?: () => boolean;
};

type SandboxControlEventFeedOptions = {
  signal: AbortSignal;
  open: (signal: AbortSignal) => Promise<{ stream?: AsyncIterable<unknown> }>;
  consume: (stream: AsyncIterable<unknown>) => Promise<void>;
  onUnexpectedClose: (error: unknown) => void;
};

const HEARTBEAT_INTERVAL_MS = 30_000;

export async function startSandboxControlEventFeed(
  options: SandboxControlEventFeedOptions
): Promise<void> {
  const feed = await options.open(options.signal);
  if (!feed.stream) {
    throw new Error('Kilo global event feed is unavailable');
  }

  const iterator = feed.stream[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) {
    throw new Error('Kilo global event feed ended before startup');
  }

  async function* establishedFeed(): AsyncGenerator<unknown> {
    yield first.value;
    while (true) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  }

  void options.consume(establishedFeed()).then(
    () => {
      if (!options.signal.aborted) {
        options.onUnexpectedClose(new Error('Kilo global event feed ended'));
      }
    },
    error => {
      if (!options.signal.aborted) {
        options.onUnexpectedClose(error);
      }
    }
  );
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
  let closed = false;

  function stopHeartbeat(): void {
    if (!heartbeat) return;
    clearInterval(heartbeat);
    heartbeat = null;
  }

  function handleConnected(active: SandboxControlClient): void {
    if (closed || options.isReady?.() === false) return;
    active.sendEvent?.('sandbox.ready', { kiloReady: true, globalFeedAttached: true });
    if (options.getHeartbeatPayload && active.sendEvent) {
      stopHeartbeat();
      active.sendEvent('sandbox.heartbeat', options.getHeartbeatPayload());
      heartbeat = setInterval(() => {
        if (options.isReady?.() === false) {
          stopHeartbeat();
          return;
        }
        active.sendEvent?.('sandbox.heartbeat', options.getHeartbeatPayload?.());
      }, HEARTBEAT_INTERVAL_MS);
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
    onReconnect: () => handleConnected(client),
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
      }
    });

  return client;
}
