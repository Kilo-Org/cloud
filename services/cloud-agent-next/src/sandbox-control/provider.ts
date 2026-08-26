import type { ObserveResult } from './physical-lifecycle.js';

export type { ObserveResult };

export type StopResult = 'terminal' | 'retryable';

export type WrapperObservationStatus = 'absent' | 'present' | 'inspection-failed';

export function observeFromWrapperObservation(status: WrapperObservationStatus): ObserveResult {
  if (status === 'inspection-failed') return 'unknown';
  if (status === 'absent') return 'terminal';
  return 'active';
}

export type ProviderCreateIntent = {
  intentId: string;
  env: Record<string, string>;
};

export type ProviderAdapter = {
  readonly resumable: boolean;
  create(intent: ProviderCreateIntent): Promise<{ providerRef: string } | { unresolved: true }>;
  observe(ref: string | null): Promise<ObserveResult>;
  stop(ref: string | null): Promise<StopResult>;
  ensureLeaseAtLeast(ref: string, ms: number): Promise<void>;
  logs(ref: string): Promise<string>;
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
    async create(intent) {
      if (options?.unresolved) return { unresolved: true };
      const providerRef = `mem_${intent.intentId}`;
      if (!instances.has(providerRef)) {
        instances.set(providerRef, { stopped: false });
      }
      return { providerRef };
    },
    async observe(ref) {
      // Successful not-found: forget intent only when lookup succeeds and reports not-found.
      if (ref === null) return 'terminal';
      const instance = instances.get(ref);
      if (!instance || instance.stopped) return 'terminal';
      return 'active';
    },
    async stop(ref) {
      if (options?.stopRetryable) return 'retryable';
      if (ref !== null) {
        const instance = instances.get(ref);
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
