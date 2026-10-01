import type { SandboxBillingInput } from '../container-usage-context.js';
import type { VercelSandboxNetworkPolicy } from '../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import {
  CLOUDFLARE_CONTAINERS_INSTANCES,
  vercelSandboxResourcesSchema,
} from '@kilocode/worker-utils/sandbox-allocation';
import { z } from 'zod';
import { AgentSandboxUnavailableError } from '../agent-sandbox/protocol.js';
import type { CredentialContainmentRequirements } from './credential-containment.js';

export type ProviderCreationCause =
  | 'insufficient_credits'
  | 'stopping'
  | 'meter_unavailable'
  | 'invalid_configuration';

export class ProviderCreationError extends AgentSandboxUnavailableError {
  constructor(public readonly code: ProviderCreationCause) {
    super(
      code === 'insufficient_credits'
        ? 'Sandbox billing requires additional credits'
        : code === 'invalid_configuration'
          ? 'Sandbox configuration is invalid or unsupported'
          : code === 'stopping'
            ? 'Sandbox is stopping'
            : 'Sandbox billing admission is temporarily unavailable',
      code === 'insufficient_credits'
        ? 'billing_blocked'
        : code === 'invalid_configuration'
          ? 'provider_not_configured'
          : 'runtime_creation_failed'
    );
    this.name = 'ProviderCreationError';
  }

  get permanentReason(): 'billing_blocked' | 'invalid_configuration' | null {
    return this.code === 'insufficient_credits'
      ? 'billing_blocked'
      : this.code === 'invalid_configuration'
        ? 'invalid_configuration'
        : null;
  }
}

export const vercelAllocationConfigSchema = z
  .object({
    projectId: z.string().min(1).optional(),
    snapshotId: z.string().min(1).optional(),
    runtimeBuildId: z.string().min(1).optional(),
    runtime: z.string().min(1).optional(),
    resources: z
      .object({
        vcpus: z.number().int().positive(),
        memory: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type VercelAllocationConfig = z.infer<typeof vercelAllocationConfigSchema>;

export const sandboxProviderConfigurationSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('cloudflare') }).strict(),
  z
    .object({ provider: z.literal('vercel'), resources: vercelSandboxResourcesSchema.optional() })
    .strict(),
  z
    .object({
      provider: z.literal('cloudflare-containers'),
      instance: z.enum(CLOUDFLARE_CONTAINERS_INSTANCES).optional(),
    })
    .strict(),
]);

export type SandboxProviderConfiguration = z.infer<typeof sandboxProviderConfigurationSchema>;

export type ObserveResult = 'active' | 'terminal' | 'unknown';

export type StopResult = 'terminal' | 'retryable';

export type WrapperObservationStatus = 'absent' | 'present' | 'inspection-failed';

export function observeFromWrapperObservation(status: WrapperObservationStatus): ObserveResult {
  if (status === 'inspection-failed') return 'unknown';
  if (status === 'absent') return 'terminal';
  return 'active';
}

/** The canonical create intent plus the target identity fields a provider needs. */
export type ProviderAllocationIntent = {
  intentId: string;
  createdAt: number;
  allocationName?: string;
  vercel?: VercelAllocationConfig;
  containment?: CredentialContainmentRequirements;
};

export type ProviderCreateIntent = ProviderAllocationIntent & {
  billing?: SandboxBillingInput;
  networkPolicy?: VercelSandboxNetworkPolicy;
};

export type ProviderObservation = {
  status: ObserveResult;
  providerRef?: string;
};

export type ProviderAdapter = {
  readonly resumable: boolean;
  /** The workspace survives a stop; a persistent provider is never destroyed. */
  readonly persistentWorkspace: boolean;
  /** `stop` destroys the container rather than only stopping it. */
  readonly destroysOnStop: boolean;
  ensureBillingAdmission(ref: string, billing?: SandboxBillingInput): Promise<void>;
  create(intent: ProviderCreateIntent): Promise<{ providerRef: string } | { unresolved: true }>;
  launch(ref: string, env: Record<string, string>): Promise<void>;
  observe(
    ref: string | null,
    intent?: ProviderAllocationIntent | null
  ): Promise<ProviderObservation>;
  stop(ref: string | null, intent?: ProviderAllocationIntent | null): Promise<StopResult>;
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
    persistentWorkspace: false,
    destroysOnStop: false,
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
