import {
  heartbeatReasonFrom,
  sessionAttachResultSchema,
  type SandboxHeartbeatPayload,
  type SessionEventIdentity,
} from '../../../src/shared/sandbox-control-protocol.js';
import { WRAPPER_VERSION } from '../../../src/shared/wrapper-version.js';
import { logToFile } from '../utils.js';
import { ownerDirectoryForSession, rootForSession } from './session-directories';
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
import {
  createWorktreeKiloRuntimes,
  type RootRuntimeDisappearance,
  type RootRuntimeRetirement,
  type RootRuntimeRetirementStarted,
  type WorktreeKiloRuntime,
  isRetirementReportCurrent,
} from './worktree-runtime';
import type { RootScopedCleanupResult } from './session-operation-cleanup';
import type { RootPublicationDisposition } from './operation-registry';
import { createControlDiagnostics, type ControlDiagnostics } from './diagnostics';
import { createControlFileLogUploader, type ControlFileLogUploader } from './file-log-uploader';
import {
  classifyRetirementCause,
  controlLogWrapperIdSchema,
  diagnosticDetail,
} from '../../../src/shared/control-diagnostics.js';
import { createWorktreeMutationNotifications } from './worktree-mutation-notifications';
import { createControlEventFailureHandler } from './control-event-transport';

type PublicationRetirementResult = RootPublicationDisposition;

type PublicationFailureAttempt = {
  cleanup: Promise<RootScopedCleanupResult>;
  physical: Promise<PublicationRetirementResult>;
};
import type { ControlEventOutboxFailure } from './control-event-outbox';

