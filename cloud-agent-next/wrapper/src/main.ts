/**
 * Long-running wrapper entry point.
 *
 * The wrapper runs as a long-running HTTP server that:
 * - Stays alive for the lifetime of the sandbox session
 * - Exposes an HTTP API for the Worker to send commands
 * - Connects to /ingest WebSocket on-demand (only when active)
 * - Handles SSE event forwarding, auto-commit, and condensation
 *
 * Configuration is via environment variables (session-level).
 * Execution-specific config is passed via HTTP API.
 */

import { WrapperState } from './state.js';
import { createKiloClient } from './kilo-client.js';
import { createConnectionManager } from './connection.js';
import {
  createLifecycleManager,
  DEFAULT_INFLIGHT_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
} from './lifecycle.js';
import { createServer } from './server.js';
import { logToFile } from './utils.js';
import type { WrapperCommand } from '../../src/shared/protocol.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Version string for health check */
const VERSION = '2.0.0';

/** Grace period before force exit during shutdown (20 seconds) */
const SHUTDOWN_TIMEOUT_MS = 20_000;

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

function getOptionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
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

function getOptionalEnvBool(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  logToFile('wrapper starting (long-running mode)');

  // Parse environment variables
  const wrapperPort = getOptionalEnvInt('WRAPPER_PORT', 5000);
  const kiloServerPort = getOptionalEnvInt('KILO_SERVER_PORT', 4000);
  const workspacePath = getRequiredEnv('WORKSPACE_PATH');

  const autoCommit = getOptionalEnvBool('AUTO_COMMIT', false);
  const condenseOnComplete = getOptionalEnvBool('CONDENSE_ON_COMPLETE', false);
  const upstreamBranch = getOptionalEnv('UPSTREAM_BRANCH', '');
  const model = getOptionalEnv('MODEL', '');

  const maxRuntimeMs = getOptionalEnvInt('MAX_RUNTIME_MS', DEFAULT_INFLIGHT_TIMEOUT_MS);
  const idleTimeoutMs = getOptionalEnvInt('IDLE_TIMEOUT_MS', DEFAULT_IDLE_TIMEOUT_MS);

  // Set log path if not already set
  if (!process.env.WRAPPER_LOG_PATH) {
    process.env.WRAPPER_LOG_PATH = `/tmp/kilocode-wrapper-${Date.now()}.log`;
  }

  logToFile(
    `config: wrapperPort=${wrapperPort} kiloServerPort=${kiloServerPort} workspacePath=${workspacePath}`
  );
  logToFile(
    `config: autoCommit=${autoCommit} condenseOnComplete=${condenseOnComplete} maxRuntimeMs=${maxRuntimeMs} idleTimeoutMs=${idleTimeoutMs}`
  );

  // Create state
  const state = new WrapperState();

  // Create kilo client
  const kiloServerBaseUrl = `http://127.0.0.1:${kiloServerPort}`;
  const kiloClient = createKiloClient(kiloServerBaseUrl);

  // Verify kilo server is reachable
  try {
    const health = await kiloClient.checkHealth();
    logToFile(`kilo server healthy: version=${health.version}`);
  } catch (error) {
    logToFile(
      `kilo server health check failed: ${error instanceof Error ? error.message : String(error)}`
    );
    console.error('Kilo server is not reachable at', kiloServerBaseUrl);
    process.exit(1);
  }

  // Create connection manager
  const connectionManager = createConnectionManager(
    state,
    { kiloServerPort },
    {
      onMessageComplete: (messageId: string) => {
        lifecycleManager.onMessageComplete(messageId);
      },
      onTerminalError: (reason: string) => {
        logToFile(`terminal error: ${reason}`);
        state.sendToIngest({
          streamEventType: 'error',
          data: { error: reason, fatal: true },
          timestamp: new Date().toISOString(),
        });
        // Abort the session if possible
        const job = state.currentJob;
        if (job) {
          kiloClient.abortSession({ sessionId: job.kiloSessionId }).catch(() => {});
        }
        // Mark as aborted (don't send 'complete' since we sent fatal error), then close
        lifecycleManager.setAborted();
        state.clearAllInflight();
        lifecycleManager.triggerDrainAndClose();
      },
      onCommand: (cmd: WrapperCommand) => {
        logToFile(`command received: ${cmd.type}`);
        if (cmd.type === 'kill') {
          // Send interrupted event before aborting
          state.sendToIngest({
            streamEventType: 'interrupted',
            data: { reason: 'User killed execution' },
            timestamp: new Date().toISOString(),
          });
          // Abort the kilo session
          const job = state.currentJob;
          if (job) {
            kiloClient.abortSession({ sessionId: job.kiloSessionId }).catch(() => {});
          }
          // Mark as aborted (don't send 'complete' since we sent interrupted), then close
          lifecycleManager.setAborted();
          state.clearAllInflight();
          lifecycleManager.triggerDrainAndClose();
        }
        if (cmd.type === 'ping') {
          state.sendToIngest({
            streamEventType: 'pong',
            data: { executionId: state.currentJob?.executionId },
            timestamp: new Date().toISOString(),
          });
        }
      },
      onDisconnect: (reason: string) => {
        logToFile(`disconnect: ${reason}`);
        state.setLastError({
          code: 'DISCONNECT',
          message: reason,
          timestamp: Date.now(),
        });
        state.clearAllInflight();
        // Also close SSE consumer to avoid orphaned connection
        void connectionManager.close();
      },
      onCompletionSignal: () => {
        // Signal completion to lifecycle manager for post-processing waiters
        lifecycleManager.signalCompletion();
      },
    }
  );

  // Create lifecycle manager
  const lifecycleManager = createLifecycleManager(
    {
      maxRuntimeMs,
      idleTimeoutMs,
      autoCommit,
      condenseOnComplete,
      workspacePath,
      upstreamBranch: upstreamBranch || undefined,
      model: model || undefined,
    },
    {
      state,
      kiloClient,
      connectionManager,
    }
  );

  // Create HTTP server
  const server = createServer(
    {
      port: wrapperPort,
      kiloServerPort,
      workspacePath,
      version: VERSION,
    },
    {
      state,
      kiloClient,
      openConnection: () => connectionManager.open(),
      getMaxRuntimeMs: () => lifecycleManager.getMaxRuntimeMs(),
      setAborted: () => lifecycleManager.setAborted(),
    },
    () => lifecycleManager.triggerDrainAndClose()
  );

  // Start lifecycle timers
  lifecycleManager.start();

  logToFile(`wrapper ready on port ${wrapperPort}`);
  console.log(`Wrapper listening on port ${wrapperPort}`);

  // Graceful shutdown handler
  let isShuttingDown = false;

  function handleShutdown(signal: string): void {
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
    lifecycleManager.stop();

    // Abort kilo session if running
    const job = state.currentJob;
    if (job) {
      kiloClient.abortSession({ sessionId: job.kiloSessionId }).catch(() => {});
    }

    // Close connections
    void connectionManager.close();

    // Stop HTTP server
    server.stop();

    // Force exit after timeout
    setTimeout(() => {
      logToFile('force exit after timeout');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    // Try graceful exit
    setTimeout(() => {
      logToFile('graceful exit');
      process.exit(0);
    }, 1000);
  }

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));
}

main().catch(err => {
  logToFile(`fatal error: ${err instanceof Error ? err.message : String(err)}`);
  console.error('Wrapper fatal error:', err);
  process.exit(1);
});
