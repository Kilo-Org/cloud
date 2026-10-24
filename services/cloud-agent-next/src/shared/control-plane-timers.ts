export const CONTROL_PLANE_TIMER_OVERRIDE_ENV = 'CONTROL_PLANE_TIMER_DIVISOR';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

// Spec §5: queued backstop = reconnect window + one preparation attempt + 3 min;
// accepted backstop = turn hard cap + 5 min.
const QUEUED_BACKSTOP_MARGIN_MS = 3 * MINUTE_MS;
const ACCEPTED_BACKSTOP_MARGIN_MS = 5 * MINUTE_MS;
// Spec §8 "provider lease": existing lease length, the idle stop plus 1 min.
const PROVIDER_LEASE_MARGIN_MS = MINUTE_MS;

export type ControlPlaneTimers = {
  session: {
    queuedBackstopMs: number;
    acceptedBackstopMs: number;
    sandboxRpcDeadlineMs: number;
    transportRecoveryMs: number;
    /** Total bound on serving one scope handle through a surviving member. */
    scopeResolutionMs: number;
  };
  sandbox: {
    providerCreateMs: number;
    providerCreateRetryMs: number;
    wrapperFirstConnectMs: number;
    wrapperHelloMs: number;
    heartbeatMs: number;
    reconnectMs: number;
    routePreparationMs: number;
    idleMs: number;
    unattendedIdleMs: number;
    sessionNotifyDeadlineMs: number;
    providerLeaseMs: number;
    credentialGrantMs: number;
    credentialGrantReissueBelowMs: number;
    /** Bounds one member's backing renewal during scope-handle resolution. */
    scopeBackingTokenMs: number;
    providerStopAttemptMs: number;
    providerStopLadderMs: readonly number[];
  };
  wrapper: {
    heartbeatIntervalMs: number;
    heartbeatAckTimeoutMs: number;
    heartbeatNegotiationMs: number;
    handshakeMs: number;
    cloneMs: number;
    /** Budget to adopt a repository snapshot before falling back to a clone. */
    restoreMs: number;
    /** Backstop over the Sandbox DO's own capture timeout. */
    captureMs: number;
    kiloRuntimeStartMs: number;
    kiloSessionMs: number;
    sseSilenceMs: number;
    healthRequestMs: number;
    sseReconnectLimit: number;
    sseReconnectWindowMs: number;
    kiloRestartLimit: number;
    kiloRestartWindowMs: number;
    /**
     * Longest a silent Kilo is left running, instead of a hang restart, while the workload
     * reclaims at its memory cap. The no-progress clock is paused for that time.
     */
    kiloMemoryHoldMs: number;
    noProgressMs: number;
    turnHardCapMs: number;
    reconnectBackoffMinMs: number;
    reconnectBackoffMaxMs: number;
  };
  supervisor: {
    wrapperRestartLimit: number;
    wrapperRestartWindowMs: number;
  };
};

// External-work bounds for one preparation attempt. They stay real (never
// scaled) because they bound provider and container work.
const PROVIDER_CREATE_MS = 2 * MINUTE_MS;
const PROVIDER_CREATE_RETRY_MS = 10_000;
// A repository-backed container allocation creates its sandbox under the wider
// repository startup bound (`DEADLINE_MS.repositoryStartup` in
// `sandbox-control/deadlines.ts`), which is the create path every preparation
// attempt with a repository takes. It is restated here because this module is
// bundled into the wrapper without the worker's other sources;
// `control-plane-timers.test.ts` asserts the attempt budget against that bound.
const PREPARATION_CREATE_MS = 5 * MINUTE_MS;
const WRAPPER_FIRST_CONNECT_MS = 5 * MINUTE_MS;
const WRAPPER_HELLO_MS = 30_000;
const RESTORE_MS = 2 * MINUTE_MS;
const CLONE_MS = 6 * MINUTE_MS;
// The attempt's own last workspace step: the Sandbox DO saves the prepared
// workspace for a repository-backed route, and preparation waits for it.
const CAPTURE_MS = 5 * MINUTE_MS + 10_000;
const KILO_RUNTIME_START_MS = 2 * MINUTE_MS;
const KILO_SESSION_MS = 2 * MINUTE_MS;

