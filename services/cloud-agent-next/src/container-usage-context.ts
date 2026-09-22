import {
  billingActorSchema,
  billingSubjectSchema,
  usageContextSchema,
  ContainerUsageAdmissionError,
  type UsageContext,
} from '@kilocode/container-usage';
import { z } from 'zod';
import type { CloudflareContainersInstance } from '@kilocode/worker-utils/sandbox-allocation';
import { logger } from './logger.js';
import { classifySandboxId, isIsolatedSandboxId, isValidSandboxId } from './sandbox-id.js';
import type { SessionMetadata } from './persistence/session-metadata.js';
import type { SandboxId, SandboxInstance } from './types.js';
import type { BillingContext } from '@kilocode/container-usage';

export const SANDBOX_USAGE_SKUS = {
  Sandbox: 'cloud-agent-standard-2026-07',
  SandboxContainment: 'cloud-agent-standard-2026-07',
  SandboxSmall: 'cloud-agent-small-2026-07',
  SandboxSmallContainment: 'cloud-agent-small-2026-07',
  SandboxDIND: 'cloud-agent-dind-2026-07',
  SandboxCodeReview: 'cloud-agent-code-review-2026-07',
  SandboxCodeReviewContainment: 'cloud-agent-code-review-2026-07',
  SandboxContainersStandard3: 'cloud-agent-containers-standard-3-2026-09',
  SandboxContainersStandard4: 'cloud-agent-containers-standard-4-2026-09',
} as const;

export type SandboxClassName = keyof typeof SANDBOX_USAGE_SKUS;

export type SandboxCapacity = { vcpu: number; memoryMiB: number; diskMB: number };

export type ContainersBillingClassName =
  | 'SandboxContainersStandard3'
  | 'SandboxContainersStandard4';

export type LegacySandboxClassName = Exclude<SandboxClassName, ContainersBillingClassName>;

// Production values mirror this service's top-level wrangler.jsonc entries and
// apps/web/src/lib/cloudflare/container-capacity.ts. The parity test reads all three sources.
// Development intentionally uses different named instance types and does not query Analytics.
export const SANDBOX_CAPACITIES: Record<LegacySandboxClassName, SandboxCapacity> = {
  Sandbox: { vcpu: 4, memoryMiB: 12_288, diskMB: 20_000 },
  SandboxContainment: { vcpu: 4, memoryMiB: 12_288, diskMB: 20_000 },
  SandboxSmall: { vcpu: 2, memoryMiB: 6_144, diskMB: 10_000 },
  SandboxSmallContainment: { vcpu: 2, memoryMiB: 6_144, diskMB: 10_000 },
  SandboxDIND: { vcpu: 2, memoryMiB: 6_144, diskMB: 10_000 },
  SandboxCodeReview: { vcpu: 1, memoryMiB: 4_096, diskMB: 8_000 },
  SandboxCodeReviewContainment: { vcpu: 1, memoryMiB: 4_096, diskMB: 8_000 },
};

// One `SandboxContainers` Durable Object serves every instance size, so there is no per-size
// wrangler class; these billing classes carry the instance-keyed metering capacity.
export const CONTAINERS_BILLING_CAPACITIES: Record<ContainersBillingClassName, SandboxCapacity> = {
  SandboxContainersStandard3: { vcpu: 2, memoryMiB: 8_192, diskMB: 16_000 },
  SandboxContainersStandard4: { vcpu: 4, memoryMiB: 12_288, diskMB: 20_000 },
};

const USAGE_SERVICE_ROOT = 'cloud-agent-next';

export function usageServiceForSandboxClass(sandboxClassName: SandboxClassName): string {
  const suffix = sandboxClassName.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  return `${USAGE_SERVICE_ROOT}-${suffix}`;
}

export function isContainersBillingClassName(
  sandboxClassName: SandboxClassName
): sandboxClassName is ContainersBillingClassName {
  return sandboxClassName in CONTAINERS_BILLING_CAPACITIES;
}

export function billingCapacityForSandboxClass(
  sandboxClassName: SandboxClassName
): SandboxCapacity {
  return isContainersBillingClassName(sandboxClassName)
    ? CONTAINERS_BILLING_CAPACITIES[sandboxClassName]
    : SANDBOX_CAPACITIES[sandboxClassName];
}

