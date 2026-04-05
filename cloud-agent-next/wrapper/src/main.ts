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

import { createKilo, type KiloClient as SDKClient } from '@kilocode/sdk';
import { SESSION_ID_RE } from '../../src/shared/protocol.js';
import { WRAPPER_VERSION } from '../../src/shared/wrapper-version.js';
import { WrapperState } from './state.js';
import { createWrapperKiloClient, type KiloServerHandle } from './kilo-api.js';
import { createConnectionManager } from './connection.js';
import { createLifecycleManager } from './lifecycle.js';
import { createServer } from './server.js';
import { logToFile } from './utils.js';
import type { WrapperCommand } from '../../src/shared/protocol.js';

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

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    logToFile(`ERROR: Missing required environment variable: ${name}`);
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

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
};

function parseStartupArgs(argv: string[]): StartupArgs {
  let agentSessionId: string | undefined;
  let userId: string | undefined;
  let sessionId: string | undefined;

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

    failStartup(`Unknown argument: ${arg}`);
  }

  if (!agentSessionId) {
    failStartup('Missing required --agent-session argument');
  }

  if (!userId) {
    failStartup('Missing required --user-id argument');
  }

  return { agentSessionId, userId, sessionId };
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
  const workspacePath = getRequiredEnv('WORKSPACE_PATH');
  const {
    agentSessionId,
    userId,
    sessionId: configuredSessionId,
  } = parseStartupArgs(process.argv.slice(2));

  if (!SESSION_ID_RE.test(agentSessionId)) {
    failStartup(`Invalid agent session ID: ${agentSessionId}`);
  }

  // The wrapper process is started with cwd outside the workspace.
  // Switch into the workspace now so the kilo server (started in-process)
  // sees the correct project root. This is an attempt to fix an issue where
  // the bun process crashes in some repos but not others.
  process.chdir(workspacePath);

  // Set log path if not already set
  if (!process.env.WRAPPER_LOG_PATH) {
    process.env.WRAPPER_LOG_PATH = `/tmp/kilocode-wrapper-${Date.now()}.log`;
  }

  logToFile(
    `config: wrapperPort=${wrapperPort} workspacePath=${workspacePath} agentSessionId=${agentSessionId}`
  );
  if (configuredSessionId) {
    logToFile(`config: sessionId=${configuredSessionId}`);
  }

  // ---------------------------------------------------------------------------
  // Start kilo server in-process via SDK
  // ---------------------------------------------------------------------------
  logToFile('starting kilo server in-process via @kilocode/sdk');
  let sdkClient: SDKClient;
  let kiloServer: KiloServerHandle;
  try {
    const result = await createKilo({
      hostname: '127.0.0.1',
      port: 0, // Let OS assign a random port
      timeout: KILO_STARTUP_TIMEOUT_MS,
    });
    sdkClient = result.client;
    kiloServer = result.server;
    logToFile(`kilo server started at ${kiloServer.url}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logToFile(`failed to start kilo server: ${msg}`);
    console.error('Failed to start kilo server:', msg);
    process.exit(1);
  }

  // Create wrapper kilo client (adapter over SDK client + raw fetch)
  const kiloClient = createWrapperKiloClient(sdkClient, kiloServer.url);

  // ---------------------------------------------------------------------------
  // Create or verify kilo session
  // ---------------------------------------------------------------------------
  let kiloSessionId: string;

  if (configuredSessionId) {
    // Verify the expected session exists — fail hard if it doesn't.
    // The Worker passed --session-id because it expects conversation continuity;
    // silently creating a new session would lose history without anyone noticing.
    try {
      await kiloClient.getSession(configuredSessionId);
      kiloSessionId = configuredSessionId;
      logToFile(`verified existing kilo session: ${kiloSessionId}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      failStartup(`configured session ${configuredSessionId} not found: ${msg}`);
    }
  } else {
    // Create a new session
    const session = await kiloClient.createSession();
    kiloSessionId = session.id;
    logToFile(`created kilo session: ${kiloSessionId}`);
  }

  // ---------------------------------------------------------------------------
  // Wire up components
  // ---------------------------------------------------------------------------
  const state = new WrapperState();

  // Late-bound: assigned after connectionManager is created (the lifecycle
  // callbacks below capture this variable by reference and only read it at
  // runtime, well after the assignment on the next line after createConnectionManager).
  // eslint-disable-next-line prefer-const
  let lifecycleManager: ReturnType<typeof createLifecycleManager> | undefined;

  // Create connection manager
  const connectionManager = createConnectionManager(
    state,
    { kiloClient },
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
        const job = state.currentJob;
        if (job) {
          kiloClient.abortSession({ sessionId: job.kiloSessionId }).catch(() => {});
        }
        lifecycleManager?.setAborted();
        state.setActive(false);
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
          const job = state.currentJob;
          if (job) {
            kiloClient.abortSession({ sessionId: job.kiloSessionId }).catch(() => {});
          }
          lifecycleManager?.setAborted();
          state.setActive(false);
          lifecycleManager?.triggerDrainAndClose();
        }
        if (cmd.type === 'ping') {
          state.sendToIngest({
            streamEventType: 'pong',
            data: { executionId: state.currentJob?.executionId },
            timestamp: new Date().toISOString(),
          });
        }
        if (cmd.type === 'request_snapshot') {
          // Fire-and-forget: reuse the existing snapshot logic from connection manager.
          void connectionManager.sendKiloSnapshot();
        }
      },
      onDisconnect: (reason: string) => {
        logToFile(`disconnect: ${reason}`);
        state.setLastError({
          code: 'DISCONNECT',
          message: reason,
          timestamp: Date.now(),
        });
        const job = state.currentJob;
        if (job) {
          kiloClient.abortSession({ sessionId: job.kiloSessionId }).catch(() => {});
        }
        lifecycleManager?.setAborted();
        state.setActive(false);
        lifecycleManager?.triggerDrainAndClose();
      },
      onCompletionSignal: () => {
        lifecycleManager?.signalCompletion();
      },
      onReconnecting: (attempt: number) => {
        logToFile(`ingest WS reconnecting: attempt ${attempt}`);
      },
      onReconnected: () => {
        logToFile('ingest WS reconnected');
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

  // Create lifecycle manager
  lifecycleManager = createLifecycleManager(
    { workspacePath },
    {
      state,
      kiloClient,
      closeConnections: () => connectionManager.close(),
      isConnected: () => connectionManager.isConnected(),
      reconnectEventSubscription: () => connectionManager.reconnectEventSubscription(),
    }
  );

  // Create HTTP server
  const server = createServer(
    {
      port: wrapperPort,
      workspacePath,
      version: WRAPPER_VERSION,
      sessionId: kiloSessionId,
      agentSessionId,
      userId,
    },
    {
      state,
      kiloClient,
      openConnection: () => connectionManager.open(),
      closeConnection: () => connectionManager.close(),
      setAborted: () => lifecycleManager?.setAborted(),
      resetLifecycle: () => lifecycleManager?.reset(),
      setPerTurnConfig: config => lifecycleManager?.setPerTurnConfig(config),
    },
    () => lifecycleManager?.triggerDrainAndClose()
  );

  // Start lifecycle timers
  lifecycleManager?.start();

  logToFile(`wrapper ready on port ${wrapperPort} (kilo server at ${kiloServer.url})`);
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
    const job = state.currentJob;
    if (job) {
      kiloClient.abortSession({ sessionId: job.kiloSessionId }).catch(() => {});
    }

    // Close connections
    void connectionManager.close();

    // Close kilo server
    try {
      kiloServer.close();
      logToFile('kilo server closed');
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
