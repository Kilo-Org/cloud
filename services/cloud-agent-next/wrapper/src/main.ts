/**
 * Long-running wrapper entry point.
 *
 * The wrapper runs as a single control plane inside the sandbox container.
 * It starts the kilo server in-process via `@kilocode/sdk`'s `createKilo()`,
 * then exposes an HTTP API for the Worker to send commands.
 *
 * Configuration:
 * - Session-level: WRAPPER_PORT, WORKSPACE_PATH (env vars at process start)
 * - Session identity: --agent-session, --user-id, --session-id (CLI args at process start)
 * - Execution-level: passed via POST /job/prompt body (per-turn)
 */

import { createKilo } from '@kilocode/sdk';
import { SESSION_ID_RE } from '../../src/shared/protocol.js';
import { WRAPPER_VERSION } from '../../src/shared/wrapper-version.js';
import { WrapperState } from './state.js';
import { createWrapperKiloClient, type WrapperKiloClient } from './kilo-api.js';
import { createConnectionManager, openIngestProgressChannel } from './connection.js';
import { createLifecycleManager } from './lifecycle.js';
import { bindSessionContext, createServer } from './server.js';
import { logToFile } from './utils.js';
import type { WrapperCommand } from '../../src/shared/protocol.js';
import type {
  WrapperSessionReadyRequest,
  WrapperSessionReadyResponse,
} from '../../src/shared/wrapper-bootstrap.js';
import {
  materializePromptAttachments,
  prepareWrapperBootstrapWorkspace,
} from './session-bootstrap.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Grace period before force exit during shutdown (20 seconds) */
const SHUTDOWN_TIMEOUT_MS = 20_000;

/** Timeout for createKilo() server startup */
const KILO_STARTUP_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Environment Variable Parsing
// ---------------------------------------------------------------------------