export type ContainersBillingIdentity = {
  className: ContainersBillingClassName;
  service: string;
  sku: string;
  capacity: SandboxCapacity;
};

const CONTAINERS_CLASS_BY_INSTANCE: Record<string, ContainersBillingClassName | undefined> = {
  'standard-3': 'SandboxContainersStandard3',
  'standard-4': 'SandboxContainersStandard4',
} satisfies Record<CloudflareContainersInstance, ContainersBillingClassName>;

export function containersBillingIdentity(instance: string): ContainersBillingIdentity {
  const className = Object.hasOwn(CONTAINERS_CLASS_BY_INSTANCE, instance)
    ? CONTAINERS_CLASS_BY_INSTANCE[instance]
    : undefined;
  if (className === undefined) {
    throw new Error(`Containers billing is unsupported for instance size: ${instance}`);
  }
  return {
    className,
    service: usageServiceForSandboxClass(className),
    sku: SANDBOX_USAGE_SKUS[className],
    capacity: CONTAINERS_BILLING_CAPACITIES[className],
  };
}

export type SandboxBillingInput = Omit<UsageContext, 'service' | 'instanceId' | 'sku'> & {
  sandboxId: SandboxId;
  enforcementRequested?: boolean;
};
export type SandboxBillingAdmissionResult =
  | { success: true }
  | {
      success: false;
      code: 'insufficient_credits' | 'meter_unavailable' | 'stopping';
      message: string;
      remainingMicrodollars?: number;
      minimumRequiredMicrodollars?: number;
    };
export type MeteredSandboxInstance = SandboxInstance & {
  configureBilling(input: unknown): Promise<void>;
  ensureBillingAdmission(input: unknown): Promise<SandboxBillingAdmissionResult>;
  isBillingBlocked(): Promise<boolean>;
  isContainerRunning(): Promise<boolean>;
  forceDestroyForControlPlane(): Promise<void>;
  getBillingRuntimeStatus(): Promise<{
    sandboxClassName: SandboxClassName;
    running: boolean;
    blocked: boolean;
    context?: BillingContext;
  }>;
};

/** Optional while Worker and sandbox runtime deployments roll forward independently. */
type BillingRuntimeStatusCapability = {
  getBillingRuntimeStatus?: MeteredSandboxInstance['getBillingRuntimeStatus'];
};

const sandboxBillingInputEnvelopeSchema = z
  .object({
    sandboxId: z
      .string()
      .min(1)
      .max(63)
      .refine(isValidSandboxId, 'Invalid sandboxId format')
      .transform(value => value as SandboxId),
    subject: billingSubjectSchema,
    actor: billingActorSchema,
    onBehalfOf: billingSubjectSchema.optional(),
    sessionId: z.string().min(1).max(256).optional(),
    metadata: z
      .record(z.string().min(1).max(64), z.string().max(512))
      .refine(metadata => Object.keys(metadata).length <= 16, {
        message: 'Metadata may contain at most 16 entries',
      })
      .optional(),
    enforcementRequested: z.boolean().default(false),
  })
  .strict();

const KNOWN_ORIGINS = new Set([
  'app-builder',
  'auto-triage',
  'autofix',
  'cloud-agent',
  'cloud-agent-web',
  'code-review',
  'discord',
  'github',
  'linear',
  'scheduled',
  'security-agent',
  'security-remediation',
  'slack',
  'webhook',
]);

function normalizedOrigin(origin: string | undefined): string {
  if (!origin) return 'other';
  return KNOWN_ORIGINS.has(origin) ? origin : 'other';
}

export function buildSandboxBillingInput(
  metadata: SessionMetadata,
  sandboxId: SandboxId,
  enforcementRequested = false
): SandboxBillingInput {
  const subject = metadata.identity.orgId
    ? { type: 'org' as const, id: metadata.identity.orgId }
    : { type: 'user' as const, id: metadata.identity.userId };
  const actor = metadata.identity.botId
    ? { type: 'bot' as const, id: metadata.identity.botId }
    : { type: 'user' as const, id: metadata.identity.userId };
  const isolated = isIsolatedSandboxId(sandboxId);

  return {
    sandboxId,
    ...(enforcementRequested ? { enforcementRequested: true } : {}),
    subject,
    actor,
    ...(actor.type === 'bot' ? { onBehalfOf: subject } : {}),
    ...(isolated ? { sessionId: metadata.identity.sessionId } : {}),
    ...(isolated
      ? { metadata: { origin: normalizedOrigin(metadata.identity.billingOrigin) } }
      : {}),
  };
}

