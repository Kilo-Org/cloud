import type { WrapperKiloClient } from './kilo-api.js';
import { kiloServerStartupError } from './bootstrap-error.js';
import { decideKiloRuntimeStart } from './kilo-runtime-start.js';

export type KiloRuntimeStartInput = {
  workspacePath: string;
  expectedSessionId?: string;
  forceRestart?: boolean;
};

export type KiloRuntimeLifecycle = {
  start(input: KiloRuntimeStartInput): Promise<void>;
  updateEnvironment(env: Record<string, string>): Promise<void>;
  restart(): Promise<void>;
  readonly kiloClient: WrapperKiloClient | undefined;
  readonly runtimeWorkspacePath: string | undefined;
  closeServer(): boolean;
};

type CreateKiloResult = {
  server: { url: string; close: () => void };
  client: unknown;
};

export type KiloRuntimeLifecycleDependencies = {
  createKilo: (opts: {
    hostname: string;
    port: number;
    timeout: number;
  }) => Promise<CreateKiloResult>;
  bindClient: (result: CreateKiloResult, workspacePath: string) => WrapperKiloClient;
  captureEnv: () => NodeJS.Dict<string>;
  getPlatform: () => string | undefined;
  log: (message: string) => void;
  chdir: (workspacePath: string) => void;
  assignProcessEnv: (env: Record<string, string>) => void;
  isShuttingDown: () => boolean;
  getKiloSessionId: () => string;
  applyKiloSessionId: (sessionId: string) => void;
  verifyExistingKiloSession: (
    client: WrapperKiloClient,
    expectedSessionId: string,
    runtime: 'reused' | 'new',
    workspacePath: string
  ) => Promise<void>;
  onBeforeSpawnTeardown: () => Promise<void>;
  onRuntimeStarted: (input: {
    client: WrapperKiloClient;
    workspacePath: string;
    kiloSessionId: string;
  }) => void;
  onRuntimeReady: () => void;
  hasLifecycle: () => boolean;
  hasConnection: () => boolean;
  startupTimeoutMs: number;
  initialWorkspacePath?: string;
};

