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
  };
  sandbox: {
    providerCreateMs: number;
    providerCreateRetryMs: number;
    providerCreateRetryMaxMs: number;
    wrapperFirstConnectMs: number;
    wrapperHelloMs: number;
    heartbeatMs: number;
    reconnectMs: number;
    routePreparationMs: number;
    idleMs: number;
    sessionNotifyDeadlineMs: number;
    providerLeaseMs: number;
    credentialGrantMs: number;
    credentialGrantReissueBelowMs: number;
    providerStopAttemptMs: number;
    providerStopLadderMs: readonly number[];
  };
  wrapper: {
    heartbeatIntervalMs: number;
    heartbeatAckTimeoutMs: number;
    heartbeatNegotiationMs: number;
    cloneMs: number;
    kiloRuntimeStartMs: number;
    kiloSessionMs: number;
    sseSilenceMs: number;
    healthRequestMs: number;
    sseReconnectLimit: number;
    sseReconnectWindowMs: number;
    kiloRestartLimit: number;
    kiloRestartWindowMs: number;
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

// The divisor shortens only internal deadlines whose partner also scales, so
// their orderings hold (the 5-min reconnect window stays longer than the 30-s
// max backoff). Timers that bound external work stay real: provider create and
// container boot, the 12-min prep attempt that must outlast clone+runtime+
// session, the pause before a failed create is retried, clone/runtime/session
// bounds, SSE silence (Kilo heartbeats every 10-15 s), health request, the
// real-SSE reconnect window, credential grants and the provider stop ladder.
function buildControlPlaneTimers(divisor: number): ControlPlaneTimers {
  const ms = (value: number): number => Math.max(1, Math.round(value / divisor));
  const sandbox = {
    providerCreateMs: 2 * MINUTE_MS,
    providerCreateRetryMs: 10_000,
    providerCreateRetryMaxMs: 60_000,
    wrapperFirstConnectMs: 5 * MINUTE_MS,
    wrapperHelloMs: 30_000,
    heartbeatMs: ms(45_000),
    reconnectMs: ms(5 * MINUTE_MS),
    routePreparationMs: 12 * MINUTE_MS,
    idleMs: ms(10 * MINUTE_MS),
    // Bounds one Sandbox -> Session notification; real (not scaled) like the
    // other bounds on external work.
    sessionNotifyDeadlineMs: 2_000,
    credentialGrantMs: 4 * HOUR_MS,
    credentialGrantReissueBelowMs: HOUR_MS,
    providerStopAttemptMs: 30_000,
    providerStopLadderMs: [5_000, 10_000, 10_000, 10_000, 10_000],
  };
  const wrapper = {
    heartbeatIntervalMs: ms(5_000),
    heartbeatAckTimeoutMs: ms(15_000),
    heartbeatNegotiationMs: ms(1_000),
    cloneMs: 6 * MINUTE_MS,
    kiloRuntimeStartMs: 2 * MINUTE_MS,
    kiloSessionMs: 2 * MINUTE_MS,
    sseSilenceMs: 30_000,
    healthRequestMs: 5_000,
    sseReconnectLimit: 6,
    sseReconnectWindowMs: 2 * MINUTE_MS,
    kiloRestartLimit: 3,
    kiloRestartWindowMs: ms(10 * MINUTE_MS),
    noProgressMs: ms(7 * MINUTE_MS),
    turnHardCapMs: ms(60 * MINUTE_MS),
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

// Positive integer divisor that shortens internal deadline timers for local E2E. Pass `env` on the Worker/DO side or `process.env` in the wrapper. Development-only by absence from production config; do not add it to wrangler.jsonc.
export function resolveControlPlaneTimers(
  source: Record<string, string | undefined>
): ControlPlaneTimers {
  const raw = source[CONTROL_PLANE_TIMER_OVERRIDE_ENV];
  if (raw === undefined || !/^\d+$/.test(raw)) return CONTROL_PLANE_TIMERS;
  const divisor = Number(raw);
  return divisor >= 1 ? buildControlPlaneTimers(divisor) : CONTROL_PLANE_TIMERS;
}
