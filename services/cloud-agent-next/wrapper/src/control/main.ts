import type { SandboxHeartbeatPayload } from '../../../src/shared/sandbox-control-protocol.js';
import { WRAPPER_VERSION } from '../../../src/shared/wrapper-version.js';
import { logToFile } from '../utils.js';
import {
  KILO_CONTROL_REQUEST_TIMEOUT_MS,
  maybeStartSandboxControlClient,
} from './sandbox-control-runtime';
import {
  buildHeartbeatPayload,
  cancelControlTasks,
  createSessionActivityRegistry,
  refreshHeartbeatPayload,
  handleControlRequest,
  type HandlerDeps,
} from './sandbox-control-handlers';
import { eventKiloSessionId, sessionEventIdentity, updateSessionSnapshots } from './feed';
import { createControlTerminalRuntime } from './terminal-runtime';
import { createWorktreeKiloRuntimes } from './worktree-runtime';
import { createControlDiagnostics, type ControlDiagnostics } from './diagnostics';
import { controlLogWrapperIdSchema } from '../../../src/shared/control-diagnostics.js';
import { createWorktreeMutationNotifications } from './worktree-mutation-notifications';

const retirementCauses = new Map([
  ['Kilo event feed is no longer healthy', 'event_feed_unhealthy'],
  ['process_exited', 'process_exited'],
  ['credential_refresh_failed', 'credential_refresh_failed'],
  ['Sandbox control connection lost', 'control_disconnected'],
  ['Preparation event delivery failed', 'preparation_delivery_failed'],
  ['Sandbox shutting down', 'requested_shutdown'],
  ['Wrapper received SIGTERM', 'sigterm'],
  ['Wrapper received SIGINT', 'sigint'],
  ['Wrapper uncaught exception', 'uncaught_exception'],
  ['Wrapper unhandled rejection', 'unhandled_rejection'],
  ['Kilo cancellation failed', 'cancellation_failed'],
  ['Session outcome delivery failed', 'outcome_delivery_failed'],
  ['Execution exceeded the 60 minute limit', 'execution_deadline'],
  ['Session preparation timed out', 'preparation_deadline'],
]);

