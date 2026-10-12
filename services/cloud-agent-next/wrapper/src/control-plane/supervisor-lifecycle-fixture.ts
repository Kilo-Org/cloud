// Test fixture for the supervisor lifecycle regression. A real wrapper process
// stand-in that runs the REAL deciding code (`controlPlaneExitPolicy` +
// `createControlPlaneLifecycle`) and, in shutdown-frame mode, the REAL
// authenticated connection frame path. It never hardcodes an exit code: the
// exit comes from the production modules under test.
//
//   FIXTURE_MODE=ready           real lifecycle over a stub (non-deciding)
//                                connection; exits only via the real
//                                SIGTERM/uncaught handlers.
//   FIXTURE_MODE=shutdown-frame  real connection to CONTROL_PLANE_URL using
//                                SANDBOX_CONTROL_CREDENTIAL; an authenticated
//                                `shutdown` frame maps through the real
//                                `controlPlaneExitPolicy('shutdown')`.
import { appendFileSync } from 'node:fs';
import { controlPlaneExitPolicy, createControlPlaneLifecycle } from './main.js';
import { createControlPlaneConnection, type ControlPlaneConnection } from './connection.js';
import { resolveControlPlaneTimers } from '../../../src/shared/control-plane-timers.js';

const mode = process.env.FIXTURE_MODE ?? 'ready';
const pidFile = process.env.WRAPPER_PID_FILE;
if (pidFile) appendFileSync(pidFile, `${process.pid}\n`);

function emit(line: string): void {
  process.stderr.write(`fixture:${mode}: ${line}\n`);
}

const readyConnection: ControlPlaneConnection = {
  wrapperId: 'fixture',
  snapshot: () => ({ phase: 'idle', attempt: 0, outboxBytes: 0 }),
  start: () => undefined,
  send: () => undefined,
  recycle: () => undefined,
  close: () => undefined,
};

const lifecycleRef: { current?: ReturnType<typeof createControlPlaneLifecycle> } = {};
const connection =
  mode === 'shutdown-frame'
    ? createControlPlaneConnection({
        url: process.env.CONTROL_PLANE_URL ?? '',
        credential: process.env.SANDBOX_CONTROL_CREDENTIAL ?? '',
        allocationId: 'fixture-allocation',
        timers: resolveControlPlaneTimers(process.env),
        log: emit,
        onConnected: () => emit('connected'),
        onShutdown: reason => {
          void lifecycleRef.current?.shutdown(
            controlPlaneExitPolicy('shutdown') ?? 0,
            reason ?? 'sandbox shutdown'
          );
        },
      })
    : readyConnection;

const lifecycle = createControlPlaneLifecycle({
  connection,
  diagnostics: { onDiagnostic: () => undefined, finalize: async () => undefined },
  fileLogs: { finalize: async () => undefined },
  exit: code => {
    emit(`exit ${code}`);
    process.exit(code);
  },
  log: emit,
});
lifecycleRef.current = lifecycle;
lifecycle.start();
emit('ready');

// Keep the event loop alive; the real handlers decide the exit, not this timer.
setInterval(() => undefined, 1 << 30);
