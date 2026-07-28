import type {
  BudgetVerdict,
  ContainerRunPolicy,
  GastownBillingStatus,
  UsageContext,
} from './container-usage.billing';

export type PendingHeartbeat = {
  seq: number;
  observedAt: number;
  usageSinceLast: number;
};

export type PendingStop = {
  seq: number;
  usageSinceLast: number;
  measuredAtMs: number;
  reason: 'exit' | 'runtime_signal' | 'activity_expired';
};

export type OpenUsageInterval = {
  version?: typeof BILLING_STATE_VERSION;
  phase: 'starting' | 'running' | 'stopping';
  context: UsageContext;
  startEpochMs: number;
  startRecorded: boolean;
  seq: number;
  lastReportedAt: number;
  pendingHeartbeat?: PendingHeartbeat;
  pendingStop?: PendingStop;
  latestBudget?: BudgetVerdict;
  minimumRequired?: number;
  estimatedHourlyCharge?: number;
  reportedUsageSeconds?: number;
  stopReason?: 'exit' | 'runtime_signal' | 'activity_expired';
  stopObservedAt?: number;
  settlementAttempts?: number;
};

export type StoredUsageState =
  | {
      phase: 'idle';
      version?: typeof BILLING_STATE_VERSION;
      context?: UsageContext;
      blocked?: boolean;
      latestBudget?: BudgetVerdict;
      lastRun?: {
        startedAt: number;
        stoppedAt: number;
        usageSeconds: number;
        estimatedCharge?: number;
        unsettled?: boolean;
      };
    }
  | OpenUsageInterval;

export const BILLING_STATE_VERSION = 2 as const;

/**
 * How many alarm-driven attempts to settle a stopping interval with the meter
 * before Gastown gives up locally. This prevents an unreachable meter from
 * stranding a town in the draining/stopping state indefinitely; the interval is
 * flagged unsettled for later reconciliation.
 */
export const MAX_SETTLEMENT_ATTEMPTS = 5;

export function migrateStoredUsageState(
  state: StoredUsageState | undefined,
  fallbackContext?: UsageContext
): StoredUsageState {
  if (state?.version === BILLING_STATE_VERSION) return state;
  const context = state?.context ?? fallbackContext;
  const hasLegacyAuthorization =
    state !== undefined &&
    ('authorizationId' in state ||
      'authorizationKey' in state ||
      'authorizationExpiresAt' in state);
  if (state && !hasLegacyAuthorization && !(state.phase === 'idle' && state.blocked)) {
    return { ...state, version: BILLING_STATE_VERSION };
  }
  return {
    version: BILLING_STATE_VERSION,
    phase: 'idle',
    ...(context ? { context } : {}),
  };
}

/**
 * Whether a Cloudflare container runtime status means the runtime has
 * definitively stopped. Transient boot-time and shutdown states (running,
 * healthy, stopping, or any unknown value) are treated as still-live so a
 * just-started billing interval is not force-closed by a single heartbeat
 * observation; the authoritative close happens in the container's onStop.
 */
export function isRuntimeStoppedStatus(status: string): boolean {
  return status === 'stopped' || status === 'stopped_with_code';
}

export function createPendingStop(
  state: OpenUsageInterval,
  stopObservedAt: number,
  reason: PendingStop['reason']
): PendingStop {
  const usageSinceLast = Math.floor(Math.max(0, stopObservedAt - state.lastReportedAt) / 1000);
  return {
    seq: state.seq + 1,
    usageSinceLast,
    measuredAtMs: state.lastReportedAt + usageSinceLast * 1000,
    reason,
  };
}

/** Derive the public billing state for an idle (no open interval) town. */
function idleBillingState(
  state: Extract<StoredUsageState, { phase: 'idle' }>,
  runPolicy: ContainerRunPolicy
): GastownBillingStatus['state'] {
  if (runPolicy === 'paused_by_user') return 'paused';
  if (state.blocked) return 'blocked';
  return 'idle';
}

/** Derive the public billing state for a town with an open interval. */
function openIntervalBillingState(
  state: OpenUsageInterval,
  runPolicy: ContainerRunPolicy
): GastownBillingStatus['state'] {
  if (runPolicy === 'paused_by_user') return 'stopping';
  if (state.phase === 'starting') return 'starting';
  if (state.phase === 'stopping') return 'stopping';
  if (state.latestBudget?.verdict === 'stop') return 'stopping';
  if (state.latestBudget?.verdict === 'warn') return 'warning';
  return 'running';
}

export function toBillingStatus(
  enabled: boolean,
  state: StoredUsageState,
  runPolicy: ContainerRunPolicy = 'automatic',
  now = Date.now(),
  enforcing = false
): GastownBillingStatus {
  if (!enabled) return { enabled: false, enforcing, state: 'idle', runPolicy };

  const payer = state.context?.subject;
  if (state.phase === 'idle') {
    return {
      enabled: true,
      enforcing,
      state: idleBillingState(state, runPolicy),
      runPolicy,
      ...(payer ? { payer } : {}),
      ...(state.latestBudget?.remaining === undefined
        ? {}
        : { remaining: state.latestBudget.remaining }),
      ...(state.lastRun?.estimatedCharge === undefined
        ? {}
        : { estimatedRunCharge: state.lastRun.estimatedCharge }),
      ...(state.lastRun
        ? {
            runUsageSeconds: state.lastRun.usageSeconds,
            intervalStartedAt: state.lastRun.startedAt,
            lastReportedAt: state.lastRun.stoppedAt,
          }
        : {}),
    };
  }

  const publicState = openIntervalBillingState(state, runPolicy);

  const currentSliceSeconds =
    state.phase === 'running' || (state.phase === 'stopping' && state.stopObservedAt === undefined)
      ? Math.max(0, (now - state.lastReportedAt) / 1000)
      : 0;
  const runUsageSeconds = (state.reportedUsageSeconds ?? 0) + currentSliceSeconds;
  const estimatedRunCharge =
    state.estimatedHourlyCharge === undefined
      ? undefined
      : (runUsageSeconds / 3600) * state.estimatedHourlyCharge;

  return {
    enabled: true,
    enforcing,
    state: publicState,
    runPolicy,
    payer,
    ...(state.latestBudget?.remaining === undefined
      ? {}
      : { remaining: state.latestBudget.remaining }),
    ...(state.minimumRequired === undefined ? {} : { minimumRequired: state.minimumRequired }),
    ...(state.estimatedHourlyCharge === undefined
      ? {}
      : { estimatedHourlyCharge: state.estimatedHourlyCharge }),
    ...(estimatedRunCharge === undefined ? {} : { estimatedRunCharge }),
    runUsageSeconds,
    intervalStartedAt: state.startEpochMs,
    lastReportedAt: state.lastReportedAt,
  };
}