export function createKiloRuntimeLifecycle(
  deps: KiloRuntimeLifecycleDependencies
): KiloRuntimeLifecycle {
  let kiloClient: WrapperKiloClient | undefined;
  let closeKiloServer: (() => void) | undefined;
  let runtimeWorkspacePath = deps.initialWorkspacePath;
  let runtimeTransitionChain: Promise<unknown> = Promise.resolve();

  function closeServer(): boolean {
    if (!closeKiloServer) return false;
    closeKiloServer();
    closeKiloServer = undefined;
    return true;
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const transition = runtimeTransitionChain.then(operation);
    runtimeTransitionChain = transition.catch(() => {});
    return transition;
  }

  async function doStart(input: KiloRuntimeStartInput): Promise<void> {
    const { workspacePath, expectedSessionId } = input;
    if (deps.isShuttingDown()) throw new Error('Wrapper is shutting down');
    deps.log(
      `startKiloRuntime requested workspacePath=${workspacePath} expectedSessionId=${expectedSessionId ?? '(none)'} currentSessionId=${deps.getKiloSessionId() || '(unset)'} hasClient=${Boolean(kiloClient)} runtimeWorkspacePath=${runtimeWorkspacePath ?? '(unset)'} home=${deps.captureEnv().HOME ?? '(unset)'}`
    );

    const decision = decideKiloRuntimeStart({
      forceRestart: input.forceRestart ?? false,
      hasClient: Boolean(kiloClient),
      runtimeWorkspacePath,
      workspacePath,
    });

    if (decision === 'reuse') {
      const client = kiloClient;
      if (!client) throw new Error('Kilo client is unavailable for runtime reuse');
      if (expectedSessionId && expectedSessionId !== deps.getKiloSessionId()) {
        await deps.verifyExistingKiloSession(client, expectedSessionId, 'reused', workspacePath);
        deps.applyKiloSessionId(expectedSessionId);
        deps.log(`startKiloRuntime reused runtime session rebound sessionId=${expectedSessionId}`);
      } else {
        deps.log(
          `startKiloRuntime reused existing runtime without session rebinding sessionId=${deps.getKiloSessionId() || '(unset)'}`
        );
      }
      deps.onRuntimeReady();
      return;
    }

    deps.log(
      `startKiloRuntime preparing new runtime workspacePath=${workspacePath} previousWorkspacePath=${runtimeWorkspacePath ?? '(unset)'} hadLifecycle=${deps.hasLifecycle()} hadConnection=${deps.hasConnection()} hadServer=${Boolean(closeKiloServer)}`
    );
    await deps.onBeforeSpawnTeardown();
    closeServer();
    kiloClient = undefined;

    deps.chdir(workspacePath);
    deps.log('starting kilo server child process via @kilocode/sdk');
    let nextKiloClient: WrapperKiloClient;
    try {
      const result = await deps.createKilo({
        hostname: '127.0.0.1',
        port: 0,
        timeout: deps.startupTimeoutMs,
      });
      const realKiloServer = result.server;
      deps.log(`kilo server started at ${realKiloServer.url}`);
      nextKiloClient = deps.bindClient(result, workspacePath);
      closeKiloServer = () => realKiloServer.close();
    } catch {
      const startupError = kiloServerStartupError();
      deps.log(`failed to start kilo server: ${startupError.message}`);
      throw startupError;
    }

    let kiloSessionId: string;
    if (expectedSessionId) {
      await deps.verifyExistingKiloSession(nextKiloClient, expectedSessionId, 'new', workspacePath);
      kiloSessionId = expectedSessionId;
      deps.applyKiloSessionId(kiloSessionId);
      deps.log(`verified existing kilo session: ${kiloSessionId}`);
    } else {
      const session = await nextKiloClient.createSession();
      kiloSessionId = session.id;
      deps.applyKiloSessionId(kiloSessionId);
      deps.log(`created kilo session: ${kiloSessionId}`);
    }

    kiloClient = nextKiloClient;
    runtimeWorkspacePath = workspacePath;
    deps.onRuntimeStarted({ client: nextKiloClient, workspacePath, kiloSessionId });
    deps.log(
      `startKiloRuntime runtime ready workspacePath=${workspacePath} kiloSessionId=${kiloSessionId} platform=${deps.getPlatform() ?? '(unset)'} home=${deps.captureEnv().HOME ?? '(unset)'}`
    );
    deps.onRuntimeReady();
  }

  function start(input: KiloRuntimeStartInput): Promise<void> {
    return enqueue(() => doStart(input));
  }

  async function updateEnvironment(env: Record<string, string>): Promise<void> {
    const currentEnv = deps.captureEnv();
    const environmentChanged = Object.entries(env).some(
      ([name, value]) => currentEnv[name] !== value
    );
    deps.assignProcessEnv(env);
    const workspacePath = runtimeWorkspacePath;
    if (!workspacePath) return;
    if (kiloClient && !environmentChanged) return;

    await enqueue(() =>
      doStart({
        workspacePath,
        expectedSessionId: deps.getKiloSessionId() || undefined,
        forceRestart: true,
      })
    );
  }

  async function restart(): Promise<void> {
    const workspacePath = runtimeWorkspacePath;
    if (!workspacePath) return;
    await enqueue(() =>
      doStart({
        workspacePath,
        expectedSessionId: deps.getKiloSessionId() || undefined,
        forceRestart: true,
      })
    );
  }

  return {
    start,
    updateEnvironment,
    restart,
    get kiloClient() {
      return kiloClient;
    },
    get runtimeWorkspacePath() {
      return runtimeWorkspacePath;
    },
    closeServer,
  };
}
