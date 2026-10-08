import type { SandboxBillingInput } from '../container-usage-context.js';
import type { SessionCredentialGrant } from './session-credentials.js';
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
  containment?: CredentialContainmentRequirements;
};

export type ProviderCreateIntent = ProviderAllocationIntent & {
  billing?: SandboxBillingInput;
};

export type ProviderObservation = {
  status: ObserveResult;
  providerRef?: string;
};

/** What a physical start used: the image, or a repository snapshot of it. */
export type ProviderStartSource = 'image' | 'repository';

export type ProviderLaunchOptions = {
  /** Keyed hash of the launch's scope, repository and env; a provider may start from its snapshot. */
  repoKey?: string;
  /** Start from the image and forget the snapshot stored for `repoKey`. */
  discardRepository?: true;
};

export type ProviderLaunchResult = { startSource: ProviderStartSource };

export type ProviderAdapter = {
  ensureBillingAdmission(ref: string, billing?: SandboxBillingInput): Promise<void>;
  create(intent: ProviderCreateIntent): Promise<{ providerRef: string } | { unresolved: true }>;
  launch(
    ref: string,
    env: Record<string, string>,
    options?: ProviderLaunchOptions
  ): Promise<ProviderLaunchResult>;
  observe(
    ref: string | null,
    intent?: ProviderAllocationIntent | null
  ): Promise<ProviderObservation>;
  stop(ref: string | null, intent?: ProviderAllocationIntent | null): Promise<StopResult>;
  ensureLeaseAtLeast(ref: string, ms: number): Promise<void>;
  logs(ref: string): Promise<string>;
  /**
   * Save the running container as the repository snapshot for `repoKey`. Only a
   * provider that can start from one implements it; `false` is a failed capture
   * that the caller ignores.
   */
  captureRepository?(ref: string, repoKey: string, commit?: string): Promise<boolean>;
  /**
   * Replace the live sandbox's contained-credential network policy with one
   * built from the authoritative grants. Only a provider whose network policy
   * carries contained credentials implements it; a missing hook on a live
   * provider is a failure the caller treats as fail-closed.
   */
  applyContainedCredentials?(ref: string, grants: readonly SessionCredentialGrant[]): Promise<void>;
};