/**
 * One preparation attempt runs these steps in order: sandbox create, wrapper
 * first connect and hello, snapshot restore (falling back to a clone), the
 * workspace save, Kilo runtime start, then the session import. Every step keeps
 * its own bound, so the attempt deadline is their sum. A shorter deadline fails
 * a slow but valid preparation as `preparation_timeout` while each step stayed
 * inside its own budget — the failure names a timeout the plan never allowed to
 * finish.
 *
 * Two steps are retried once inside the same attempt, so each counts twice.
 * A transient create failure pauses and creates again inside the same attempt
 * (`control-plane/sandbox/allocation.ts`), so one retried create is counted
 * too. Further retries stay bounded by this deadline, which is what stops a
 * create that keeps failing.
 *
 * Setup commands have no term here. Each command carries its own inactivity and
 * hard timeout (`wrapper/src/control-plane/prepare.ts`), while how many run and
 * how long each takes are the route's configuration (bounded per command, not in
 * total). This deadline is therefore their aggregate stop by design: a route
 * whose setup work together outlasts the attempt fails as
 * `preparation_timeout`, because a bound that grew with the configured command
 * count would also stretch how long a stuck preparation can hold a session.
 */
const ROUTE_PREPARATION_MS =
  PREPARATION_CREATE_MS +
  PROVIDER_CREATE_RETRY_MS +
  PREPARATION_CREATE_MS +
  WRAPPER_FIRST_CONNECT_MS +
  WRAPPER_HELLO_MS +
  RESTORE_MS +
  CLONE_MS +
  CAPTURE_MS +
  2 * KILO_RUNTIME_START_MS +
  2 * KILO_SESSION_MS;

