import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKilo } from '@kilocode/sdk';
import { CONTROL_PLANE_SANDBOX_PERMISSION } from '../../../src/shared/control-plane-permission.js';
import { WRAPPER_VERSION } from '../../../src/shared/wrapper-version.js';
import { createWrapperKiloClient } from '../kilo-api.js';
import { logToFile } from '../utils.js';
import {
  maybeStartSandboxControlClient,
  startSandboxControlEventFeed,
} from './sandbox-control-runtime';
import {
  buildHeartbeatPayload,
  handleControlRequest,
  type HandlerSessionSnapshot,
} from './sandbox-control-handlers';
import {
  childFromSessionCreated,
  eventKiloSessionId,
  permissionAskId,
  sessionEventIdentity,
  unfilteredKiloEvents,
  updateSessionSnapshots,
} from './feed';
import { rememberChildSession } from './session-directories';
import { createControlTerminalRuntime } from './terminal-runtime';

const KILO_STARTUP_TIMEOUT_MS = 30_000;

function writeKiloAuthFromEnv(): void {
  const content = process.env.KILO_AUTH_CONTENT;
  const token = process.env.KILOCODE_TOKEN;
  const auth =
    content ?? (token ? JSON.stringify({ kilo: { type: 'api', key: token } }) : undefined);
  if (!auth) return;
  const dir = path.join(os.homedir(), '.local', 'share', 'kilo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth.json'), auth, { mode: 0o600 });
}

async function main(): Promise<void> {
  const controlConfig = {
    SANDBOX_CONTROL_URL: process.env.SANDBOX_CONTROL_URL,
    SANDBOX_CONTROL_CREDENTIAL: process.env.SANDBOX_CONTROL_CREDENTIAL,
    PROVIDER_INSTANCE_ID: process.env.PROVIDER_INSTANCE_ID,
    wrapperInstanceId: crypto.randomUUID(),
  };
  delete process.env.SANDBOX_CONTROL_CREDENTIAL;

  logToFile(`control-plane wrapper ${WRAPPER_VERSION} starting`);
  writeKiloAuthFromEnv();

  const result = await createKilo({
    hostname: '127.0.0.1',
    port: 0,
    timeout: KILO_STARTUP_TIMEOUT_MS,
    config: {
      autoupdate: false,
      permission: CONTROL_PLANE_SANDBOX_PERMISSION,
    },
  });
  const kiloClient = createWrapperKiloClient(result.client, result.server.url, '/');
  const terminalRuntime = controlConfig.SANDBOX_CONTROL_URL
    ? createControlTerminalRuntime({
        controlUrl: controlConfig.SANDBOX_CONTROL_URL,
        wrapperInstanceId: controlConfig.wrapperInstanceId,
        kiloClient,
      })
    : undefined;
  logToFile(`kilo server started at ${result.server.url}`);

  const sessions: HandlerSessionSnapshot[] = [];
  const abort = new AbortController();
  let control: ReturnType<typeof maybeStartSandboxControlClient> = null;
  let kiloReady = false;
  let shuttingDown = false;

  const shutdown = (exitCode: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    kiloReady = false;
    abort.abort();
    terminalRuntime?.shutdown();
    control?.close();
    result.server.close();
    process.exit(exitCode);
  };
  process.once('SIGTERM', () => shutdown(0));
  process.once('SIGINT', () => shutdown(0));

  try {
    await startSandboxControlEventFeed({
      signal: abort.signal,
      open: signal => result.client.global.event({ signal, sseMaxRetryAttempts: 1 }),
      consume: async stream => {
        for await (const event of unfilteredKiloEvents(stream)) {
          const permId = permissionAskId(event);
          if (event.type === 'permission.asked') {
            if (permId) {
              logToFile(`auto-approving permission ${permId}`);
              kiloClient.answerPermission(permId, 'always').catch(err => {
                logToFile(
                  `failed to auto-approve permission ${permId}: ${err instanceof Error ? err.message : String(err)}`
                );
              });
            }
            continue;
          }
          if (event.type === 'session.created') {
            const child = childFromSessionCreated(event.properties);
            if (child) rememberChildSession(child);
          }
          updateSessionSnapshots(event, sessions);
          const kiloSessionId = eventKiloSessionId(event.properties);
          const identity = sessionEventIdentity({
            sessionId: kiloSessionId,
            directory: event.directory,
          });
          control?.sendEvent?.(
            'session.event',
            { type: event.type, properties: event.properties },
            identity
          );
        }
      },
      onUnexpectedClose: () => {
        logToFile('control-plane Kilo event feed closed unexpectedly');
        shutdown(1);
      },
    });
  } catch {
    logToFile('control-plane Kilo event feed failed to start');
    shutdown(1);
    return;
  }

  kiloReady = true;
  control = maybeStartSandboxControlClient(controlConfig, logToFile, {
    wrapperVersion: WRAPPER_VERSION,
    isReady: () => kiloReady && !abort.signal.aborted,
    onRequest: (operation, session, payload) =>
      handleControlRequest(operation, session, payload, {
        kiloClient,
        version: WRAPPER_VERSION,
        kiloReady,
        getStatus: () => ({
          state: sessions.some(item => item.state !== 'idle') ? 'active' : 'idle',
          pendingMessages: [],
        }),
        sessions,
        ...(terminalRuntime ? { terminalRuntime } : {}),
        emitPreparing: event => {
          if (!session) return;
          control?.sendEvent?.('session.preparing', event, {
            directory: session.directory,
            kiloSessionId: session.kiloSessionId,
            rootKiloSessionId: session.kiloSessionId,
          });
        },
      }),
    getHeartbeatPayload: () =>
      buildHeartbeatPayload({
        kiloClient,
        version: WRAPPER_VERSION,
        kiloReady,
        getStatus: () => ({
          state: sessions.some(item => item.state !== 'idle') ? 'active' : 'idle',
          pendingMessages: [],
        }),
        sessions,
      }),
  });

  logToFile(`control-plane wrapper ready callHome=${Boolean(control)}`);
}

main().catch(error => {
  logToFile(`control-plane wrapper failed: ${error instanceof Error ? error.message : 'unknown'}`);
  process.exit(1);
});
