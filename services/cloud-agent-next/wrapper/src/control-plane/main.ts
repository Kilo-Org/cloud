import {
  CONTROL_PLANE_ALLOCATION_ID_ENV,
  type ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';
import {
  createControlDiagnosticProjector,
  diagnosticDetail,
  nativeControlPlaneLogsEnabled,
  type ControlDiagnosticReporter,
} from '../../../src/shared/control-diagnostics.js';
import { resolveControlPlaneTimers } from '../../../src/shared/control-plane-timers.js';
import { installInterceptTrustIfEnabled } from '../control/cert.js';
import { createControlDiagnostics, type ControlDiagnostics } from '../control/diagnostics.js';
import {
  closeControlWorkload,
  initializeControlWorkload,
  readWorkloadStats,
} from '../control/workload-cgroup.js';
import { createSetupSpawn } from '../control/setup-cgroup.js';
import {
  createControlFileLogUploader,
  type ControlFileLogUploader,
} from '../control/file-log-uploader.js';
import { logToFile } from '../utils.js';
import { createControlPlaneConnection, type ControlPlaneConnection } from './connection.js';
import {
  cleanupStaleKiloPidfiles,
  createKiloRuntimes,
  defaultKiloPidfileDirectory,
} from './kilo-runtime.js';
import { createPreparationManager, runtimeKey } from './prepare.js';
import { createTurnManager, type TurnManager } from './turn.js';
import { createControlPlaneTerminals } from './terminals.js';
import { createNativeStatusReporter } from './native-status.js';
import { createControlPlaneWorktreeChanges } from './worktree-changes.js';
import { createControlPlaneWorktreeDeletion } from './worktree-deletion.js';
import { createWorktreeKiloCleanupClient } from '../control/delete-worktree.js';

const DIAGNOSTICS_FINALIZE_TIMEOUT_MS = 4_000;
const FILE_LOG_FINALIZE_TIMEOUT_MS = 5_000;

export type ControlPlaneExitEvent =
  | 'shutdown'
  | 'sigterm'
  | 'uncaught_exception'
  | 'unhandled_rejection';

/**
 * Spec §7 "Crash resistance": the wrapper exits only on `shutdown` (exit 0 so
 * the supervisor does not restart it), SIGTERM (exit 0), or an uncaught
 * exception (exit 1 so the supervisor restarts it). An unhandled rejection is
 * logged and does not exit.
 */
export function controlPlaneExitPolicy(event: ControlPlaneExitEvent): number | null {
  switch (event) {
    case 'shutdown':
    case 'sigterm':
      return 0;
    case 'uncaught_exception':
      return 1;
    case 'unhandled_rejection':
      return null;
  }
}

export type ControlPlaneProcess = {
  once(event: 'SIGTERM' | 'uncaughtException', listener: () => void): unknown;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
};

export type ControlPlaneLifecycleDeps = {
  connection: ControlPlaneConnection;
  diagnostics: Pick<ControlDiagnostics, 'onDiagnostic' | 'finalize'>;
  fileLogs: Pick<ControlFileLogUploader, 'finalize'>;
  onNativeDiagnostic?: ControlDiagnosticReporter;
  exit: (code: number) => void;
  process?: ControlPlaneProcess;
  log?: (message: string) => void;
  /** Stops owned Kilo runtimes before the process exits. */
  stop?: () => Promise<void>;
};

export type ControlPlaneLifecycle = {
  start(): void;
  shutdown(exitCode: number, reason: string): Promise<void>;
  recycle(): void;
};

function rejectionDetail(reason: unknown): string {
  const text = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
  return diagnosticDetail(text) ?? '';
}

async function settle(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch {
    // Diagnostics and log upload must never block the exit.
  }
}

export function createControlPlaneLifecycle(
  deps: ControlPlaneLifecycleDeps
): ControlPlaneLifecycle {
  const log = deps.log ?? ((): void => undefined);
  const proc = deps.process ?? process;
  let shuttingDown = false;

  async function shutdown(exitCode: number, reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`control-plane wrapper stopping exitCode=${exitCode} reason=${reason}`);
    deps.connection.close();
    await settle(() => deps.stop?.() ?? Promise.resolve());
    const detail = diagnosticDetail(reason);
    deps.diagnostics.onDiagnostic('wrapper.lifecycle', {
      phase: exitCode === 0 ? 'stopping' : 'failed',
      exitCode,
      ...(detail ? { detail } : {}),
    });
    await settle(() => deps.diagnostics.finalize(DIAGNOSTICS_FINALIZE_TIMEOUT_MS));
    await settle(() => deps.fileLogs.finalize(FILE_LOG_FINALIZE_TIMEOUT_MS));
    deps.exit(exitCode);
  }

  function handleExitEvent(event: ControlPlaneExitEvent, reason: string): void {
    const exitCode = controlPlaneExitPolicy(event);
    if (exitCode === null) {
      log(`control-plane wrapper ignored ${reason}`);
      return;
    }
    void shutdown(exitCode, reason);
  }

  proc.once('SIGTERM', () => handleExitEvent('sigterm', 'SIGTERM'));
  proc.once('uncaughtException', () => handleExitEvent('uncaught_exception', 'uncaught exception'));
  proc.on('unhandledRejection', reason => {
    // Closed native record: the free-text reason stays in the file log only.
    deps.onNativeDiagnostic?.('wrapper.lifecycle', {
      phase: 'failed',
      retirementCause: 'unhandled_rejection',
    });
    const detail = rejectionDetail(reason);
    handleExitEvent('unhandled_rejection', `unhandled rejection${detail ? `: ${detail}` : ''}`);
  });

  return {
    start(): void {
      deps.connection.start();
    },
    shutdown,
    recycle(): void {
      if (shuttingDown) return;
      deps.connection.recycle();
    },
  };
}