// The divisor shortens only internal deadlines whose partner also scales, so
// their orderings hold (the 90-s reconnect window stays longer than the 30-s
// max backoff). Timers that bound external work stay real: provider create and
// container boot, the prep attempt that must outlast create+connect+restore+
// clone+save+runtime+session, the pause before a failed create is retried,
// restore/clone/save/runtime/session bounds, SSE silence (Kilo heartbeats every
// 10-15 s), health request, the real-SSE reconnect window, credential grants
// and the provider stop ladder.
function buildControlPlaneTimers(divisor: number): ControlPlaneTimers {
  const ms = (value: number): number => Math.max(1, Math.round(value / divisor));
  const sandbox = {
    providerCreateMs: PROVIDER_CREATE_MS,
    providerCreateRetryMs: PROVIDER_CREATE_RETRY_MS,
    wrapperFirstConnectMs: WRAPPER_FIRST_CONNECT_MS,
    wrapperHelloMs: WRAPPER_HELLO_MS,
    heartbeatMs: ms(45_000),
    reconnectMs: ms(90_000),
    routePreparationMs: ROUTE_PREPARATION_MS,
    idleMs: ms(10 * MINUTE_MS),
    unattendedIdleMs: ms(MINUTE_MS),
    // Bounds one Sandbox -> Session notification; real (not scaled) like the
    // other bounds on external work.
    sessionNotifyDeadlineMs: 2_000,
    credentialGrantMs: 4 * HOUR_MS,
    credentialGrantReissueBelowMs: HOUR_MS,
    // Bounds external token renewal, so it stays real and short enough for the
    // Session DO's total scope-resolution bound.
    scopeBackingTokenMs: 3_000,
    providerStopAttemptMs: 30_000,
    providerStopLadderMs: [5_000, 10_000, 10_000, 10_000, 10_000],
  };
  const wrapper = {
    heartbeatIntervalMs: ms(5_000),
    heartbeatAckTimeoutMs: ms(15_000),
    heartbeatNegotiationMs: ms(1_000),
    // Scales with the reconnect window it must stay inside.
    handshakeMs: ms(30_000),
    cloneMs: CLONE_MS,
    restoreMs: RESTORE_MS,
    captureMs: CAPTURE_MS,
    kiloRuntimeStartMs: KILO_RUNTIME_START_MS,
    kiloSessionMs: KILO_SESSION_MS,
    sseSilenceMs: 30_000,
    healthRequestMs: 5_000,
    sseReconnectLimit: 6,
    sseReconnectWindowMs: 2 * MINUTE_MS,
    kiloRestartLimit: 3,
    kiloRestartWindowMs: ms(10 * MINUTE_MS),
    // Allow transient reclaim to clear while bounding a sustained memory stall.
    kiloMemoryHoldMs: ms(2 * MINUTE_MS),
    noProgressMs: ms(20 * MINUTE_MS),
    turnHardCapMs: ms(120 * MINUTE_MS),
    reconnectBackoffMinMs: ms(1_000),
    reconnectBackoffMaxMs: ms(30_000),
  };
  // Spec §7 "Supervisor": `wrapper/control-plane-supervisor.sh` is the runtime
  // owner of these two values (it runs outside the bundle and cannot import
  // this module). They are kept here for reference and must match the script,
  // which scales the window by `CONTROL_PLANE_TIMER_DIVISOR` and keeps the
  // limit as a count.
  const supervisor = {
    wrapperRestartLimit: 5,
    wrapperRestartWindowMs: ms(10 * MINUTE_MS),
  };
  return {
    session: {
      sandboxRpcDeadlineMs: 2_000,
      // Bounds external work (member token renewal), so it stays real. Well
      // under the facade's retry budget: a handle that cannot be served in this
      // window fails as `unavailable` rather than hanging the proxy response.
      scopeResolutionMs: 6_000,
      transportRecoveryMs: ms(15_000),
      queuedBackstopMs:
        sandbox.reconnectMs + sandbox.routePreparationMs + QUEUED_BACKSTOP_MARGIN_MS,
      acceptedBackstopMs: wrapper.turnHardCapMs + ACCEPTED_BACKSTOP_MARGIN_MS,
    },
    sandbox: {
      ...sandbox,
      providerLeaseMs: sandbox.idleMs + PROVIDER_LEASE_MARGIN_MS,
    },
    wrapper,
    supervisor,
  };
}

export const CONTROL_PLANE_TIMERS: ControlPlaneTimers = buildControlPlaneTimers(1);

export type SandboxIdlePolicy = 'interactive' | 'unattended';

/**
 * The idle policy for a sandbox from its routes' session origins. A sandbox
 * without routes keeps the interactive window so a released route (session
 * deletion, runtime-authorization refresh) does not stop a sandbox the next
 * prepare could reuse.
 */
export function sandboxIdlePolicyForOrigins(origins: readonly unknown[]): SandboxIdlePolicy {
  return origins.length === 0 ||
    origins.some(origin => origin === 'cloud-agent-web' || origin === 'desktop')
    ? 'interactive'
    : 'unattended';
}

// Positive integer divisor that shortens internal deadline timers for local E2E. Pass `env` on the Worker/DO side or `process.env` in the wrapper. Development-only by absence from production config; do not add it to wrangler.jsonc.
export function resolveControlPlaneTimers(
  source: Record<string, string | undefined>
): ControlPlaneTimers {
  const raw = source[CONTROL_PLANE_TIMER_OVERRIDE_ENV];
  if (raw === undefined || !/^\d+$/.test(raw)) return CONTROL_PLANE_TIMERS;
  const divisor = Number(raw);
  return divisor >= 1 ? buildControlPlaneTimers(divisor) : CONTROL_PLANE_TIMERS;
}