export function parseSandboxBillingInput(input: unknown): SandboxBillingInput {
  const parsed = sandboxBillingInputEnvelopeSchema.parse(input);
  const { sandboxId, enforcementRequested, ...usageInput } = parsed;
  const validated = usageContextSchema.parse({
    service: USAGE_SERVICE_ROOT,
    instanceId: 'validation',
    sku: 'validation',
    ...usageInput,
  });
  const { service: _service, instanceId: _instanceId, sku: _sku, ...billingInput } = validated;
  return { sandboxId, enforcementRequested, ...billingInput };
}

export function assertSandboxBillingAllocation(
  sandboxClassName: SandboxClassName,
  input: SandboxBillingInput
): void {
  const sandboxIdClass = classifySandboxId(input.sandboxId);
  const standardClass = sandboxClassName === 'Sandbox' || sandboxClassName === 'SandboxContainment';
  const isolatedPrefixedLegacyId =
    /^(ses|istd|crv|dind)-/.test(input.sandboxId) && input.sandboxId.includes('__');
  if (isolatedPrefixedLegacyId) {
    throw new Error('Shared sandbox billing requires a shared sandbox ID');
  }
  const sharedAllocation = sandboxIdClass === 'shared' || sandboxIdClass === 'legacy-shared';

  if (standardClass && sharedAllocation) {
    if (input.sessionId !== undefined) {
      throw new Error('Shared sandbox billing cannot contain session attribution');
    }
    if (input.metadata !== undefined && Object.keys(input.metadata).length > 0) {
      throw new Error('Shared sandbox billing cannot contain metadata');
    }
    return;
  }

  const expectedSandboxIdClass = standardClass
    ? 'isolated-standard'
    : isContainersBillingClassName(sandboxClassName) ||
        sandboxClassName === 'SandboxSmall' ||
        sandboxClassName === 'SandboxSmallContainment'
      ? 'isolated-small'
      : sandboxClassName === 'SandboxDIND'
        ? 'devcontainer'
        : 'code-review';
  if (sandboxIdClass !== expectedSandboxIdClass) {
    throw new Error(`${sandboxClassName} billing received an incompatible sandbox ID`);
  }
  if (!input.sessionId) {
    throw new Error('Isolated sandbox billing requires session attribution');
  }
  const metadata = input.metadata;
  if (!metadata) {
    throw new Error('Isolated sandbox billing origin is unsupported');
  }
  const origin = metadata.origin;
  if (origin === undefined || normalizedOrigin(origin) !== origin) {
    throw new Error('Isolated sandbox billing origin is unsupported');
  }
  const allowedMetadata = new Set(['origin']);
  if (Object.keys(metadata).some(key => !allowedMetadata.has(key))) {
    throw new Error('Isolated sandbox billing metadata contains an unsupported field');
  }
}

export async function configureSandboxBilling(
  sandbox: SandboxInstance,
  metadata: SessionMetadata,
  sandboxId: SandboxId
): Promise<void> {
  await configureSandboxBillingInput(sandbox, buildSandboxBillingInput(metadata, sandboxId));
}

export async function ensureSandboxBillingAdmissionInput(
  sandbox: SandboxInstance,
  input: SandboxBillingInput
): Promise<SandboxBillingAdmissionResult> {
  const ensureBillingAdmission = (sandbox as Partial<MeteredSandboxInstance>)
    .ensureBillingAdmission;
  if (typeof ensureBillingAdmission !== 'function') {
    return input.enforcementRequested
      ? {
          success: false,
          code: 'meter_unavailable',
          message: 'Container billing admission is unavailable',
        }
      : { success: true };
  }
  try {
    return await (sandbox as MeteredSandboxInstance).ensureBillingAdmission(input);
  } catch (error) {
    return {
      success: false,
      code: 'meter_unavailable',
      message: error instanceof Error ? error.message : 'Container billing admission failed',
    };
  }
}