function getOptionalEnvInt(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    logToFile(`WARNING: Invalid integer for ${name}: ${value}, using default ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

function failStartup(message: string): never {
  logToFile(`ERROR: ${message}`);
  console.error(message);
  process.exit(1);
}

type StartupArgs = {
  agentSessionId: string;
  userId: string;
  sessionId?: string;
  wrapperInstanceId?: string;
  wrapperInstanceGeneration?: number;
};

function parseStartupArgs(argv: string[]): StartupArgs {
  let agentSessionId: string | undefined;
  let userId: string | undefined;
  let sessionId: string | undefined;
  let wrapperInstanceId: string | undefined;
  let wrapperInstanceGeneration: number | undefined;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === '--agent-session') {
      if (!value) {
        failStartup('Missing value for --agent-session');
      }
      agentSessionId = value;
      index++;
      continue;
    }

    if (arg === '--user-id') {
      if (!value) {
        failStartup('Missing value for --user-id');
      }
      userId = value;
      index++;
      continue;
    }

    if (arg === '--session-id') {
      if (!value) {
        failStartup('Missing value for --session-id');
      }
      sessionId = value;
      index++;
      continue;
    }

    if (arg === '--wrapper-instance-id') {
      if (!value) {
        failStartup('Missing value for --wrapper-instance-id');
      }
      wrapperInstanceId = value;
      index++;
      continue;
    }

    if (arg === '--wrapper-instance-generation') {
      if (!value) {
        failStartup('Missing value for --wrapper-instance-generation');
      }
      const generation = Number.parseInt(value, 10);
      if (!Number.isInteger(generation) || generation < 0) {
        failStartup('Invalid value for --wrapper-instance-generation');
      }
      wrapperInstanceGeneration = generation;
      index++;
      continue;
    }

    failStartup(`Unknown argument: ${arg}`);
  }

  if (!agentSessionId) {
    failStartup('Missing required --agent-session argument');
  }

  if (!userId) {
    failStartup('Missing required --user-id argument');
  }

  if ((wrapperInstanceId === undefined) !== (wrapperInstanceGeneration === undefined)) {
    failStartup('Wrapper instance identity requires both id and generation');
  }

  return { agentSessionId, userId, sessionId, wrapperInstanceId, wrapperInstanceGeneration };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  logToFile(`wrapper starting (long-running mode) bun=${Bun.version}`);

  // Parse environment variables and startup args — only session-stable config remains here.
  // Per-execution config (autoCommit, condenseOnComplete, model, upstreamBranch)
  // is now passed in the POST /job/prompt body.
  const wrapperPort = getOptionalEnvInt('WRAPPER_PORT', 5000);
  const initialWorkspacePath = process.env.WORKSPACE_PATH;
  const startupArgs = parseStartupArgs(process.argv.slice(2));
  // New bundles report env-based identity; old bundles safely ignore these rolling-deploy markers.
  const envWrapperInstanceId = process.env.WRAPPER_INSTANCE_ID;
  const envWrapperInstanceGenerationValue = process.env.WRAPPER_INSTANCE_GENERATION;
  let envWrapperInstanceGeneration: number | undefined;
  if (envWrapperInstanceGenerationValue !== undefined) {
    const parsedGeneration = Number.parseInt(envWrapperInstanceGenerationValue, 10);
    if (!Number.isInteger(parsedGeneration) || parsedGeneration < 0) {
      failStartup('Invalid value for WRAPPER_INSTANCE_GENERATION');
    }
    envWrapperInstanceGeneration = parsedGeneration;
  }
  if (
    startupArgs.wrapperInstanceId !== undefined &&
    envWrapperInstanceId !== undefined &&
    startupArgs.wrapperInstanceId !== envWrapperInstanceId
  ) {
    failStartup('Conflicting wrapper instance id configuration');
  }
  if (
    startupArgs.wrapperInstanceGeneration !== undefined &&
    envWrapperInstanceGeneration !== undefined &&
    startupArgs.wrapperInstanceGeneration !== envWrapperInstanceGeneration
  ) {
    failStartup('Conflicting wrapper instance generation configuration');
  }
  const agentSessionId = startupArgs.agentSessionId;
  const userId = startupArgs.userId;
  const configuredSessionId = startupArgs.sessionId;
  const wrapperInstanceId = startupArgs.wrapperInstanceId ?? envWrapperInstanceId;
  const wrapperInstanceGeneration =
    startupArgs.wrapperInstanceGeneration ?? envWrapperInstanceGeneration;
  if ((wrapperInstanceId === undefined) !== (wrapperInstanceGeneration === undefined)) {
    failStartup('Wrapper instance identity requires both id and generation');
  }

  if (!SESSION_ID_RE.test(agentSessionId)) {
    failStartup(`Invalid agent session ID: ${agentSessionId}`);
  }

  // Set log path if not already set
  if (!process.env.WRAPPER_LOG_PATH) {
    process.env.WRAPPER_LOG_PATH = `/tmp/kilocode-wrapper-${Date.now()}.log`;
  }

  logToFile(
    `config: wrapperPort=${wrapperPort} workspacePath=${initialWorkspacePath ?? '(bootstrap)'} agentSessionId=${agentSessionId}`
  );
  if (configuredSessionId) {
    logToFile(`config: sessionId=${configuredSessionId}`);
  }
  if (wrapperInstanceId !== undefined && wrapperInstanceGeneration !== undefined) {
    logToFile(
      `config: wrapperInstanceId=${wrapperInstanceId} wrapperInstanceGeneration=${wrapperInstanceGeneration}`
    );
  }

  // ---------------------------------------------------------------------------
  // Wire up components
  // ---------------------------------------------------------------------------
  const state = new WrapperState();
  let kiloClient: WrapperKiloClient | undefined;
  let kiloSessionId = configuredSessionId ?? '';
  let closeKiloServer: (() => void) | undefined;
  let connectionManager: ReturnType<typeof createConnectionManager> | undefined;
  let lifecycleManager: ReturnType<typeof createLifecycleManager> | undefined;
  let runtimeWorkspacePath = initialWorkspacePath;

  const unavailableKiloClient = new Proxy(
    {},
    {
      get() {
        throw new Error('Kilo server has not been bootstrapped');
      },
    }
  ) as WrapperKiloClient;

  const serverConfig = {
    port: wrapperPort,
    workspacePath: initialWorkspacePath ?? '',
    version: WRAPPER_VERSION,
    sessionId: kiloSessionId,
    agentSessionId,
    userId,
    wrapperInstanceId,
    wrapperInstanceGeneration,
    platform: process.env.KILO_PLATFORM,
  };

  const serverDeps = {
    state,
    kiloClient: unavailableKiloClient,
    openConnection: () => {
      if (!connectionManager) throw new Error('Connection manager is not bootstrapped');
      return connectionManager.open();
    },
    closeConnection: () => connectionManager?.close() ?? Promise.resolve(),
    setAborted: () => lifecycleManager?.setAborted(),
    resetLifecycle: () => lifecycleManager?.reset(),
    onMessageComplete: (messageId: string) => lifecycleManager?.onMessageComplete(messageId),
    readySession: readySession,
    updateRuntimeEnvironment: updateRuntimeEnvironment,
    materializePromptAttachments,
  };

  async function verifyExistingKiloSession(
    client: WrapperKiloClient,
    expectedSessionId: string,
    runtime: 'reused' | 'new',
    workspacePath: string
  ): Promise<void> {
    const lookupStartedAt = Date.now();
    logToFile(
      `post-bootstrap kilo session lookup begin runtime=${runtime} expectedSessionId=${expectedSessionId} currentSessionId=${kiloSessionId || '(unset)'} workspacePath=${workspacePath} runtimeWorkspacePath=${runtimeWorkspacePath ?? '(unset)'} home=${process.env.HOME ?? '(unset)'}`
    );
    try {
      const session = await client.getSession(expectedSessionId);
      logToFile(
        `post-bootstrap kilo session lookup end runtime=${runtime} outcome=ok expectedSessionId=${expectedSessionId} returnedSessionId=${session.id} elapsedMs=${Date.now() - lookupStartedAt}`
      );
    } catch (error) {
      logToFile(
        `post-bootstrap kilo session lookup end runtime=${runtime} outcome=error expectedSessionId=${expectedSessionId} elapsedMs=${Date.now() - lookupStartedAt} error=${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  async function startKiloRuntime(
    workspacePath: string,
    expectedSessionId?: string,
    forceRestart = false
  ): Promise<void> {
    logToFile(
      `startKiloRuntime requested workspacePath=${workspacePath} expectedSessionId=${expectedSessionId ?? '(none)'} currentSessionId=${kiloSessionId || '(unset)'} hasClient=${Boolean(kiloClient)} runtimeWorkspacePath=${runtimeWorkspacePath ?? '(unset)'} home=${process.env.HOME ?? '(unset)'}`
    );
    if (!forceRestart && kiloClient && runtimeWorkspacePath === workspacePath) {
      if (expectedSessionId && expectedSessionId !== kiloSessionId) {
        await verifyExistingKiloSession(kiloClient, expectedSessionId, 'reused', workspacePath);
        kiloSessionId = expectedSessionId;
        serverConfig.sessionId = expectedSessionId;
        logToFile(`startKiloRuntime reused runtime session rebound sessionId=${expectedSessionId}`);
      } else {
        logToFile(
          `startKiloRuntime reused existing runtime without session rebinding sessionId=${kiloSessionId || '(unset)'}`
        );
      }
      return;
    }

    logToFile(
      `startKiloRuntime preparing new runtime workspacePath=${workspacePath} previousWorkspacePath=${runtimeWorkspacePath ?? '(unset)'} hadLifecycle=${Boolean(lifecycleManager)} hadConnection=${Boolean(connectionManager)} hadServer=${Boolean(closeKiloServer)}`
    );
    lifecycleManager?.stop();
    await connectionManager?.close();
    if (closeKiloServer) {
      closeKiloServer();
      closeKiloServer = undefined;
    }
    kiloClient = undefined;
    serverDeps.kiloClient = unavailableKiloClient;

    process.chdir(workspacePath);
    logToFile('starting kilo server in-process via @kilocode/sdk');
    let nextKiloClient: WrapperKiloClient;
    try {
      const result = await createKilo({
        hostname: '127.0.0.1',
        port: 0,
        timeout: KILO_STARTUP_TIMEOUT_MS,
      });
      const realKiloServer = result.server;
      logToFile(`kilo server started at ${realKiloServer.url}`);
      nextKiloClient = createWrapperKiloClient(result.client, realKiloServer.url, workspacePath);
      closeKiloServer = () => realKiloServer.close();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logToFile(`failed to start kilo server: ${msg}`);
      throw new Error(`Failed to start kilo server: ${msg}`);
    }

    if (expectedSessionId) {
      await verifyExistingKiloSession(nextKiloClient, expectedSessionId, 'new', workspacePath);
      kiloSessionId = expectedSessionId;
      logToFile(`verified existing kilo session: ${kiloSessionId}`);
    } else {
      const session = await nextKiloClient.createSession();
      kiloSessionId = session.id;
      logToFile(`created kilo session: ${kiloSessionId}`);
    }

    kiloClient = nextKiloClient;
    serverDeps.kiloClient = nextKiloClient;
    serverConfig.workspacePath = workspacePath;
    serverConfig.sessionId = kiloSessionId;
    serverConfig.platform = process.env.KILO_PLATFORM;
    runtimeWorkspacePath = workspacePath;
    logToFile(
      `startKiloRuntime runtime ready workspacePath=${workspacePath} kiloSessionId=${kiloSessionId} platform=${serverConfig.platform ?? '(unset)'} home=${process.env.HOME ?? '(unset)'}`
    );

    connectionManager = createConnectionManager(
      state,
      { kiloClient: nextKiloClient },
      {
        onMessageComplete: (messageId: string) => {
          lifecycleManager?.onMessageComplete(messageId);
        },
        onTerminalError: (reason: string) => {
          logToFile(`terminal error: ${reason}`);
          state.sendToIngest({
            streamEventType: 'error',
            data: { error: reason, fatal: true },
            timestamp: new Date().toISOString(),
          });
          const session = state.currentSession;
          if (session) {
            nextKiloClient.abortSession({ sessionId: session.kiloSessionId }).catch(() => {});
          }
          lifecycleManager?.setAborted();
          state.clearAllMessages();
          lifecycleManager?.triggerDrainAndClose();
        },
        onCommand: (cmd: WrapperCommand) => {
          logToFile(`command received: ${cmd.type}`);
          if (cmd.type === 'kill') {
            state.sendToIngest({
              streamEventType: 'interrupted',
              data: { reason: 'Session stopped' },
              timestamp: new Date().toISOString(),
            });
            const session = state.currentSession;
            if (session) {
              nextKiloClient.abortSession({ sessionId: session.kiloSessionId }).catch(() => {});
            }
            lifecycleManager?.setAborted();
            state.clearAllMessages();
            lifecycleManager?.triggerDrainAndClose();
          }
          if (cmd.type === 'ping') {
            const session = state.currentSession;
            state.sendToIngest({
              streamEventType: 'pong',
              data: {
                kiloSessionId: session?.kiloSessionId,
                wrapperGeneration: session?.wrapperGeneration,
                wrapperConnectionId: session?.wrapperConnectionId,
              },
              timestamp: new Date().toISOString(),
            });
          }
          if (cmd.type === 'request_snapshot') {
            void connectionManager?.sendKiloSnapshot();
          }
        },
        onDisconnect: (reason: string) => {
          logToFile(`disconnect: ${reason}`);
          state.setLastError({
            code: 'DISCONNECT',
            message: reason,
            timestamp: Date.now(),
          });
          const session = state.currentSession;
          const targetSessionId = session?.kiloSessionId;
          if (targetSessionId) {
            nextKiloClient.abortSession({ sessionId: targetSessionId }).catch(() => {});
          }
          lifecycleManager?.setAborted();
          state.setActive(false);
          lifecycleManager?.triggerDrainAndClose();
        },
        onCompletionSignal: () => {
          lifecycleManager?.signalCompletion();
        },
        onSessionIdle: () => {
          lifecycleManager?.onSessionIdle();
        },
        onRootSessionActivity: () => {
          lifecycleManager?.onRootSessionActivity();
        },
        onReconnecting: (attempt: number) => {
          logToFile(`ingest WS reconnecting: attempt ${attempt}`);
        },
        onReconnected: () => {
          logToFile('ingest WS reconnected');
          lifecycleManager?.onConnectionRestored();
          const lastError = state.getLastError();
          if (lastError?.code === 'DISCONNECT') {
            state.clearLastError();
          }
        },
        onSseEvent: () => {
          lifecycleManager?.onSseEvent();
        },
      }
    );

    lifecycleManager = createLifecycleManager(
      { workspacePath },
      {
        state,
        kiloClient: nextKiloClient,
        closeConnections: () => connectionManager?.close() ?? Promise.resolve(),
        isConnected: () => connectionManager?.isConnected() ?? false,
        reconnectEventSubscription: () => connectionManager?.reconnectEventSubscription(),
      }
    );
    lifecycleManager.start();
  }

  async function updateRuntimeEnvironment(env: Record<string, string>): Promise<void> {
    const environmentChanged = Object.entries(env).some(
      ([name, value]) => process.env[name] !== value
    );
    Object.assign(process.env, env);
    if (runtimeWorkspacePath && (environmentChanged || !kiloClient)) {
      await startKiloRuntime(runtimeWorkspacePath, kiloSessionId || undefined, true);
    }
  }

  async function readySession(
    request: WrapperSessionReadyRequest
  ): Promise<WrapperSessionReadyResponse> {
    const readyStartedAt = Date.now();
    let progressChannel: Awaited<ReturnType<typeof openIngestProgressChannel>> | undefined;
    logToFile(
      `session/ready received agentSessionId=${request.agentSessionId} kiloSessionId=${request.kiloSessionId} preferSnapshot=${request.workspace.preferSnapshot} workspacePath=${request.workspace.workspacePath} sessionHome=${request.workspace.sessionHome} branchName=${request.workspace.branchName} strictBranch=${request.workspace.strictBranch ?? false} repoKind=${request.repo?.kind ?? '(none)'} setupCommandCount=${request.materialized.setupCommands?.length ?? 0} runtimeSkillCount=${request.materialized.runtimeSkills?.length ?? 0} platform=${request.materialized.env.KILO_PLATFORM ?? process.env.KILO_PLATFORM ?? '(unset)'} stateConnected=${state.isConnected}`
    );
    try {
      serverConfig.workspacePath = request.workspace.workspacePath;
      serverConfig.sessionId = request.kiloSessionId;
      serverConfig.platform = request.materialized.env.KILO_PLATFORM ?? process.env.KILO_PLATFORM;

      const bindError = await bindSessionContext(request.session, serverConfig, serverDeps);
      if (bindError) {
        const error = (await bindError.json()) as { error?: string; message?: string };
        logToFile(
          `session/ready binding rejected kiloSessionId=${request.kiloSessionId} status=${bindError.status} message=${error.message ?? error.error ?? 'Invalid session binding'} elapsedMs=${Date.now() - readyStartedAt}`
        );
        return {
          status: 'error',
          error: {
            code: 'INVALID_REQUEST',
            message: error.message ?? error.error ?? 'Invalid session binding',
            retryable: false,
          },
        };
      }

      if (!state.isConnected) {
        progressChannel = await openIngestProgressChannel(state);
      }

      logToFile(
        `session/ready bootstrap workspace starting kiloSessionId=${request.kiloSessionId}`
      );
      await prepareWrapperBootstrapWorkspace(request, (step, message) => {
        state.sendToIngest({
          streamEventType: 'preparing',
          data: { step, message },
          timestamp: new Date().toISOString(),
        });
      });
      logToFile(
        `session/ready bootstrap workspace finished kiloSessionId=${request.kiloSessionId}`
      );

      progressChannel?.close();
      progressChannel = undefined;

      await startKiloRuntime(request.workspace.workspacePath, request.kiloSessionId);
      if (!kiloClient) {
        throw new Error('Kilo server did not start');
      }
      logToFile(
        `session/ready complete kiloSessionId=${request.kiloSessionId} elapsedMs=${Date.now() - readyStartedAt}`
      );

      return {
        status: 'ready',
        kiloSessionId: request.kiloSessionId,
        workspaceReady: {
          workspacePath: request.workspace.workspacePath,
          sandboxId: request.sandboxId,
          sessionHome: request.workspace.sessionHome,
          branchName: request.workspace.branchName,
          kiloSessionId: request.kiloSessionId,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logToFile(
        `session/ready failed kiloSessionId=${request.kiloSessionId} elapsedMs=${Date.now() - readyStartedAt} error=${message}`
      );
      return {
        status: 'error',
        error: {
          code: message.includes('Kilo server') ? 'KILO_SERVER_FAILED' : 'WORKSPACE_SETUP_FAILED',
          message,
          retryable: true,
        },
      };
    } finally {
      progressChannel?.close();
    }
  }

  // Create HTTP server
  if (initialWorkspacePath) {
    await startKiloRuntime(initialWorkspacePath, configuredSessionId);
  }

  const server = createServer(serverConfig, serverDeps, () =>
    lifecycleManager?.triggerDrainAndClose()
  );

  logToFile(
    `wrapper ready on port ${wrapperPort}${
      kiloClient ? ` (kilo server at ${kiloClient.serverUrl})` : ' (awaiting bootstrap)'
    }`
  );
  console.log(`Wrapper listening on port ${wrapperPort}`);

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------
  let isShuttingDown = false;

  async function handleShutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logToFile(`shutdown signal: ${signal}`);
    console.error(`Received ${signal}, shutting down...`);

    // Send interrupted event if connected
    state.sendToIngest({
      streamEventType: 'interrupted',
      data: { reason: `Container shutdown: ${signal}` },
      timestamp: new Date().toISOString(),
    });

    // Stop lifecycle timers
    lifecycleManager?.stop();

    // Force exit after timeout
    setTimeout(() => {
      logToFile('force exit after timeout');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    // Best-effort final log upload
    const uploader = state.logUploader;
    if (uploader) {
      const uploadTimeout = new Promise<void>(resolve => setTimeout(resolve, 5_000));
      await Promise.race([uploader.uploadNow().catch(() => {}), uploadTimeout]);
      uploader.stop();
    }

    // Abort kilo session if running
    const session = state.currentSession;
    if (session && kiloClient) {
      kiloClient.abortSession({ sessionId: session.kiloSessionId }).catch(() => {});
    }

    // Close connections
    void connectionManager?.close();

    // Close kilo server (real or fake)
    try {
      closeKiloServer?.();
      if (closeKiloServer) {
        logToFile('kilo server closed');
      }
    } catch (err) {
      logToFile(`kilo server close error: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Stop HTTP server
    await server.stop();

    // Try graceful exit
    setTimeout(() => {
      logToFile('graceful exit');
      process.exit(0);
    }, 1000);
  }

  process.on('SIGTERM', () => void handleShutdown('SIGTERM'));
  process.on('SIGINT', () => void handleShutdown('SIGINT'));

  // ---------------------------------------------------------------------------
  // Crash handlers — best-effort log upload on unexpected crashes
  // ---------------------------------------------------------------------------
  function handleCrash(label: string, error: unknown): void {
    if (isShuttingDown) return;

    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    logToFile(`${label}: ${message}`);
    console.error(`Wrapper ${label}:`, error);

    const uploader = state.logUploader;
    if (uploader) {
      const timeout = new Promise<void>(resolve => setTimeout(resolve, 5_000));
      void Promise.race([uploader.uploadNow().catch(() => {}), timeout]).finally(() => {
        uploader.stop();
        process.exit(1);
      });
    } else {
      process.exit(1);
    }
  }

  process.on('uncaughtException', err => handleCrash('uncaught exception', err));
  process.on('unhandledRejection', reason => handleCrash('unhandled rejection', reason));
}

main().catch(err => {
  logToFile(`fatal error: ${err instanceof Error ? err.message : String(err)}`);
  console.error('Wrapper fatal error:', err);
  process.exit(1);
});
