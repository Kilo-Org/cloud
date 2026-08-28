import { WRAPPER_VERSION } from '../../../src/shared/wrapper-version.js';
import { logToFile } from '../utils.js';
import {
  KILO_CONTROL_REQUEST_TIMEOUT_MS,
  maybeStartSandboxControlClient,
} from './sandbox-control-runtime';
import {
  buildHeartbeatPayload,
  cancelControlTasks,
  handleControlRequest,
  type HandlerDeps,
} from './sandbox-control-handlers';
import {
  childFromSessionCreated,
  eventKiloSessionId,
  sessionEventIdentity,
  updateSessionSnapshots,
} from './feed';
import { rememberChildSession } from './session-directories';
import { createControlTerminalRuntime } from './terminal-runtime';
import { createWorktreeKiloRuntimes } from './worktree-runtime';

function main(): void {
  const controlConfig = {
    SANDBOX_CONTROL_URL: process.env.SANDBOX_CONTROL_URL,
    SANDBOX_CONTROL_CREDENTIAL: process.env.SANDBOX_CONTROL_CREDENTIAL,
    PROVIDER_INSTANCE_ID: process.env.PROVIDER_INSTANCE_ID,
    wrapperInstanceId: crypto.randomUUID(),
  };
  delete process.env.SANDBOX_CONTROL_CREDENTIAL;

  logToFile(`control-plane wrapper ${WRAPPER_VERSION} starting`);
  const abort = new AbortController();
  let control: ReturnType<typeof maybeStartSandboxControlClient> = null;
  let shuttingDown = false;
  const kiloRuntimes = createWorktreeKiloRuntimes({
    onEvent: (_runtime, event) => {
      if (event.type === 'session.created') {
        const child = childFromSessionCreated(event.properties);
        if (child) rememberChildSession(child);
      }
      updateSessionSnapshots(event, deps.sessions);
      const identity = sessionEventIdentity({
        sessionId: eventKiloSessionId(event.properties),
        directory: event.directory,
      });
      if (!identity?.rootKiloSessionId) return;
      if (
        !control?.sendEvent?.(
          'session.event',
          { type: event.type, properties: event.properties },
          identity
        )
      ) {
        throw new Error('Sandbox control event delivery failed');
      }
    },
    onUnexpectedClose: () => shutdown(1, 'Kilo event feed is no longer healthy'),
  });
  const terminalRuntime = controlConfig.SANDBOX_CONTROL_URL
    ? createControlTerminalRuntime({
        controlUrl: controlConfig.SANDBOX_CONTROL_URL,
        wrapperInstanceId: controlConfig.wrapperInstanceId,
        getKiloRuntime: directory => kiloRuntimes.get(directory),
      })
    : undefined;
  const deps: HandlerDeps = {
    kiloRuntimes,
    version: WRAPPER_VERSION,
    get kiloReady() {
      return !shuttingDown && kiloRuntimes.isHealthy();
    },
    sessions: [],
    tasks: new Map(),
    signal: abort.signal,
    ...(terminalRuntime ? { terminalRuntime } : {}),
    emitSessionEvent: (session, payload) => {
      if (
        !control?.sendEvent?.('session.event', payload, {
          directory: session.directory,
          kiloSessionId: session.kiloSessionId,
          rootKiloSessionId: session.kiloSessionId,
        })
      ) {
        throw new Error('Sandbox control event delivery failed');
      }
    },
    retireRuntime: reason => shutdown(1, reason),
    onShutdown: () => shutdown(0, 'Sandbox shutting down'),
  };

  function shutdown(exitCode: number, reason: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    logToFile(`control-plane wrapper retiring: ${reason}`);
    control?.sendEvent?.('sandbox.heartbeat', buildHeartbeatPayload(deps));
    const stopped = cancelControlTasks(deps, reason, exitCode === 0 ? 'cancelled' : 'failed');
    abort.abort();
    terminalRuntime?.shutdown();
    const finish = (): void => {
      control?.close();
      kiloRuntimes.shutdown();
      process.exit(exitCode);
    };
    const deadline = setTimeout(finish, KILO_CONTROL_REQUEST_TIMEOUT_MS);
    void stopped.finally(() => {
      clearTimeout(deadline);
      setTimeout(finish, 0);
    });
  }
  process.once('SIGTERM', () => shutdown(0, 'Wrapper received SIGTERM'));
  process.once('SIGINT', () => shutdown(0, 'Wrapper received SIGINT'));

  control = maybeStartSandboxControlClient(controlConfig, logToFile, {
    wrapperVersion: WRAPPER_VERSION,
    isReady: () => deps.kiloReady,
    onDisconnected: () => shutdown(1, 'Sandbox control connection lost'),
    onRequest: (operation, session, payload) =>
      handleControlRequest(operation, session, payload, {
        ...deps,
        emitPreparing: event => {
          if (!session) return;
          if (
            !control?.sendEvent?.('session.preparing', event, {
              directory: session.directory,
              kiloSessionId: session.kiloSessionId,
              rootKiloSessionId: session.kiloSessionId,
            })
          ) {
            shutdown(1, 'Preparation event delivery failed');
          }
        },
      }),
    getHeartbeatPayload: () => buildHeartbeatPayload(deps),
  });

  logToFile(`control-plane wrapper ready callHome=${Boolean(control)}`);
}

try {
  main();
} catch {
  logToFile('control-plane wrapper failed');
  process.exit(1);
}
