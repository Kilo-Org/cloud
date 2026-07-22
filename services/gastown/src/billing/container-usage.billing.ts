export type UsageSubject = { type: 'user' | 'org'; id: string };
export type UsageActor = { type: 'user' | 'bot'; id: string };

export type UsageContext = {
  service: 'gastown';
  instanceId: string;
  sku: string;
  subject: UsageSubject;
  actor: UsageActor;
  onBehalfOf?: UsageSubject;
  sessionId: string;
  region?: string;
  metadata: Record<string, string>;
};

export type RecordAck = {
  intervalId: string;
  durable: 'pg' | 'buffer';
  dedup: boolean;
};

export type BudgetVerdict = {
  verdict: 'continue' | 'warn' | 'stop';
  remaining?: number;
};

export type HeartbeatAck = RecordAck & {
  budget: BudgetVerdict;
};

export type AuthorizeStartResult =
  | {
      verdict: 'allow';
      authorizationId: string;
      expiresAt: number;
      remaining?: number;
      minimumRequired: number;
      estimatedHourlyCharge?: number;
    }
  | {
      verdict: 'deny';
      remaining: number;
      minimumRequired: number;
      estimatedHourlyCharge?: number;
    };

export type ContainerUsageService = {
  authorizeStart(input: {
    context: UsageContext;
    idempotencyKey: string;
    observedAt: number;
  }): Promise<AuthorizeStartResult>;
  recordStart(
    input: UsageContext & {
      idempotencyKey: string;
      startEpochMs: number;
      observedAt: number;
    }
  ): Promise<RecordAck>;
  recordHeartbeat(input: {
    service: 'gastown';
    instanceId: string;
    startEpochMs: number;
    idempotencyKey: string;
    seq: number;
    observedAt: number;
    usageSinceLast?: number;
    context?: UsageContext;
  }): Promise<HeartbeatAck>;
  recordStop(input: {
    service: 'gastown';
    instanceId: string;
    startEpochMs: number;
    idempotencyKey: string;
    observedAt: number;
    reason: 'exit' | 'runtime_signal' | 'activity_expired';
    exitCode?: number;
  }): Promise<RecordAck>;
};

export type GastownBillingStatus = {
  enabled: boolean;
  state: 'idle' | 'starting' | 'running' | 'warning' | 'stopping' | 'blocked' | 'degraded';
  payer?: { type: 'user' | 'org'; id: string };
  remaining?: number;
  minimumRequired?: number;
  estimatedHourlyCharge?: number;
  intervalStartedAt?: number;
  lastReportedAt?: number;
};

export const GASTOWN_CONTAINER_SKU = 'cloudflare-container-standard-4';
export const USAGE_HEARTBEAT_INTERVAL_MS = 5 * 60_000;

export function isGastownBillingEnabled(env: Env): boolean {
  return env.GASTOWN_BILLING_ENABLED === 'true';
}

/**
 * No-charge implementation for local development while the real WorkerEntrypoint
 * package is under construction. Production never falls back to this service.
 */
function createDevelopmentContainerUsageStub(): ContainerUsageService {
  return {
    async authorizeStart({ idempotencyKey, observedAt }) {
      return {
        verdict: 'allow',
        authorizationId: `dev:${idempotencyKey}`,
        expiresAt: observedAt + 60_000,
        remaining: 100,
        minimumRequired: 1,
        estimatedHourlyCharge: 1.2,
      };
    },
    async recordStart(input) {
      return {
        intervalId: `${input.instanceId}:${input.startEpochMs}`,
        durable: 'buffer',
        dedup: false,
      };
    },
    async recordHeartbeat(input) {
      return {
        intervalId: `${input.instanceId}:${input.startEpochMs}`,
        durable: 'buffer',
        dedup: false,
        budget: { verdict: 'continue', remaining: 100 },
      };
    },
    async recordStop(input) {
      return {
        intervalId: `${input.instanceId}:${input.startEpochMs}`,
        durable: 'buffer',
        dedup: false,
      };
    },
  };
}

export function getContainerUsageService(env: Env): ContainerUsageService {
  if (env.CONTAINER_USAGE) return env.CONTAINER_USAGE;
  if (env.ENVIRONMENT === 'development') return createDevelopmentContainerUsageStub();
  throw new Error('CONTAINER_USAGE binding is required when Gastown billing is enabled');
}
