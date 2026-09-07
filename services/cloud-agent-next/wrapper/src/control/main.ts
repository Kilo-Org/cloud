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
  createControlHandlerDeps,
  createSessionActivityRegistry,
  refreshHeartbeatPayload,
  handleControlRequest,
} from './sandbox-control-handlers';
import { eventKiloSessionId, sessionEventIdentity, updateSessionSnapshots } from './feed';
import { createControlTerminalRuntime } from './terminal-runtime';
import { createWorktreeKiloRuntimes } from './worktree-runtime';
import { createControlDiagnostics, type ControlDiagnostics } from './diagnostics';
import { controlLogWrapperIdSchema } from '../../../src/shared/control-diagnostics.js';
import { createWorktreeMutationNotifications } from './worktree-mutation-notifications';
import { createControlEventFailureHandler } from './control-event-transport';

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
  ['Kilo cancellation was not confirmed', 'cancellation_failed'],
  ['Native cancellation did not settle', 'cancellation_failed'],
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
    onEvent: async (runtime, event) => {
      mutationNotifications.observe(runtime, event);
      const identity = sessionEventIdentity({
        ...event,
        sessionId: eventKiloSessionId(event.properties),
        runtimeDirectory: runtime.directory,
      });
      if (!identity?.rootKiloSessionId) return;
      updateSessionSnapshots(event, deps.sessions);
      deps.activity?.observeEvent(
        event.type,
        identity.kiloSessionId,
        identity.rootKiloSessionId,
        event.properties
      );
      if (
        !control?.publishSessionEvent ||
        !(await control.publishSessionEvent(
          { type: event.type, properties: event.properties },
          identity
        ))
      ) {
        try {
          await deps.operations.retireDirectory(
            runtime.directory,
            'Session event delivery failed',
            Date.now() + KILO_CONTROL_REQUEST_TIMEOUT_MS,
            { runtimeId: runtime.runtimeId, client: runtime.kiloClient }
          );
        } catch {
          diagnostics.onDiagnostic('wrapper.lifecycle', { phase: 'failed' });
        }
        return;
      }
    },
    onUnexpectedClose: failure => {
      logToFile(`Kilo worktree retired reason=${failure.reason} directory=${failure.directory}`);
      const stillCurrent = () => {
        const current = kiloRuntimes.get(failure.directory);
        return current === undefined || current.runtimeId === failure.runtimeId;
      };
      if (failure.cleanup === 'unconfirmed' || !control?.reportNativeRuntimeRetirement) {
        if (stillCurrent()) shutdown(1, failure.reason);
        return;
      }
      void control
        .reportNativeRuntimeRetirement({
          retirementId: failure.retirementId,
          directory: failure.directory,
          nativeRuntimeId: failure.runtimeId,
          reason: failure.reason,
          cleanupDeadlineAt: failure.cleanupDeadlineAt,
        })
        .then(
          retired => {
            if (!retired && stillCurrent()) shutdown(1, failure.reason);
          },
          () => {
            if (stillCurrent()) shutdown(1, failure.reason);
          }
        );
    },
  });
  const terminalRuntime = controlConfig.SANDBOX_CONTROL_URL
    ? createControlTerminalRuntime({
        controlUrl: controlConfig.SANDBOX_CONTROL_URL,
        wrapperInstanceId: controlConfig.wrapperInstanceId,
        getKiloRuntime: directory => kiloRuntimes.get(directory),
      })
    : undefined;
  const deps = createControlHandlerDeps({
    onDiagnostic: diagnostics.onDiagnostic,
    kiloRuntimes,
    version: WRAPPER_VERSION,
    get kiloReady() {
      return !shuttingDown && kiloRuntimes.isHealthy();
    },
    sessions: [],
    activity: createSessionActivityRegistry(),
    signal: abort.signal,
    ...(terminalRuntime ? { terminalRuntime } : {}),
    sendOperationResult: (session, delivery, signal, deadlineAt) => {
      if (!control?.sendOperationResult)
        throw new Error('Sandbox control operation result delivery unavailable');
      return control.sendOperationResult(session, delivery, signal, deadlineAt);
    },
    emitSessionEvent: (session, payload, options) =>
      control?.sendEvent?.(
        'session.event',
        payload,
        {
          directory: session.directory,
          kiloSessionId: session.kiloSessionId,
          rootKiloSessionId: session.kiloSessionId,
          ...(options?.nativeRuntimeId ? { nativeRuntimeId: options.nativeRuntimeId } : {}),
        },
        options?.retained ? { preserveConnectionOnFailure: true } : undefined
      ) === true,
    retireRuntime: reason => shutdown(1, reason),
    onShutdown: () => shutdown(0, 'Sandbox shutting down'),
  });

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
        await deps.operations.drainDelivery(shutdownAt + KILO_CONTROL_REQUEST_TIMEOUT_MS);
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
    onEventReceiptFailure: createControlEventFailureHandler({
      getRuntime: directory => kiloRuntimes.get(directory),
      onFailure: (failure, runtime) => {
        void deps.operations
          .retireDirectory(
            failure.publication.session.directory,
            `Session event delivery ${failure.reason}`,
            Date.now() + KILO_CONTROL_REQUEST_TIMEOUT_MS,
            { runtimeId: runtime.runtimeId, client: runtime.kiloClient }
          )
          .catch(() => {
            diagnostics.onDiagnostic('wrapper.lifecycle', { phase: 'failed' });
          });
      },
    }),
    onDisconnected: () => shutdown(1, 'Sandbox control connection lost', 'control_disconnected'),
    onReconcile: async (_phase, deadlineAt) => {
      if (Date.now() >= deadlineAt) throw new Error('Control recovery deadline expired');
      await deps.operations.drainDelivery(deadlineAt);
    },
    onRequest: (operation, session, payload, authorization) => {
      return handleControlRequest(
        operation,
        session,
        payload,
        {
          ...deps,
          emitPreparing: (event, options) => {
            if (!session) return;
            if (
              !control?.sendEvent?.(
                'session.preparing',
                event,
                {
                  directory: session.directory,
                  kiloSessionId: session.kiloSessionId,
                  rootKiloSessionId: session.kiloSessionId,
                  ...(options?.nativeRuntimeId ? { nativeRuntimeId: options.nativeRuntimeId } : {}),
                },
                options?.retained ? { preserveConnectionOnFailure: true } : undefined
              )
            )
              throw new Error('Preparation event delivery failed');
          },
        },
        authorization
      );
    },
    getHeartbeatPayload: () => withHeartbeatReason(buildHeartbeatPayload(deps)),
    sampleHeartbeat: signal => refreshHeartbeatPayload(deps, signal).then(() => undefined),
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
