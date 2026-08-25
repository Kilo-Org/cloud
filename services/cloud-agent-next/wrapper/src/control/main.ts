import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKilo } from '@kilocode/sdk';
import { CONTROL_PLANE_SANDBOX_PERMISSION } from '../../../src/shared/control-plane-permission.js';
import { WRAPPER_VERSION } from '../../../src/shared/wrapper-version.js';
import { createWrapperKiloClient } from '../kilo-api.js';
import { logToFile } from '../utils.js';
import { maybeStartSandboxControlClient } from './sandbox-control-runtime';
import { buildHeartbeatPayload, handleControlRequest } from './sandbox-control-handlers';
import {
  childFromSessionCreated,
  eventKiloSessionId,
  permissionAskId,
  sessionEventIdentity,
  unfilteredKiloEvents,
} from './feed';
import { rememberChildSession } from './session-directories';

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
  logToFile(`kilo server started at ${result.server.url}`);

  const sessions: Array<{
    kiloSessionId: string;
    state: 'idle' | 'active' | 'finalizing';
    idleForMs: number;
  }> = [];

  let control: ReturnType<typeof maybeStartSandboxControlClient> = null;
  control = maybeStartSandboxControlClient(process.env, logToFile, {
    wrapperVersion: WRAPPER_VERSION,
    onRequest: (operation, session, payload) =>
      handleControlRequest(operation, session, payload, {
        kiloClient,
        version: WRAPPER_VERSION,
        kiloReady: true,
        getStatus: () => ({
          state: sessions.some(item => item.state !== 'idle') ? 'active' : 'idle',
          pendingMessages: [],
        }),
        sessions,
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
        kiloReady: true,
        getStatus: () => ({
          state: sessions.some(item => item.state !== 'idle') ? 'active' : 'idle',
          pendingMessages: [],
        }),
        sessions,
      }),
  });

  const abort = new AbortController();
  const feed = await result.client.global.event({ signal: abort.signal }).catch(() => undefined);
  if (feed?.stream) {
    void (async () => {
      for await (const event of unfilteredKiloEvents(feed.stream)) {
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
    })().catch(error => {
      logToFile(
        `control-plane feed closed: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    });
  }

  const shutdown = () => {
    abort.abort();
    control?.close();
    result.server.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  logToFile(`control-plane wrapper ready callHome=${Boolean(control)}`);
}

main().catch(error => {
  logToFile(`control-plane wrapper failed: ${error instanceof Error ? error.message : 'unknown'}`);
  process.exit(1);
});
