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
  idempotencyKey: string;
};

export type OpenUsageInterval = {
  phase: 'starting' | 'running' | 'stopping';
  context: UsageContext;
  authorizationId: string;
  authorizationKey: string;
  authorizationExpiresAt?: number;
  startEpochMs: number;
  startRecorded: boolean;
  seq: number;
  lastReportedAt: number;
  pendingHeartbeat?: PendingHeartbeat;
  latestBudget?: BudgetVerdict;
  minimumRequired?: number;
  estimatedHourlyCharge?: number;
  reportedUsageSeconds?: number;
  stopReason?: 'exit' | 'runtime_signal' | 'activity_expired';
  stopObservedAt?: number;
  finalUsageCaptured?: boolean;
};

export type StoredUsageState =
  | {
      phase: 'idle';
      context?: UsageContext;
      blocked?: boolean;
      latestBudget?: BudgetVerdict;
      lastRun?: {
        startedAt: number;
        stoppedAt: number;
        usageSeconds: number;
        estimatedCharge?: number;
      };
    }
  | OpenUsageInterval;

export function toBillingStatus(
  enabled: boolean,
  state: StoredUsageState,
  runPolicy: ContainerRunPolicy = 'automatic',
  now = Date.now()
): GastownBillingStatus {
  if (!enabled) return { enabled: false, state: 'idle', runPolicy };

  const payer = state.context?.subject;
  if (state.phase === 'idle') {
    return {
      enabled: true,
      state: runPolicy === 'paused_by_user' ? 'paused' : state.blocked ? 'blocked' : 'idle',
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

  const publicState =
    runPolicy === 'paused_by_user'
      ? 'stopping'
      : state.phase === 'starting'
        ? 'starting'
        : state.phase === 'stopping'
          ? 'stopping'
          : state.latestBudget?.verdict === 'stop'
            ? 'stopping'
            : state.latestBudget?.verdict === 'warn'
              ? 'warning'
              : 'running';

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
