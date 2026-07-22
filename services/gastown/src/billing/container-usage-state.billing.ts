import type { BudgetVerdict, GastownBillingStatus, UsageContext } from './container-usage.billing';

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
  stopReason?: 'exit' | 'runtime_signal' | 'activity_expired';
  stopObservedAt?: number;
  finalUsageCaptured?: boolean;
};

export type StoredUsageState =
  | { phase: 'idle'; context?: UsageContext; blocked?: boolean; latestBudget?: BudgetVerdict }
  | OpenUsageInterval;

export function toBillingStatus(enabled: boolean, state: StoredUsageState): GastownBillingStatus {
  if (!enabled) return { enabled: false, state: 'idle' };

  const payer = state.context?.subject;
  if (state.phase === 'idle') {
    return {
      enabled: true,
      state: state.blocked ? 'blocked' : 'idle',
      ...(payer ? { payer } : {}),
      ...(state.latestBudget?.remaining === undefined
        ? {}
        : { remaining: state.latestBudget.remaining }),
    };
  }

  const publicState =
    state.phase === 'starting'
      ? 'starting'
      : state.phase === 'stopping'
        ? 'stopping'
        : state.latestBudget?.verdict === 'stop'
          ? 'stopping'
          : state.latestBudget?.verdict === 'warn'
            ? 'warning'
            : 'running';

  return {
    enabled: true,
    state: publicState,
    payer,
    ...(state.latestBudget?.remaining === undefined
      ? {}
      : { remaining: state.latestBudget.remaining }),
    ...(state.minimumRequired === undefined ? {} : { minimumRequired: state.minimumRequired }),
    ...(state.estimatedHourlyCharge === undefined
      ? {}
      : { estimatedHourlyCharge: state.estimatedHourlyCharge }),
    intervalStartedAt: state.startEpochMs,
    lastReportedAt: state.lastReportedAt,
  };
}
