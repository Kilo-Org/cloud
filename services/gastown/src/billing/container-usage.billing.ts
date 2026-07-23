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
  enabled: boolean;
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

export function isGastownBillingEnabled(env: Env): boolean {
  return env.GASTOWN_BILLING_ENABLED === 'true';
}

export function getContainerUsageClient(env: Env): ContainerUsageClient {
  if (!env.CONTAINER_USAGE) {
    throw new Error('CONTAINER_USAGE binding is required when Gastown billing is enabled');
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
