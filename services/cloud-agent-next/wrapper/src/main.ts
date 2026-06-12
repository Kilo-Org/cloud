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
import { openKiloGlobalFeed } from './global-feed.js';
import { createGlobalFeedManager, type SessionBoundFeedPolicy } from './global-feed-manager.js';
import { logToFile } from './utils.js';
import {
  kiloServerBootstrapError,
  kiloServerStartupError,
  WrapperBootstrapError,
} from './bootstrap-error.js';
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
  let isShuttingDown = false;
  const workspaceBootstrapController = new AbortController();
  const activeWorkspaceBootstraps = new Set<ReturnType<typeof prepareWrapperBootstrapWorkspace>>();
  const activeRuntimeStartups = new Set<Promise<void>>();

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
    onDeliveryAcknowledged: (kind: 'async-prompt' | 'sync-command' | 'failed') =>
      lifecycleManager?.onDeliveryAcknowledged(kind),
    readySession: readySession,
    updateRuntimeEnvironment: updateRuntimeEnvironment,
    materializePromptAttachments,
    onSessionBound: (feedPolicy: SessionBoundFeedPolicy) =>
      globalFeedManager.onSessionBound(feedPolicy),
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
        `post-bootstrap kilo session lookup end runtime=${runtime} outcome=error expectedSessionId=${expectedSessionId} elapsedMs=${Date.now() - lookupStartedAt}`
      );
      throw error;
    }
  }

  const globalFeedManager = createGlobalFeedManager({
    canOpen: () => Boolean(kiloClient && state.currentSession),
    open: () => {
      if (!kiloClient) {
        throw new Error('Cannot open Kilo global feed: no Kilo client');
      }
      return openKiloGlobalFeed({ state, kiloClient });
    },
    onConnectionError: () => {
      logToFile('kilo global feed failed');
    },
    onOpenError: () => {
      logToFile('failed to start kilo global feed');
    },
  });

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
      globalFeedManager.onRuntimeReady();
      return;
    }

    logToFile(
      `startKiloRuntime preparing new runtime workspacePath=${workspacePath} previousWorkspacePath=${runtimeWorkspacePath ?? '(unset)'} hadLifecycle=${Boolean(lifecycleManager)} hadConnection=${Boolean(connectionManager)} hadServer=${Boolean(closeKiloServer)}`
    );
    globalFeedManager.close();
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
    } catch {
      const startupError = kiloServerStartupError();
      logToFile(`failed to start kilo server: ${startupError.message}`);
      throw startupError;
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
        onTerminalError: failure => {
          logToFile(`terminal error: ${failure.message}`);
          state.sendToIngest({
            streamEventType: 'error',
            data: {
              error: failure.message,
              errorSource: failure.errorSource,
              fatal: true,
              ...(failure.code ? { failureCode: failure.code } : {}),
              ...(failure.modelNotFoundRuntimeDiagnostics
                ? { modelNotFoundRuntimeDiagnostics: failure.modelNotFoundRuntimeDiagnostics }
                : {}),
            },
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
    globalFeedManager.onRuntimeReady();
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

  function wrapperFinalizingResponse(): WrapperSessionReadyResponse {
    return {
      status: 'error',
      error: {
        code: 'WRAPPER_FINALIZING',
        message: 'Wrapper is shutting down',
        retryable: true,
      },
    };
  }

  async function readySession(
    request: WrapperSessionReadyRequest
  ): Promise<WrapperSessionReadyResponse> {
    if (isShuttingDown) return wrapperFinalizingResponse();

    const readyStartedAt = Date.now();
    let progressChannel: Awaited<ReturnType<typeof openIngestProgressChannel>> | undefined;
    logToFile(
      `session/ready received agentSessionId=${request.agentSessionId} kiloSessionId=${request.kiloSessionId} preferSnapshot=${request.workspace.preferSnapshot} workspacePath=${request.workspace.workspacePath} sessionHome=${request.workspace.sessionHome} branchName=${request.workspace.branchName} strictBranch=${request.workspace.strictBranch ?? false} repoKind=${request.repo?.kind ?? '(none)'} setupCommandCount=${request.materialized.setupCommands?.length ?? 0} runtimeSkillCount=${request.materialized.runtimeSkills?.length ?? 0} platform=${request.materialized.env.KILO_PLATFORM ?? process.env.KILO_PLATFORM ?? '(unset)'} stateConnected=${state.isConnected}`
    );
    try {
      const bindError = await bindSessionContext(
        request.session,
        serverConfig,
        serverDeps,
        'close-until-runtime-ready'
      );
      if (bindError) {
        const error = (await bindError.json()) as {
          error?: string;
          message?: string;
          wrapperRunId?: string;
        };
        const code =
          error.error === 'WRAPPER_FINALIZING' ? 'WRAPPER_FINALIZING' : 'INVALID_REQUEST';
        logToFile(
          `session/ready binding rejected kiloSessionId=${request.kiloSessionId} status=${bindError.status} message=${error.message ?? error.error ?? 'Invalid session binding'} elapsedMs=${Date.now() - readyStartedAt}`
        );
        return {
          status: 'error',
          error: {
            code,
            message: error.message ?? error.error ?? 'Invalid session binding',
            retryable: code === 'WRAPPER_FINALIZING',
            ...(error.wrapperRunId ? { wrapperRunId: error.wrapperRunId } : {}),
          },
        };
      }

      serverConfig.workspacePath = request.workspace.workspacePath;
      serverConfig.sessionId = request.kiloSessionId;
      serverConfig.platform = request.materialized.env.KILO_PLATFORM ?? process.env.KILO_PLATFORM;

      if (!state.isConnected) {
        progressChannel = await openIngestProgressChannel(state);
      }

      if (isShuttingDown) return wrapperFinalizingResponse();

      logToFile(
        `session/ready bootstrap workspace starting kiloSessionId=${request.kiloSessionId}`
      );
      const workspaceBootstrap = prepareWrapperBootstrapWorkspace(
        request,
        (step, message) => {
          state.sendToIngest({
            streamEventType: 'preparing',
            data: { step, message },
            timestamp: new Date().toISOString(),
          });
        },
        {},
        workspaceBootstrapController.signal
      );
      activeWorkspaceBootstraps.add(workspaceBootstrap);
      try {
        await workspaceBootstrap;
      } finally {
        activeWorkspaceBootstraps.delete(workspaceBootstrap);
      }
      logToFile(
        `session/ready bootstrap workspace finished kiloSessionId=${request.kiloSessionId}`
      );

      progressChannel?.close();
      progressChannel = undefined;

      if (isShuttingDown) return wrapperFinalizingResponse();
      const runtimeStartup = startKiloRuntime(
        request.workspace.workspacePath,
        request.kiloSessionId
      );
      activeRuntimeStartups.add(runtimeStartup);
      try {
        await runtimeStartup;
      } finally {
        activeRuntimeStartups.delete(runtimeStartup);
      }
      if (!kiloClient) {
        throw kiloServerBootstrapError('Kilo server did not start');
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
      if (isShuttingDown) {
        logToFile(
          `session/ready aborted by shutdown kiloSessionId=${request.kiloSessionId} elapsedMs=${Date.now() - readyStartedAt}`
        );
        return wrapperFinalizingResponse();
      }
      const bootstrapError =
        error instanceof WrapperBootstrapError
          ? error
          : new WrapperBootstrapError({
              code: 'WORKSPACE_SETUP_FAILED',
              subtype: 'workspace_setup_unknown',
              message: 'Workspace setup failed',
              retryable: true,
            });
      logToFile(
        `session/ready failed kiloSessionId=${request.kiloSessionId} elapsedMs=${Date.now() - readyStartedAt} code=${bootstrapError.code} subtype=${bootstrapError.subtype ?? '(none)'} error=${bootstrapError.message}${bootstrapError.detail ? ` detail=${bootstrapError.detail}` : ''}`
      );
      return {
        status: 'error',
        error: {
          code: bootstrapError.code,
          ...(bootstrapError.subtype ? { subtype: bootstrapError.subtype } : {}),
          message: bootstrapError.message,
          ...(bootstrapError.detail ? { detail: bootstrapError.detail } : {}),
          retryable: bootstrapError.retryable,
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

  async function handleShutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logToFile(`shutdown signal: ${signal}`);
    console.error(`Received ${signal}, shutting down...`);

    // Force exit after timeout
    setTimeout(() => {
      logToFile('force exit after timeout');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    // Send interrupted event if connected — before waiting on startup cleanup,
    // which can outlast the force-exit window
    state.sendToIngest({
      streamEventType: 'interrupted',
      data: {
        reason: `Container shutdown: ${signal}`,
        interruptionSource: 'container_shutdown',
      },
      timestamp: new Date().toISOString(),
    });

    workspaceBootstrapController.abort();
    const workspaceBootstraps = [...activeWorkspaceBootstraps];
    const runtimeStartups = [...activeRuntimeStartups];
    const pendingStartupOperations = [...workspaceBootstraps, ...runtimeStartups];
    if (pendingStartupOperations.length > 0) {
      logToFile(
        `shutdown waiting for startup cleanup workspaceBootstraps=${workspaceBootstraps.length} runtimeStartups=${runtimeStartups.length}`
      );
      await Promise.allSettled(pendingStartupOperations);
      logToFile('shutdown startup cleanup finished');
    }

    // Stop lifecycle timers
    lifecycleManager?.stop();
    globalFeedManager.close();

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
    } catch {
      logToFile('kilo server close failed');
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
  function handleCrash(label: string): void {
    if (isShuttingDown) return;

    logToFile(label);
    console.error(`Wrapper ${label}`);

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

  process.on('uncaughtException', () => handleCrash('uncaught exception'));
  process.on('unhandledRejection', () => handleCrash('unhandled rejection'));
}

main().catch(() => {
  logToFile('fatal error');
  console.error('Wrapper fatal error');
  process.exit(1);
});