function main(
  diagnostics: ControlDiagnostics,
  fileLogs: ControlFileLogUploader,
  wrapperInstanceId: string
): void {
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
  const reportedRuntimeRetirements = new Set<string>();
  const settleRootRetirement = (retirement: RootRuntimeRetirement): void => {
    deps.operations.settleRootPublication(retirement);
    if (!retirement.reportToService || retirement.result !== 'retired' || !retirement.retirementId)
      return;
    const current = kiloRuntimes.getRetained?.(retirement.directory, retirement.nativeRuntimeId);
    if (
      !isRetirementReportCurrent(
        kiloRuntimes.getEntryRuntimeId?.(retirement.directory, retirement.root),
        retirement.nativeRuntimeId
      ) ||
      (current &&
        (current.runtimeId !== retirement.nativeRuntimeId ||
          (retirement.target.client !== undefined &&
            current.kiloClient !== retirement.target.client)))
    )
      return;
    if (reportedRuntimeRetirements.has(retirement.retirementId)) return;
    const client = control;
    if (!client?.reportNativeRuntimeRetirement) return;
    reportedRuntimeRetirements.add(retirement.retirementId);
    const reason = retirement.reason ?? 'Native runtime retirement completed';
    void client
      .reportNativeRuntimeRetirement({
        retirementId: retirement.retirementId,
        directory: retirement.directory,
        nativeRuntimeId: retirement.nativeRuntimeId,
        reason,
        cleanupDeadlineAt: retirement.cleanupDeadlineAt ?? Date.now(),
      })
      .then(
        reported => {
          if (
            !reported &&
            isRetirementReportCurrent(
              kiloRuntimes.getEntryRuntimeId?.(retirement.directory, retirement.root),
              retirement.nativeRuntimeId
            )
          )
            shutdown(1, reason);
        },
        () => {
          if (
            isRetirementReportCurrent(
              kiloRuntimes.getEntryRuntimeId?.(retirement.directory, retirement.root),
              retirement.nativeRuntimeId
            )
          )
            shutdown(1, reason);
        }
      );
  };
  const markRootRetirementStarted = (retirement: RootRuntimeRetirementStarted): void => {
    deps.operations.markRootRetirementStarted(retirement);
  };
  const notifyRootDisappeared = (disappearance: RootRuntimeDisappearance): void => {
    deps.operations.notifyRootDisappeared(disappearance);
  };
  const kiloRuntimes = createWorktreeKiloRuntimes({
    onDiagnostic: diagnostics.onDiagnostic,
    onRootRetirementStarted: markRootRetirementStarted,
    onRootDisappeared: notifyRootDisappeared,
    onRootRetirement: settleRootRetirement,
    onEvent: (runtime, event) => {
      mutationNotifications.observe(runtime, event);
      const identity = sessionEventIdentity({
        ...event,
        sessionId: eventKiloSessionId(event.properties),
        runtimeDirectory: runtime.directory,
      });
      if (
        !identity?.rootKiloSessionId ||
        (runtime.isolation === 'per-session' &&
          identity.rootKiloSessionId !== runtime.identity?.kiloSessionId)
      )
        return;
      updateSessionSnapshots(event, deps.sessions);
      deps.activity?.observeEvent(
        event.type,
        identity.kiloSessionId,
        identity.rootKiloSessionId,
        event.properties
      );
      let publication: Promise<boolean>;
      try {
        publication = Promise.resolve(
          control?.publishSessionEvent?.(
            { type: event.type, properties: event.properties },
            identity
          ) ?? false
        );
      } catch {
        reportPublicationAdmissionFailure(runtime, identity);
        return;
      }
      void publication.then(
        published => {
          if (!published) reportPublicationAdmissionFailure(runtime, identity);
        },
        () => reportPublicationAdmissionFailure(runtime, identity)
      );
    },
    onUnexpectedClose: failure => {
      logToFile(`Kilo worktree retired reason=${failure.reason} directory=${failure.directory}`);
      const stillCurrent = () => {
        const current = kiloRuntimes.get(failure.identity);
        return current === undefined || current.runtimeId === failure.runtimeId;
      };
      if (failure.cleanup === 'unconfirmed' || !control?.reportNativeRuntimeRetirement) {
        if (stillCurrent()) shutdown(1, failure.reason, heartbeatReasonFrom(failure.reason));
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
            if (!retired && stillCurrent())
              shutdown(1, failure.reason, heartbeatReasonFrom(failure.reason));
          },
          () => {
            if (stillCurrent()) shutdown(1, failure.reason, heartbeatReasonFrom(failure.reason));
          }
        );
    },
  });
  const terminalRuntime = controlConfig.SANDBOX_CONTROL_URL
    ? createControlTerminalRuntime({
        controlUrl: controlConfig.SANDBOX_CONTROL_URL,
        wrapperInstanceId: controlConfig.wrapperInstanceId,
        getKiloRuntime: identity => kiloRuntimes.get(identity),
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
    scopedCleanupResult: () => control?.supportsScopedCleanupResult?.() === true,
    sendOperationResult: (session, delivery, signal, deadlineAt) => {
      if (!control?.sendOperationResult)
        throw new Error('Sandbox control operation result delivery unavailable');
      return control.sendOperationResult(session, delivery, signal, deadlineAt);
    },
    emitSessionEvent: (session, payload, options) => {
      const identity = {
        directory: session.directory,
        kiloSessionId: session.kiloSessionId,
        rootKiloSessionId:
          rootForSession(session.kiloSessionId, session.directory) ?? session.kiloSessionId,
        ...(options?.nativeRuntimeId ? { nativeRuntimeId: options.nativeRuntimeId } : {}),
      };
      const delivered =
        control?.sendEvent?.(
          'session.event',
          payload,
          identity,
          options?.retained ? { preserveConnectionOnFailure: true } : undefined
        ) === true;
      if (!delivered) startPublicationFailure(identity, 'Session event delivery failed');
      return delivered;
    },
    retireRuntime: reason => shutdown(1, reason, heartbeatReasonFrom(reason)),
    onShutdown: () => shutdown(0, 'Sandbox shutting down'),
  });

  function beginPublicationFailure(
    runtime: WorktreeKiloRuntime,
    identity: SessionEventIdentity,
    reason: string
  ): PublicationFailureAttempt | undefined {
    const root = identity.rootKiloSessionId ?? identity.kiloSessionId;
    const ownerDirectory = ownerDirectoryForSession(identity);
    if (
      !root ||
      !ownerDirectory ||
      ownerDirectory !== runtime.directory ||
      (identity.nativeRuntimeId && identity.nativeRuntimeId !== runtime.runtimeId)
    )
      return undefined;
    const nativeRuntimeId = identity.nativeRuntimeId ?? runtime.runtimeId;
    const target = { runtimeId: runtime.runtimeId, client: runtime.kiloClient };
    const deadlineAt = Date.now() + KILO_CONTROL_REQUEST_TIMEOUT_MS;
    return deps.operations.escalateRootPublication({
      directory: ownerDirectory,
      root,
      nativeRuntimeId,
      target,
      reason,
      deadlineAt,
    });
  }

  async function retirePublicationFailure(
    runtime: WorktreeKiloRuntime,
    identity: SessionEventIdentity,
    reason: string
  ): Promise<PublicationRetirementResult> {
    const attempt = beginPublicationFailure(runtime, identity, reason);
    if (!attempt)
      return {
        scope: 'runtime',
        status: 'unconfirmed',
        cleanup: 'unconfirmed',
        physical: 'stale',
        quiescent: false,
        runtimeRetired: false,
        physicalAttemptStarted: false,
      };
    return attempt.physical;
  }

  function reportPublicationAdmissionFailure(
    runtime: WorktreeKiloRuntime,
    identity: SessionEventIdentity
  ): void {
    try {
      void retirePublicationFailure(runtime, identity, 'Session event delivery failed').catch(
        () => {
          diagnostics.onDiagnostic('wrapper.lifecycle', { phase: 'failed' });
        }
      );
    } catch {
      diagnostics.onDiagnostic('wrapper.lifecycle', { phase: 'failed' });
    }
  }

  function startPublicationFailure(identity: SessionEventIdentity, reason: string): void {
    const ownerDirectory = ownerDirectoryForSession(identity);
    if (!ownerDirectory) return;
    const runtime = kiloRuntimes.get(ownerDirectory);
    if (!runtime) return;
    const attempt = beginPublicationFailure(runtime, identity, reason);
    if (!attempt) return;
    void attempt.physical.catch(() => {
      diagnostics.onDiagnostic('wrapper.lifecycle', { phase: 'failed' });
    });
  }

  const mutationNotifications = createWorktreeMutationNotifications({
    sessions: deps.sessions,
    kiloRuntimes: {
      get: identity => kiloRuntimes.get(identity),
      isCurrent: runtime =>
        kiloRuntimes.isCurrent?.(runtime) ?? kiloRuntimes.get(runtime.directory) === runtime,
    },
    signal: abort.signal,
    sendEvent: (event, payload, identity) => control?.sendEvent?.(event, payload, identity),
  });

  function withHeartbeatReason(payload: SandboxHeartbeatPayload): SandboxHeartbeatPayload {
    if (!payload.kilo.ready && heartbeatReason) payload.kilo.reason = heartbeatReason;
    return payload;
  }

  function reportOutboxRetirement(
    failure: ControlEventOutboxFailure,
    nativeRuntimeId: string,
    phase: 'started' | 'retired' | 'failed',
    ok?: boolean
  ): void {
    const fields = {
      phase,
      category:
        failure.publication.event === 'session.preparing'
          ? ('preparing' as const)
          : ('session_event' as const),
      sessionId: failure.publication.session.kiloSessionId,
      receiptId: failure.publication.receiptId,
      sequence: failure.publication.sequence,
      wrapperInstanceId,
      nativeRuntimeId,
      failureReason: failure.reason,
      outboxExpiryRetirement: failure.reason === 'expired',
      ...(ok === undefined ? {} : { ok }),
    };
    diagnostics.onDiagnostic('control.event', fields);
    logToFile(
      `control diagnostic ${JSON.stringify({
        event: 'outbox_retirement',
        publicationEvent: failure.publication.event,
        ...fields,
      })}`
    );
  }

  type SessionAttachResult =
    | { kind: 'response'; response: Awaited<ReturnType<typeof handleControlRequest>> }
    | { kind: 'failed' };

  function reportSessionAttachResult(
    session: Parameters<typeof handleControlRequest>[1],
    authorization: Parameters<typeof handleControlRequest>[4],
    outcome: SessionAttachResult
  ): void {
    if (outcome.kind === 'failed') {
      diagnostics.onDiagnostic('control.request', {
        phase: 'response_failed',
        operation: 'session.attach',
        sessionId: session?.sessionId,
        requestId: authorization?.operationId,
        scopeId: session?.kiloSessionId,
        wrapperInstanceId,
        ok: false,
        errorCode: 'other',
        retryable: false,
      });
      logToFile(
        `control diagnostic ${JSON.stringify({
          event: 'session_attach_result',
          operationId: authorization?.operationId,
          attemptId: authorization?.operationId,
          sessionId: session?.sessionId,
          kiloSessionId: session?.kiloSessionId,
          wrapperInstanceId,
          ok: false,
          result: 'failed',
          errorCode: 'other',
          retryable: false,
        })}`
      );
      return;
    }
    const { response } = outcome;
    const attached = response.ok ? sessionAttachResultSchema.safeParse(response.result) : undefined;
    diagnostics.onDiagnostic('control.request', {
      phase: response.ok ? 'response_sent' : 'response_failed',
      operation: 'session.attach',
      sessionId: session?.sessionId,
      requestId: authorization?.operationId,
      scopeId: session?.kiloSessionId,
      wrapperInstanceId,
      nativeRuntimeId: attached?.success ? attached.data.nativeRuntimeId : undefined,
      ok: response.ok,
      errorCode: response.ok ? undefined : response.error.code,
      retryable: response.ok ? undefined : response.error.retryable,
    });
    logToFile(
      `control diagnostic ${JSON.stringify({
        event: 'session_attach_result',
        operationId: authorization?.operationId,
        attemptId: authorization?.operationId,
        sessionId: session?.sessionId,
        kiloSessionId: session?.kiloSessionId,
        wrapperInstanceId,
        nativeRuntimeId: attached?.success ? attached.data.nativeRuntimeId : undefined,
        ok: response.ok,
        result: response.ok ? 'accepted' : 'rejected',
        errorCode: response.ok ? undefined : response.error.code,
        retryable: response.ok ? undefined : response.error.retryable,
      })}`
    );
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
    const detail = diagnosticDetail(reason);
    diagnostics.onDiagnostic('wrapper.lifecycle', {
      phase: 'stopping',
      exitCode,
      retirementCause: classifyRetirementCause(reason, diagnosticReason),
      ...(detail ? { detail } : {}),
    });
    void diagnostics.flush();
    logToFile(`control-plane wrapper retiring exitCode=${exitCode} reason=${reason}`);
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
        const fileRemaining = KILO_CONTROL_REQUEST_TIMEOUT_MS - (Date.now() - shutdownAt) - 100;
        await fileLogs.finalize(Math.max(1, Math.min(5000, fileRemaining)));
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
      getRuntime: (directory, nativeRuntimeId) => {
        const runtime = kiloRuntimes.getRetained?.(directory, nativeRuntimeId);
        return runtime && !runtime.signal.aborted ? runtime : undefined;
      },
      onFailure: (failure, runtime) => {
        reportOutboxRetirement(failure, runtime.runtimeId, 'started');
        const attempt = beginPublicationFailure(
          runtime,
          failure.publication.session,
          `Session event delivery ${failure.reason}`
        );
        if (!attempt) return;
        return attempt.cleanup.then(
          cleanup => {
            if (cleanup === 'confirmed') {
              reportOutboxRetirement(failure, runtime.runtimeId, 'retired', true);
              return;
            }
            void attempt.physical.then(
              result => {
                if (result.runtimeRetired || result.physical === 'stale')
                  reportOutboxRetirement(failure, runtime.runtimeId, 'retired', true);
                else if (result.scope === 'root')
                  reportOutboxRetirement(failure, runtime.runtimeId, 'failed', false);
                else {
                  reportOutboxRetirement(failure, runtime.runtimeId, 'failed', false);
                  diagnostics.onDiagnostic('wrapper.lifecycle', { phase: 'failed' });
                }
              },
              () => {
                reportOutboxRetirement(failure, runtime.runtimeId, 'failed', false);
                diagnostics.onDiagnostic('wrapper.lifecycle', { phase: 'failed' });
              }
            );
          },
          () => {
            void attempt.physical.catch(() => undefined);
            reportOutboxRetirement(failure, runtime.runtimeId, 'failed', false);
            diagnostics.onDiagnostic('wrapper.lifecycle', { phase: 'failed' });
          }
        );
      },
    }),
    onDisconnected: () => shutdown(1, 'Sandbox control connection lost', 'control_disconnected'),
    onReconcile: async (_phase, deadlineAt) => {
      if (Date.now() >= deadlineAt) throw new Error('Control recovery deadline expired');
      await deps.operations.drainDelivery(deadlineAt);
    },
    onRequest: async (operation, session, payload, authorization) => {
      try {
        const response = await handleControlRequest(
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
                    ...(options?.nativeRuntimeId
                      ? { nativeRuntimeId: options.nativeRuntimeId }
                      : {}),
                  },
                  options?.retained ? { preserveConnectionOnFailure: true } : undefined
                )
              )
                throw new Error('Preparation event delivery failed');
            },
          },
          authorization
        );
        if (operation === 'session.attach') {
          reportSessionAttachResult(session, authorization, { kind: 'response', response });
        }
        return response;
      } catch (error) {
        if (operation === 'session.attach') {
          reportSessionAttachResult(session, authorization, { kind: 'failed' });
        }
        throw error;
      }
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
const uploadUrl = process.env.CONTROL_LOG_UPLOAD_URL;
const uploadGrant = process.env.CONTROL_LOG_UPLOAD_GRANT;
const diagnostics = createControlDiagnostics({
  uploadUrl,
  uploadGrant,
});
const fileLogs = createControlFileLogUploader({
  uploadUrl,
  uploadGrant,
  wrapperLogPath: process.env.WRAPPER_LOG_PATH,
  onDiagnostic: diagnostics.onDiagnostic,
});
delete process.env.CONTROL_LOG_UPLOAD_URL;
delete process.env.CONTROL_LOG_UPLOAD_GRANT;
delete process.env.CONTROL_WRAPPER_INSTANCE_ID;
diagnostics.onDiagnostic('wrapper.lifecycle', { phase: 'starting' });
diagnostics.start();
fileLogs.start();

try {
  main(diagnostics, fileLogs, wrapperInstanceId);
} catch {
  diagnostics.onDiagnostic('wrapper.lifecycle', { phase: 'start_failed' });
  logToFile('control-plane wrapper failed');
  void diagnostics
    .finalize()
    .then(() => fileLogs.finalize())
    .finally(() => process.exit(1));
}
