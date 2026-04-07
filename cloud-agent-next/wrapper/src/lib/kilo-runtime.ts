/**
 * Kilo runtime lifecycle — extracted from main.ts.
 *
 * Encapsulates kilo server startup, session creation/verification,
 * component wiring (state + connections + lifecycle + HTTP server),
 * and graceful shutdown. main.ts orchestrates these building blocks
 * without knowing their internals.
 */

import { createKilo, type KiloClient as SDKClient } from '@kilocode/sdk';
import { WRAPPER_VERSION } from '../../../src/shared/wrapper-version.js';
import { WrapperState } from '../state.js';
import {
  createWrapperKiloClient,
  type KiloServerHandle,
  type WrapperKiloClient,
} from '../kilo-api.js';
import { createConnectionManager, type ConnectionManager } from '../connection.js';
import { createLifecycleManager, type LifecycleManager } from '../lifecycle.js';
import { createServer, type WrapperServer } from '../server.js';
import { logToFile } from '../utils.js';
import type { WrapperCommand } from '../../../src/shared/protocol.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KILO_STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// initKilo
// ---------------------------------------------------------------------------

type InitKiloResult = {
  sdkClient: SDKClient;
  kiloServer: KiloServerHandle;
  kiloClient: WrapperKiloClient;
};

export async function initKilo(opts?: { port?: number }): Promise<InitKiloResult> {
  logToFile('starting kilo server in-process via @kilocode/sdk');

  const result = await createKilo({
    hostname: '127.0.0.1',
    port: opts?.port ?? 0,
    timeout: KILO_STARTUP_TIMEOUT_MS,
  });

  const sdkClient = result.client;
  const kiloServer = result.server;
  logToFile(`kilo server started at ${kiloServer.url}`);

  const kiloClient = createWrapperKiloClient(sdkClient, kiloServer.url);

  return { sdkClient, kiloServer, kiloClient };
}

// ---------------------------------------------------------------------------
// createOrVerifySession
// ---------------------------------------------------------------------------

export async function createOrVerifySession(
  kiloClient: WrapperKiloClient,
  sessionId?: string
): Promise<string> {
  if (sessionId) {
    await kiloClient.getSession(sessionId);
    logToFile(`verified existing kilo session: ${sessionId}`);
    return sessionId;
  }

  const session = await kiloClient.createSession();
  logToFile(`created kilo session: ${session.id}`);
  return session.id;
}

// ---------------------------------------------------------------------------
// createRuntime
// ---------------------------------------------------------------------------

export type RuntimeConfig = {
  wrapperPort: number;
  workspacePath: string;
  kiloSessionId: string;
  agentSessionId: string;
  userId: string;
  kiloClient: WrapperKiloClient;
  kiloServer: KiloServerHandle;
  /** Handler for POST /job/init (supervisor mode only) */
  onInit?: (req: Request) => Promise<Response>;
  /** Custom state string for health endpoint (supervisor mode only) */
  getSupervisorState?: () => string;
  /** Supervisor mode: keep ingest WS + SSE alive between turns */
  keepConnectionsAlive?: boolean;
  /** Called after turn drain completes (post-completion + log upload + complete event sent) */
  onDrainComplete?: () => void;
  /** Called when wrapper transitions idle → active (new turn starting) */
  onBecameActive?: () => void;
};

export type KiloRuntime = {
  state: WrapperState;
  connectionManager: ConnectionManager;
  lifecycleManager: LifecycleManager;
  server: WrapperServer;
  kiloClient: WrapperKiloClient;
  kiloServer: KiloServerHandle;
};

export function createRuntime(config: RuntimeConfig): KiloRuntime {
  const {
    wrapperPort,
    workspacePath,
    kiloSessionId,
    agentSessionId,
    userId,
    kiloClient,
    kiloServer,
  } = config;

  const state = new WrapperState(agentSessionId);

  if (config.onBecameActive) {
    state.onBecameActive = config.onBecameActive;
  }

  // Late-bound: assigned after connectionManager is created (the lifecycle
  // callbacks below capture this variable by reference and only read it at
  // runtime, well after the assignment on the next line after createConnectionManager).
  // eslint-disable-next-line prefer-const
  let lifecycleManager: LifecycleManager | undefined;

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
          const pongData = state.currentJob?.executionId
            ? { executionId: state.currentJob.executionId }
            : {};
          state.sendToIngest({
            streamEventType: 'pong',
            data: pongData,
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

  lifecycleManager = createLifecycleManager(
    { workspacePath },
    {
      state,
      kiloClient,
      closeConnections: () => connectionManager.close(),
      isConnected: () => connectionManager.isConnected(),
      reconnectEventSubscription: () => connectionManager.reconnectEventSubscription(),
      keepConnectionsAlive: config.keepConnectionsAlive,
      onDrainComplete: config.onDrainComplete,
    }
  );

  const server = createServer(
    {
      port: wrapperPort,
      workspacePath,
      version: WRAPPER_VERSION,
      sessionId: kiloSessionId,
      agentSessionId,
      userId,
      onInit: config.onInit,
      getSupervisorState: config.getSupervisorState,
    },
    {
      state,
      kiloClient,
      openConnection: () => connectionManager.open(),
      closeConnection: () => connectionManager.close(),
      setAborted: () => lifecycleManager?.setAborted(),
      resetLifecycle: () => lifecycleManager?.reset(),
      setPerTurnConfig: conf => lifecycleManager?.setPerTurnConfig(conf),
    },
    () => lifecycleManager?.triggerDrainAndClose()
  );

  lifecycleManager.start();

  return {
    state,
    connectionManager,
    lifecycleManager,
    server,
    kiloClient,
    kiloServer,
  };
}

// ---------------------------------------------------------------------------
// shutdownRuntime
// ---------------------------------------------------------------------------

export async function shutdownRuntime(runtime: KiloRuntime, signal: string): Promise<void> {
  const { state, connectionManager, lifecycleManager, server, kiloClient, kiloServer } = runtime;

  logToFile(`shutdown signal: ${signal}`);
  console.error(`Received ${signal}, shutting down...`);

  state.sendToIngest({
    streamEventType: 'interrupted',
    data: { reason: `Container shutdown: ${signal}` },
    timestamp: new Date().toISOString(),
  });

  lifecycleManager.stop();

  setTimeout(() => {
    logToFile('force exit after timeout');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  const uploader = state.logUploader;
  if (uploader) {
    const uploadTimeout = new Promise<void>(resolve => setTimeout(resolve, 5_000));
    await Promise.race([uploader.uploadNow().catch(() => {}), uploadTimeout]);
    uploader.stop();
  }

  const job = state.currentJob;
  if (job) {
    kiloClient.abortSession({ sessionId: job.kiloSessionId }).catch(() => {});
  }

  void connectionManager.close();

  try {
    kiloServer.close();
    logToFile('kilo server closed');
  } catch (err) {
    logToFile(`kilo server close error: ${err instanceof Error ? err.message : String(err)}`);
  }

  await server.stop();

  setTimeout(() => {
    logToFile('graceful exit');
    process.exit(0);
  }, 1000);
}