export function billingAdmissionFailureFromError(error: unknown): SandboxBillingAdmissionResult {
  if (error instanceof ContainerUsageAdmissionError) {
    if (error.code === 'insufficient_credits') {
      return {
        success: false,
        code: 'insufficient_credits',
        message: error.message,
        ...(error.remainingMicrodollars === undefined
          ? {}
          : { remainingMicrodollars: error.remainingMicrodollars }),
        ...(error.minimumRequiredMicrodollars === undefined
          ? {}
          : { minimumRequiredMicrodollars: error.minimumRequiredMicrodollars }),
      };
    }
  }
  return {
    success: false,
    code: 'meter_unavailable',
    message: error instanceof Error ? error.message : 'Container billing meter is unavailable',
  };
}

export async function isSandboxBillingBlocked(
  sandbox: SandboxInstance,
  enforcementRequested = false
): Promise<boolean> {
  const isBillingBlocked = (sandbox as Partial<MeteredSandboxInstance>).isBillingBlocked;
  if (typeof isBillingBlocked !== 'function') return false;
  try {
    return await (sandbox as MeteredSandboxInstance).isBillingBlocked();
  } catch (error) {
    logger
      .withFields({ error: error instanceof Error ? error.message : String(error) })
      .warn('Container billing block check failed');
    return enforcementRequested;
  }
}

/**
 * Whether the sandbox's container is currently running, read over Durable Object RPC.
 *
 * This deliberately avoids any container fetch (`exec`, `listProcesses`, …), because
 * those boot a sleeping container. Callers use it to answer "is there anything running
 * in there?" without paying for a wake-up.
 *
 * Returns `undefined` when the sandbox does not expose the method, so callers can fall
 * back to their existing behaviour rather than treating an unknown state as "stopped".
 */
export async function isSandboxContainerRunning(
  sandbox: SandboxInstance
): Promise<boolean | undefined> {
  const isContainerRunning = (sandbox as Partial<MeteredSandboxInstance>).isContainerRunning;
  if (typeof isContainerRunning !== 'function') return undefined;
  try {
    return await (sandbox as MeteredSandboxInstance).isContainerRunning();
  } catch (error) {
    logger
      .withFields({ error: error instanceof Error ? error.message : String(error) })
      .warn('Container running probe failed');
    return undefined;
  }
}

function supportsControlPlaneForceDestroy(
  sandbox: unknown
): sandbox is Pick<MeteredSandboxInstance, 'forceDestroyForControlPlane'> {
  return (
    typeof sandbox === 'object' &&
    sandbox !== null &&
    'forceDestroyForControlPlane' in sandbox &&
    typeof sandbox.forceDestroyForControlPlane === 'function'
  );
}

export async function forceDestroyControlPlaneSandbox(sandbox: unknown): Promise<void> {
  if (!supportsControlPlaneForceDestroy(sandbox)) {
    throw new Error('Cloudflare control-plane native destruction is unavailable');
  }
  await sandbox.forceDestroyForControlPlane();
}

export async function getSandboxBillingRuntimeStatus(sandbox: SandboxInstance): Promise<
  | {
      sandboxClassName: SandboxClassName;
      running: boolean;
      blocked: boolean;
      context?: BillingContext;
    }
  | undefined
> {
  const capability = sandbox as BillingRuntimeStatusCapability;
  if (typeof capability.getBillingRuntimeStatus !== 'function') return undefined;
  return await capability.getBillingRuntimeStatus();
}

export async function configureSandboxBillingInput(
  sandbox: SandboxInstance,
  input: SandboxBillingInput
): Promise<void> {
  const configureBilling = (sandbox as Partial<MeteredSandboxInstance>).configureBilling;
  if (typeof configureBilling !== 'function') {
    logger.warn('Container usage shadow metering is unavailable for sandbox');
    return;
  }
  try {
    await (sandbox as MeteredSandboxInstance).configureBilling(input);
  } catch (error) {
    logger
      .withFields({ error: error instanceof Error ? error.message : String(error) })
      .warn('Container usage shadow configuration deferred');
  }
}
