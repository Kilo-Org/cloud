import type { SandboxBillingInput, SandboxClassName } from '../container-usage-context.js';
import type { CloudAgentRunContainer } from '@kilocode/worker-utils/cloud-agent-queue-report';
import type { SessionCredentialGrant } from './session-credentials.js';
import {
  CLOUDFLARE_CONTAINERS_INSTANCES,
  vercelSandboxResourcesSchema,
} from '@kilocode/worker-utils/sandbox-allocation';
import { CODE_REVIEW_CONTAINERS_INSTANCE } from '../sandbox-containers/instance-size.js';
import { z } from 'zod';
import { AgentSandboxUnavailableError } from '../agent-sandbox/protocol.js';
import type { CredentialContainmentRequirements } from './credential-containment.js';
import type { BillingContext } from '@kilocode/container-usage';

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
      instance: z
        .enum([...CLOUDFLARE_CONTAINERS_INSTANCES, CODE_REVIEW_CONTAINERS_INSTANCE] as const)
        .optional(),
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

/** What a physical start used: the image, or an environment snapshot of it. */
export type ProviderStartSource = 'image' | 'repository';

/**
 * A published environment snapshot the Sandbox DO selected for this allocation.
 * Only the environment coordinator produces one; no public API accepts it.
 */
export type ProviderSnapshotStart = {
  snapshotId: string;
  /** The image the snapshot was captured from. */
  baseImage: string;
};

export type ProviderLaunchOptions = {
  /** Start from this snapshot; a provider without snapshot support ignores it. */
  snapshot?: ProviderSnapshotStart;
  deadlineAt?: number;
};

export type ProviderLaunchResult = {
  startSource: ProviderStartSource;
  snapshotFailed?: true;
};

/**
 * Read-only billing state of one allocation. It is projected from stored
 * sandbox state; producing or reading it never admits work, starts a container
 * or opens a billing interval.
 */
export type ProviderBillingProjection = {
  sandboxClassName: SandboxClassName;
  blocked: boolean;
  context?: BillingContext;
};

/** The first process that a provider runs in a new or restored sandbox. */
export type ProviderStartupCommand = {
  argv: readonly string[];
  /** Trusted bootstrap needs to install runtime files outside the workspace. */
  user?: 'root';
};

export type ProviderAdapter = {
  describeRuntime?(ref: string): CloudAgentRunContainer | undefined;
  ensureBillingAdmission(ref: string, billing?: SandboxBillingInput): Promise<void>;
  /**
   * Read the stored compute-billing block without admitting or waking anything.
   * A provider that keeps the state outside the sandbox omits this; the caller
   * then keeps its own check.
   */
  isBillingBlocked?(ref: string | null): Promise<boolean>;
  /**
   * Read the stored billing projection for one allocation without admitting
   * work or starting a container. A provider without readable billing state
   * omits this; callers then report no rate instead of inventing one.
   */
  getBillingProjection?(ref: string | null): Promise<ProviderBillingProjection | undefined>;
  create(intent: ProviderCreateIntent): Promise<{ providerRef: string } | { unresolved: true }>;
  launch(
    ref: string,
    startup: { command: ProviderStartupCommand; env: Record<string, string> },
    options?: ProviderLaunchOptions
  ): Promise<ProviderLaunchResult>;
  observe(
    ref: string | null,
    intent?: ProviderAllocationIntent | null
  ): Promise<ProviderObservation>;
  stop(ref: string | null, intent?: ProviderAllocationIntent | null): Promise<StopResult>;
  ensureLeaseAtLeast(ref: string, ms: number): Promise<void>;
  logs(ref: string): Promise<string>;
  /** Present on a provider that can start a session from an environment snapshot. */
  readonly environmentSnapshots?: true;
  /**
   * Replace the live sandbox's contained-credential network policy with one
   * built from the authoritative grants. Only a provider whose network policy
   * carries contained credentials implements it; a missing hook on a live
   * provider is a failure the caller treats as fail-closed.
   */
  applyContainedCredentials?(ref: string, grants: readonly SessionCredentialGrant[]): Promise<void>;
};