/**
 * Process entry for the control-plane wrapper. Runs forever until `shutdown`
 * frame, SIGTERM or an uncaught exception; a disconnect never exits.
 */
export async function runControlPlaneWrapper(
  env: Record<string, string | undefined> = process.env
): Promise<ControlPlaneLifecycle | undefined> {
  const uploadUrl = env.CONTROL_LOG_UPLOAD_URL;
  const uploadGrant = env.CONTROL_LOG_UPLOAD_GRANT;
  const projector = createControlDiagnosticProjector({
    enabled: nativeControlPlaneLogsEnabled(env),
  });
  const diagnostics = createControlDiagnostics({ uploadUrl, uploadGrant, projector });
  const fileLogs = createControlFileLogUploader({
    uploadUrl,
    uploadGrant,
    wrapperLogPath: env.WRAPPER_LOG_PATH,
    onDiagnostic: diagnostics.onDiagnostic,
    projector,
  });
  const url = env.SANDBOX_CONTROL_URL;
  const credential = env.SANDBOX_CONTROL_CREDENTIAL;
  const allocationId = env[CONTROL_PLANE_ALLOCATION_ID_ENV];
  delete env.SANDBOX_CONTROL_CREDENTIAL;
  delete env.CONTROL_LOG_UPLOAD_URL;
  delete env.CONTROL_LOG_UPLOAD_GRANT;
  delete env.CONTROL_WRAPPER_INSTANCE_ID;

  diagnostics.onDiagnostic('wrapper.lifecycle', { phase: 'starting' });
  await installInterceptTrustIfEnabled(logToFile, undefined, projector);
  diagnostics.start();
  fileLogs.start();

  if (!url || !credential || !allocationId) {
    logToFile('control-plane wrapper is missing its launch environment');
    diagnostics.onDiagnostic('wrapper.lifecycle', { phase: 'start_failed' });
    await settle(() => diagnostics.finalize(DIAGNOSTICS_FINALIZE_TIMEOUT_MS));
    await settle(() => fileLogs.finalize(FILE_LOG_FINALIZE_TIMEOUT_MS));
    return undefined;
  }

  // Spec §7 "Crash resistance": clear stale Kilo process groups before any Kilo spawn.
  await cleanupStaleKiloPidfiles({
    directory: defaultKiloPidfileDirectory(env),
    log: logToFile,
  }).catch(() => 0);

  const timers = resolveControlPlaneTimers(env);
  // Keep the tool/workload cgroup placement for the Kilo server chain.
  const workload = initializeControlWorkload({ env, report: diagnostics.onDiagnostic });
  // The connection's shutdown callback needs the lifecycle that owns the same
  // connection, so route it through a holder assigned after construction.
  const shutdownRef: { current?: (reason: string | undefined) => void } = {};
  // Preparation is created after the connection (it emits through it), so the
  // connection reaches it through a holder.
  const preparationRef: { current?: ReturnType<typeof createPreparationManager> } = {};
  // Turns share work with preparation but need the runtimes' restart callbacks,
  // so both sides reach each other through holders.
  const turnsRef: { current?: TurnManager } = {};
  // Worktree-change requests are answered over the same connection, which is
  // created below, so the adapter reaches it through a holder.
  const worktreeChangesRef: {
    current?: ReturnType<typeof createControlPlaneWorktreeChanges>;
  } = {};
  // Terminal requests also answer over the same connection, so the adapter
  // reaches it through a holder.
  const terminalsRef: { current?: ReturnType<typeof createControlPlaneTerminals> } = {};
  // Worktree-deletion requests also answer over the same connection (R2).
  const worktreeDeletionRef: {
    current?: ReturnType<typeof createControlPlaneWorktreeDeletion>;
  } = {};
  const runtimes = createKiloRuntimes({
    timers,
    log: logToFile,
    workload,
    onNativeDiagnostic: projector,
    onEvent: event => turnsRef.current?.observeKiloEvent(event),
    onRestart: info => turnsRef.current?.onRuntimeRestart(info),
    onUnavailable: (directory, key) => turnsRef.current?.onRuntimeUnavailable(directory, key),
  });
  const connection = createControlPlaneConnection({
    url,
    credential,
    allocationId,
    timers,
    log: logToFile,
    onNativeDiagnostic: projector,
    getHeartbeat: () => ({
      active:
        (preparationRef.current?.isPreparing() ?? false) ||
        (turnsRef.current?.isActive() ?? false) ||
        (terminalsRef.current?.hasRecentInput() ?? false),
      degraded: runtimes.suspected(),
    }),
    onFrame: (frame: ControlPlaneWrapperFrame) => {
      switch (frame.type) {
        case 'session.prepare':
          turnsRef.current?.registerRoute(frame.spec);
          void preparationRef.current
            ?.prepare(frame.spec, frame.credentials)
            .then(() => {
              if (preparationRef.current?.isPrepared(frame.spec.sessionId)) {
                try {
                  terminalsRef.current?.rememberAttachedSession(
                    {
                      sessionId: frame.spec.sessionId,
                      kiloSessionId: frame.spec.kiloSessionId,
                      directory: frame.spec.directory,
                    },
                    runtimeKey(frame.spec)
                  );
                } catch {
                  // Terminal attachment is best-effort; a missing runtime is
                  // reported as `not_ready` when a terminal is requested.
                }
              }
              return turnsRef.current?.publishCommands(frame.spec.sessionId);
            })
            .catch(() => undefined);
          return;
        case 'session.credentials':
          void preparationRef.current?.installCredentials(frame);
          return;
        case 'session.prompt':
          turnsRef.current?.submit(frame.sessionId, frame.payload);
          return;
        case 'session.abort':
          turnsRef.current?.abort(frame.sessionId);
          return;
        case 'session.answer':
          void turnsRef.current?.answer(frame.sessionId, frame.reply);
          return;
        case 'session.release':
          turnsRef.current?.release(frame.sessionId);
          preparationRef.current?.release(frame.sessionId);
          void terminalsRef.current?.forgetSession(frame.sessionId);
          return;
        case 'worktree.snapshot':
        case 'worktree.summary':
          void worktreeChangesRef.current?.handle(frame);
          return;
        case 'worktree.prepareDeletion':
        case 'worktree.delete':
          void worktreeDeletionRef.current?.handle(frame);
          return;
        case 'terminal.create':
        case 'terminal.resize':
        case 'terminal.close':
        case 'terminal.connect':
          void terminalsRef.current
            ?.handle(frame)
            .then(result => connection.send(result))
            .catch(() => undefined);
          return;
        default:
          logToFile(`control-plane frame ${frame.type}`);
      }
    },
    onShutdown: reason => shutdownRef.current?.(reason),
    onConnected: () => diagnostics.onDiagnostic('wrapper.lifecycle', { phase: 'ready', ok: true }),
    onDisconnected: reason => logToFile(`control-plane disconnected: ${reason}`),
  });
  terminalsRef.current = createControlPlaneTerminals({
    controlUrl: url,
    wrapperId: connection.wrapperId,
    runtimes,
  });
  turnsRef.current = createTurnManager({
    timers,
    emit: frame => connection.send(frame),
    runtimes: { get: key => runtimes.get(key) },
    log: logToFile,
    onDiagnostic: diagnostics.onDiagnostic,
    onNativeDiagnostic: projector,
  });
  preparationRef.current = createPreparationManager({
    timers,
    onNativeDiagnostic: projector,
    runtimes: {
      ensure: input => runtimes.ensure(input),
      installCredentials: async (key, nextEnv) => {
        await runtimes.get(key)?.installCredentials(nextEnv);
        turnsRef.current?.credentialsInstalled(key);
      },
      isUnavailable: key => {
        const runtime = runtimes.get(key);
        return !runtime || runtime.isUnavailable();
      },
      remove: key => runtimes.remove(key),
      release: key => runtimes.remove(key),
    },
    // Route preparation output (progress/ready/failed) out over the connection.
    emit: frame => connection.send(frame),
    log: logToFile,
    inheritedEnv: env,
    spawnSetup: createSetupSpawn(workload),
  });
  worktreeChangesRef.current = createControlPlaneWorktreeChanges({
    emit: frame => connection.send(frame),
    isPrepared: sessionId => preparationRef.current?.isPrepared(sessionId) ?? false,
    log: logToFile,
  });
  worktreeDeletionRef.current = createControlPlaneWorktreeDeletion({
    emit: frame => connection.send(frame),
    clients: directory =>
      runtimes
        .runtimesForDirectory(directory)
        .map(runtime => createWorktreeKiloCleanupClient(runtime.client.serverUrl)),
    retireDirectory: directory => runtimes.retireDirectory(directory),
    detachTerminals: directory =>
      terminalsRef.current?.detachDirectory(directory) ?? Promise.resolve(),
    onDiagnostic: diagnostics.onDiagnostic,
    log: logToFile,
  });
  const nativeStatus = createNativeStatusReporter({
    enabled: projector.enabled,
    project: projector,
    snapshot: () => {
      const connectionState = connection.snapshot();
      const runtimeSummary = runtimes.summary();
      const placement = workload.placement;
      let stats: ReturnType<typeof readWorkloadStats> | undefined;
      if (placement) {
        try {
          stats = readWorkloadStats(placement.parentReference);
        } catch {
          stats = undefined;
        }
      }
      return {
        nativeConnectionPhase: connectionState.phase,
        attempt: connectionState.attempt,
        outboxBytes: connectionState.outboxBytes,
        sessionCount: preparationRef.current?.sessionCount() ?? 0,
        preparingCount: preparationRef.current?.preparingCount() ?? 0,
        activeTurnCount: turnsRef.current?.activeTurnCount() ?? 0,
        recentTerminalCount: terminalsRef.current?.recentInputCount() ?? 0,
        ...runtimeSummary,
        ...(workload.failure !== undefined ? { workloadFailure: workload.failure } : {}),
        ...(placement
          ? {
              appliedMaxBytes: placement.aggregateMaxBytes,
              cpuController: placement.cpuController,
            }
          : {}),
        ...(stats?.currentBytes !== undefined ? { currentBytes: stats.currentBytes } : {}),
        ...(stats?.peakBytes !== undefined ? { peakBytes: stats.peakBytes } : {}),
        ...(allocationId !== undefined ? { allocationId } : {}),
        wrapperInstanceId: connection.wrapperId,
      };
    },
  });
  const lifecycle = createControlPlaneLifecycle({
    connection,
    diagnostics,
    fileLogs,
    onNativeDiagnostic: projector,
    exit: code => process.exit(code),
    log: logToFile,
    stop: async () => {
      nativeStatus.stop();
      turnsRef.current?.shutdown();
      terminalsRef.current?.shutdown();
      await runtimes.shutdown();
      closeControlWorkload(workload);
    },
  });
  shutdownRef.current = reason => {
    void lifecycle.shutdown(controlPlaneExitPolicy('shutdown') ?? 0, reason ?? 'sandbox shutdown');
  };
  process.on('SIGUSR1', () => lifecycle.recycle());
  nativeStatus.start();
  lifecycle.start();
  return lifecycle;
}

if (import.meta.main) {
  await runControlPlaneWrapper();
}
