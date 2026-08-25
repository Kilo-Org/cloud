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
} & Record<string, string | undefined>;

type StartOptions = {
  wrapperVersion: string;
  createClient?: (options: SandboxControlClientOptions) => SandboxControlClient;
  onRequest?: SandboxControlRequestHandler;
  onConnected?: (client: SandboxControlClient) => void;
  getHeartbeatPayload?: () => unknown;
};

const HEARTBEAT_INTERVAL_MS = 30_000;

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
    if (closed) return;
    active.sendEvent?.('sandbox.ready', { kiloReady: true, globalFeedAttached: true });
    if (options.getHeartbeatPayload && active.sendEvent) {
      stopHeartbeat();
      active.sendEvent('sandbox.heartbeat', options.getHeartbeatPayload());
      heartbeat = setInterval(() => {
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
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'unknown error';
      log(`sandbox control client failed: ${message}`);
    });

  return client;
}
