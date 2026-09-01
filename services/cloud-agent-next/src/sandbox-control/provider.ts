import type { SandboxBillingInput } from '../container-usage-context.js';
import type { VercelSandboxNetworkPolicy } from '../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import type { CreateIntent, ObserveResult } from './physical-lifecycle.js';

export type { ObserveResult };

export type StopResult = 'terminal' | 'retryable';

export type WrapperObservationStatus = 'absent' | 'present' | 'inspection-failed';

export function observeFromWrapperObservation(status: WrapperObservationStatus): ObserveResult {
  if (status === 'inspection-failed') return 'unknown';
  if (status === 'absent') return 'terminal';
  return 'active';
}

export type ProviderCreateIntent = CreateIntent & {
  billing?: SandboxBillingInput;
  networkPolicy?: VercelSandboxNetworkPolicy;
};

export type ProviderObservation = {
  status: ObserveResult;
  providerRef?: string;
};

export type ProviderAdapter = {
  readonly resumable: boolean;
  ensureBillingAdmission(ref: string, billing?: SandboxBillingInput): Promise<void>;
  create(intent: ProviderCreateIntent): Promise<{ providerRef: string } | { unresolved: true }>;
  launch(ref: string, env: Record<string, string>): Promise<void>;
  observe(ref: string | null, intent?: CreateIntent | null): Promise<ProviderObservation>;
  stop(ref: string | null, intent?: CreateIntent | null): Promise<StopResult>;
  ensureLeaseAtLeast(ref: string, ms: number): Promise<void>;
  logs(ref: string): Promise<string>;
  updateNetworkPolicy?(
    providerRef: string,
    networkPolicy: VercelSandboxNetworkPolicy
  ): Promise<void>;
};

export type MemoryProviderAdapter = ProviderAdapter & {
  lastLeaseMs: number | null;
};

export function createMemoryProviderAdapter(options?: {
  resumable?: boolean;
  unresolved?: boolean;
  stopRetryable?: boolean;
}): MemoryProviderAdapter {
  const instances = new Map<string, { stopped: boolean }>();
  let lastLeaseMs: number | null = null;

  return {
    resumable: options?.resumable ?? false,
    get lastLeaseMs() {
      return lastLeaseMs;
    },
    async ensureBillingAdmission() {},
    async create(intent) {
      if (options?.unresolved) return { unresolved: true };
      const providerRef = `mem_${intent.intentId}`;
      if (!instances.has(providerRef)) {
        instances.set(providerRef, { stopped: false });
      }
      return { providerRef };
    },
    async launch() {},
    async observe(ref, intent) {
      const providerRef = ref ?? (intent ? `mem_${intent.intentId}` : undefined);
      if (!providerRef) return { status: 'terminal' };
      const instance = instances.get(providerRef);
      return { status: !instance || instance.stopped ? 'terminal' : 'active', providerRef };
    },
    async stop(ref, intent) {
      if (options?.stopRetryable) return 'retryable';
      const providerRef = ref ?? (intent ? `mem_${intent.intentId}` : undefined);
      if (providerRef) {
        const instance = instances.get(providerRef);
        if (instance) instance.stopped = true;
      }
      return 'terminal';
    },
    async ensureLeaseAtLeast(_ref, ms) {
      lastLeaseMs = ms;
    },
    async logs(ref) {
      const instance = instances.get(ref);
      if (!instance) return `memory ${ref} absent`;
      return `memory ${ref} ${instance.stopped ? 'terminal' : 'active'}`;
    },
  };
}