function main(diagnostics: ControlDiagnostics, wrapperInstanceId: string): void {
  const controlConfig = {
    SANDBOX_CONTROL_URL: process.env.SANDBOX_CONTROL_URL,
    SANDBOX_CONTROL_CREDENTIAL: process.env.SANDBOX_CONTROL_CREDENTIAL,
    PROVIDER_INSTANCE_ID: process.env.PROVIDER_INSTANCE_ID,
    wrapperInstanceId,
  };
  delete process.env.SANDBOX_CONTROL_CREDENTIAL;

  logToFile(`control-plane wrapper ${WRAPPER_VERSION} starting`);
  const abort = new AbortController();
  let control: ReturnType<typeof maybeStartSandboxControlClient> = null;
  let shuttingDown = false;
  let heartbeatReason: SandboxHeartbeatPayload['kilo']['reason'];
  const kiloRuntimes = createWorktreeKiloRuntimes({
    onDiagnostic: diagnostics.onDiagnostic,
    onEvent: (runtime, event) => {
      mutationNotifications.observe(runtime, event);
      const identity = sessionEventIdentity({
        ...event,
        sessionId: eventKiloSessionId(event.properties),
        runtimeDirectory: runtime.directory,
      });
      if (
        !identity?.rootKiloSessionId ||
        runtime.identity === undefined ||
        identity.rootKiloSessionId !== runtime.identity.kiloSessionId
      )
        return;
      updateSessionSnapshots(event, deps.sessions);
      deps.activity?.observeEvent(
        event.type,
        identity.kiloSessionId,
        identity.rootKiloSessionId,
        event.properties
      );
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
    onUnexpectedClose: failure =>
      shutdown(
        1,
        `Kilo worktree failed reason=${failure.reason} directory=${failure.directory}`,
        failure.reason
      ),
  });
  const terminalRuntime = controlConfig.SANDBOX_CONTROL_URL
    ? createControlTerminalRuntime({
        controlUrl: controlConfig.SANDBOX_CONTROL_URL,
        wrapperInstanceId: controlConfig.wrapperInstanceId,
        getKiloRuntime: identity => kiloRuntimes.get(identity),
      })
    : undefined;
  const deps: HandlerDeps = {
    onDiagnostic: diagnostics.onDiagnostic,
    kiloRuntimes,
    version: WRAPPER_VERSION,
    get kiloReady() {
      return !shuttingDown && kiloRuntimes.isHealthy();
    },
    sessions: [],
    tasks: new Map(),
    activity: createSessionActivityRegistry(),
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

  const mutationNotifications = createWorktreeMutationNotifications({
    sessions: deps.sessions,
    kiloRuntimes,
    signal: abort.signal,
    sendEvent: (event, payload, identity) => control?.sendEvent?.(event, payload, identity),
  });

  function withHeartbeatReason(payload: SandboxHeartbeatPayload): SandboxHeartbeatPayload {
    if (!payload.kilo.ready && heartbeatReason) payload.kilo.reason = heartbeatReason;
    return payload;
  }

  function shutdown(
    exitCode: number,
    reason: string,
    diagnosticReason: NonNullable<SandboxHeartbeatPayload['kilo']['reason']> = 'shutdown'
  ): void {
    if (shuttingDown) return;
    shuttingDown = true;
    heartbeatReason = diagnosticReason;
    const shutdownAt = Date.now();
    const finish = (): void => {
      try {
        control?.close();
      } finally {
        try {
          kiloRuntimes.shutdown();
        } finally {
          process.exit(exitCode);
        }
      }
    };
    const deadline = setTimeout(finish, KILO_CONTROL_REQUEST_TIMEOUT_MS);
    diagnostics.onDiagnostic('wrapper.lifecycle', {
      phase: 'stopping',
      exitCode,
      retirementCause:
        retirementCauses.get(reason) ??
        retirementCauses.get(diagnosticReason) ??
        (diagnosticReason.startsWith('feed_') ? 'event_feed_unhealthy' : 'unknown'),
    });
    void diagnostics.flush();
    logToFile(`control-plane wrapper retiring exitCode=${exitCode}`);
    const stopped = (async () => {
      try {
        control?.sendEvent?.('sandbox.heartbeat', withHeartbeatReason(buildHeartbeatPayload(deps)));
      } catch {
        diagnostics.onDiagnostic('wrapper.lifecycle', { phase: 'failed', exitCode });
        logToFile('control-plane final heartbeat delivery failed');
      }
      const tasks = cancelControlTasks(deps, reason, exitCode === 0 ? 'cancelled' : 'failed');
      try {
        abort.abort();
        terminalRuntime?.shutdown();
      } finally {
        await tasks;
      }
    })();
    void stopped
      .catch(() => undefined)
      .then(async () => {
        const remaining = KILO_CONTROL_REQUEST_TIMEOUT_MS - (Date.now() - shutdownAt) - 100;
        await diagnostics.finalize(Math.max(1, Math.min(4000, remaining)));
      })
      .finally(() => {
        clearTimeout(deadline);
        setTimeout(finish, 0);
      });
  }
  process.once('SIGTERM', () => shutdown(0, 'Wrapper received SIGTERM'));
  process.once('SIGINT', () => shutdown(0, 'Wrapper received SIGINT'));
  process.once('uncaughtException', () => shutdown(1, 'Wrapper uncaught exception'));
  process.once('unhandledRejection', () => shutdown(1, 'Wrapper unhandled rejection'));

  control = maybeStartSandboxControlClient(controlConfig, logToFile, {
    onDiagnostic: diagnostics.onDiagnostic,
    wrapperVersion: WRAPPER_VERSION,
    isReady: () => deps.kiloReady,
    onConnected: () => diagnostics.onDiagnostic('wrapper.lifecycle', { phase: 'ready', ok: true }),
    onDisconnected: () => shutdown(1, 'Sandbox control connection lost', 'control_disconnected'),
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
            shutdown(1, 'Preparation event delivery failed', 'control_disconnected');
          }
        },
      }),
    getHeartbeatPayload: async () => withHeartbeatReason(await refreshHeartbeatPayload(deps)),
  });

  diagnostics.onDiagnostic('wrapper.lifecycle', { phase: 'started', ok: Boolean(control) });
  logToFile(`control-plane wrapper ready callHome=${Boolean(control)}`);
}

const configuredWrapperId = controlLogWrapperIdSchema.safeParse(
  process.env.CONTROL_WRAPPER_INSTANCE_ID
);
const wrapperInstanceId = configuredWrapperId.success
  ? configuredWrapperId.data
  : crypto.randomUUID();
const diagnostics = createControlDiagnostics({
  uploadUrl: process.env.CONTROL_LOG_UPLOAD_URL,
  uploadGrant: process.env.CONTROL_LOG_UPLOAD_GRANT,
});
delete process.env.CONTROL_LOG_UPLOAD_URL;
delete process.env.CONTROL_LOG_UPLOAD_GRANT;
delete process.env.CONTROL_WRAPPER_INSTANCE_ID;
diagnostics.onDiagnostic('wrapper.lifecycle', { phase: 'starting' });
diagnostics.start();

try {
  main(diagnostics, wrapperInstanceId);
} catch {
  diagnostics.onDiagnostic('wrapper.lifecycle', { phase: 'start_failed' });
  logToFile('control-plane wrapper failed');
  void diagnostics.finalize().finally(() => process.exit(1));
}
