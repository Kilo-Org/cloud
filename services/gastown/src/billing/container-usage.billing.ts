import {
  createContainerUsageClient,
  type BillingActor,
  type BillingSubject,
  type BudgetVerdict,
  type ContainerUsageClient,
  type ContainerUsageRpcMethods,
  type UsageContext as MeterUsageContext,
} from '@kilocode/container-usage';

export type UsageSubject = BillingSubject;
export type UsageActor = BillingActor;
export type { BudgetVerdict };
export type UsageContext = MeterUsageContext & {
  service: 'gastown';
  sessionId: string;
  metadata: Record<string, string>;
};

export type GastownBillingStatus = {
  /** Metering is active: usage is reported and the run estimate is populated. */
  enabled: boolean;
  /** Enforcement is active: low balance can block starts and stop the container. */
  enforcing: boolean;
  state:
    | 'idle'
    | 'starting'
    | 'running'
    | 'warning'
    | 'stopping'
    | 'blocked'
    | 'paused'
    | 'degraded';
  runPolicy: ContainerRunPolicy;
  payer?: UsageSubject;
  remaining?: number;
  minimumRequired?: number;
  estimatedHourlyCharge?: number;
  estimatedRunCharge?: number;
  runUsageSeconds?: number;
  intervalStartedAt?: number;
  lastReportedAt?: number;
};

export type ContainerRunPolicy = 'automatic' | 'paused_by_user';

export const GASTOWN_CONTAINER_SKU = 'gastown-standard-2026-07';
export const USAGE_HEARTBEAT_INTERVAL_MS = 5 * 60_000;

/**
 * Whether Gastown should enforce billing outcomes: blocking cold starts on
 * insufficient credits, honoring `stop` budget verdicts, and treating a
 * billing block as draining. Enforcement is gated by GASTOWN_BILLING_ENABLED.
 *
 * This is independent of metering: usage is always reported to the meter (see
 * isContainerUsageMeteringEnabled) so we can monitor real usage before turning
 * enforcement on.
 */
export function isGastownBillingEnforced(env: Env): boolean {
  return env.GASTOWN_BILLING_ENABLED === 'true';
}

/**
 * Whether container usage should be metered and reported to the meter service.
 * Reporting runs regardless of the enforcement flag whenever the CONTAINER_USAGE
 * binding is available, so shadow usage data is collected before enforcement.
 */
export function isContainerUsageMeteringEnabled(env: Env): boolean {
  return env.CONTAINER_USAGE !== undefined;
}

export function getContainerUsageClient(env: Env): ContainerUsageClient {
  if (!env.CONTAINER_USAGE) {
    throw new Error('CONTAINER_USAGE binding is required to report container usage');
  }
  return createContainerUsageClient(env.CONTAINER_USAGE, { service: 'gastown' });
}

export function isUsageIntervalNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'UsageIntervalNotFoundError' ||
      error.message.includes('Container usage interval not found:'))
  );
}

export type ContainerUsageBinding = ContainerUsageRpcMethods;

export function clientUsageContext(context: UsageContext): Omit<UsageContext, 'service'> {
  const { service: _service, ...clientContext } = context;
  return clientContext;
}
