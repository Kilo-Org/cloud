import { computeMemberMetadata } from '@kilocode/worker-utils/compute-member';
import {
  billingActorSchema,
  billingSubjectSchema,
  usageContextSchema,
  ContainerUsageAdmissionError,
  isNonRetryableAdmissionError,
  type UsageContext,
} from '@kilocode/container-usage';
import { z } from 'zod';
import {
  getSandboxAllocationResources,
  type CloudflareContainersInstance,
  type SandboxAllocation,
  type VercelSandboxResources,
} from '@kilocode/worker-utils/sandbox-allocation';
import { isIsolatedSandboxId, isValidSandboxId, type SandboxIdClass } from './sandbox-id.js';
import { resolveSandboxIdClass, sandboxKindSchema, type SandboxKind } from './sandbox-placement.js';
import {
  CODE_REVIEW_CONTAINERS_INSTANCE,
  CODE_REVIEW_CONTAINERS_RESOURCES,
} from './sandbox-containers/instance-size.js';
import type { SessionMetadata } from './persistence/session-metadata.js';
import type { SandboxId } from './types.js';
import {
  CLOUD_AGENT_CONTAINER_CLASSES,
  SANDBOX_USAGE_SKUS,
} from '@kilocode/worker-utils/cloud-agent-compute';
export { SANDBOX_USAGE_SKUS };

export type SandboxClassName = keyof typeof SANDBOX_USAGE_SKUS;

export type SandboxCapacity = { vcpu: number; memoryMiB: number; diskMB: number };

export type ContainersBillingClassName =
  | 'SandboxContainersStandard3'
  | 'SandboxContainersStandard4'
  | 'SandboxContainersCodeReview';

export type VercelBillingClassName = 'SandboxVercelSmall' | 'SandboxVercelLarge';

export type LegacySandboxClassName = Exclude<
  SandboxClassName,
  ContainersBillingClassName | VercelBillingClassName
>;

// Production values mirror this service's top-level wrangler.jsonc entries and
// apps/web/src/lib/cloudflare/container-capacity.ts. Keep all three in sync manually.
// Development intentionally uses different named instance types and does not query Analytics.
export const SANDBOX_CAPACITIES: Record<LegacySandboxClassName, SandboxCapacity> = {
  SandboxContainment: { vcpu: 4, memoryMiB: 12_288, diskMB: 20_000 },
  SandboxSmallContainment: { vcpu: 2, memoryMiB: 6_144, diskMB: 20_000 },
};

// One `SandboxContainers` Durable Object serves every instance size, so there is no per-size
// wrangler class; these billing classes carry the instance-keyed metering capacity.
export const CONTAINERS_BILLING_CAPACITIES: Record<ContainersBillingClassName, SandboxCapacity> = {
  SandboxContainersStandard3: { vcpu: 2, memoryMiB: 8_192, diskMB: 16_000 },
  SandboxContainersStandard4: { vcpu: 4, memoryMiB: 12_288, diskMB: 20_000 },
  SandboxContainersCodeReview: {
    vcpu: CODE_REVIEW_CONTAINERS_RESOURCES.vcpu,
    memoryMiB: CODE_REVIEW_CONTAINERS_RESOURCES.memoryMib,
    diskMB: CODE_REVIEW_CONTAINERS_RESOURCES.diskMb,
  },
};

/** Vercel presets have no disk; the session schema carries `vcpus` and `memory` only. */
export type VercelBillingCapacity = { vcpu: number; memoryMiB: number };

/** The Vercel preset each billing class measures; `sandbox-allocation` owns the dimensions. */
const VERCEL_ALLOCATION_BY_CLASS: Record<VercelBillingClassName, SandboxAllocation> = {
  SandboxVercelSmall: 'vercel-small',
  SandboxVercelLarge: 'vercel-large',
};

export const VERCEL_BILLING_CAPACITIES: Record<VercelBillingClassName, VercelBillingCapacity> =
  Object.fromEntries(
    Object.entries(VERCEL_ALLOCATION_BY_CLASS).map(([className, allocation]) => {
      const resources = getSandboxAllocationResources(allocation);
      if (resources === undefined) {
        throw new Error(`Vercel billing allocation has no resources: ${allocation}`);
      }
      return [className, { vcpu: resources.vcpus, memoryMiB: resources.memory }];
    })
  ) as Record<VercelBillingClassName, VercelBillingCapacity>;

const USAGE_SERVICE_ROOT = 'cloud-agent-next';

export function usageServiceForSandboxClass(sandboxClassName: SandboxClassName): string {
  const suffix = sandboxClassName.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  return `${USAGE_SERVICE_ROOT}-${suffix}`;
}

export function isContainersBillingClassName(
  sandboxClassName: SandboxClassName
): sandboxClassName is ContainersBillingClassName {
  return Object.hasOwn(CONTAINERS_BILLING_CAPACITIES, sandboxClassName);
}

export function isVercelBillingClassName(
  sandboxClassName: SandboxClassName
): sandboxClassName is VercelBillingClassName {
  return Object.hasOwn(VERCEL_BILLING_CAPACITIES, sandboxClassName);
}

export function billingCapacityForSandboxClass(
  sandboxClassName: SandboxClassName
): SandboxCapacity | VercelBillingCapacity {
  if (isVercelBillingClassName(sandboxClassName)) {
    return VERCEL_BILLING_CAPACITIES[sandboxClassName];
  }
  if (isContainersBillingClassName(sandboxClassName)) {
    return CONTAINERS_BILLING_CAPACITIES[sandboxClassName];
  }
  return SANDBOX_CAPACITIES[sandboxClassName];
}

export type ContainersBillingIdentity = {
  className: ContainersBillingClassName;
  service: string;
  sku: string;
  capacity: SandboxCapacity;
};

const CONTAINERS_CLASS_BY_INSTANCE: Record<string, ContainersBillingClassName | undefined> = {
  ...CLOUD_AGENT_CONTAINER_CLASSES,
  [CODE_REVIEW_CONTAINERS_INSTANCE]: 'SandboxContainersCodeReview',
} satisfies Record<
  CloudflareContainersInstance | typeof CODE_REVIEW_CONTAINERS_INSTANCE,
  ContainersBillingClassName
>;

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

export type VercelBillingIdentity = {
  className: VercelBillingClassName;
  service: string;
  sku: string;
  capacity: VercelBillingCapacity;
};

export function vercelBillingIdentity(resources: VercelSandboxResources): VercelBillingIdentity {
  const matchingClass = (Object.keys(VERCEL_BILLING_CAPACITIES) as VercelBillingClassName[]).find(
    className =>
      VERCEL_BILLING_CAPACITIES[className].vcpu === resources.vcpus &&
      VERCEL_BILLING_CAPACITIES[className].memoryMiB === resources.memory
  );
  if (matchingClass === undefined) {
    throw new Error(
      `Vercel billing is unsupported for resources: ${resources.vcpus}:${resources.memory}`
    );
  }
  return {
    className: matchingClass,
    service: usageServiceForSandboxClass(matchingClass),
    sku: SANDBOX_USAGE_SKUS[matchingClass],
    capacity: VERCEL_BILLING_CAPACITIES[matchingClass],
  };
}

export type SandboxBillingInput = Omit<UsageContext, 'service' | 'instanceId' | 'sku'> & {
  sandboxId: SandboxId;
  /** Present for a placed key, whose prefix does not say which pool may bill it. */
  sandboxKind?: SandboxKind;
};
export type SandboxBillingAdmissionResult =
  | { success: true }
  | {
      success: false;
      code: 'insufficient_credits' | 'meter_unavailable' | 'stopping' | 'invalid_configuration';
      message: string;
      remainingMicrodollars?: number;
      minimumRequiredMicrodollars?: number;
    };

export const sandboxBillingInputEnvelopeSchema = z
  .object({
    sandboxId: z
      .string()
      .min(1)
      .max(63)
      .refine(isValidSandboxId, 'Invalid sandboxId format')
      .transform(value => value),
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
    enforcementRequested: z.boolean().optional(),
    sandboxKind: sandboxKindSchema.optional(),
  })
  .strict();

const KNOWN_ORIGINS = new Set([
  'agent-manager',
  'cloud-agent',
  'cloud-agent-web',
  'code-review',
  'environment-build',
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
  sandboxId: SandboxId
): SandboxBillingInput {
  const subject = metadata.identity.orgId
    ? { type: 'org' as const, id: metadata.identity.orgId }
    : { type: 'user' as const, id: metadata.identity.userId };
  const actor = metadata.identity.botId
    ? { type: 'bot' as const, id: metadata.identity.botId }
    : { type: 'user' as const, id: metadata.identity.userId };
  const sandboxKind = metadata.workspace?.sandboxKind;
  const isolated = sandboxKind ? sandboxKind !== 'shared' : isIsolatedSandboxId(sandboxId);

  return {
    sandboxId,
    ...(sandboxKind ? { sandboxKind } : {}),
    subject,
    actor,
    ...(actor.type === 'bot' ? { onBehalfOf: subject } : {}),
    ...(isolated ? { sessionId: metadata.identity.sessionId } : {}),
    ...(isolated
      ? {
          metadata: {
            origin: normalizedOrigin(metadata.identity.billingOrigin),
            ...(metadata.workspace?.sandboxProvider === 'cloudflare-containers' &&
            subject.type === 'org'
              ? computeMemberMetadata(actor, metadata.identity.userId)
              : {}),
          },
        }
      : {}),
  };
}

export function parseSandboxBillingInput(input: unknown): SandboxBillingInput {
  const parsed = sandboxBillingInputEnvelopeSchema.parse(input);
  delete parsed.enforcementRequested;
  const { sandboxId, sandboxKind, ...usageInput } = parsed;
  const validated = usageContextSchema.parse({
    service: USAGE_SERVICE_ROOT,
    instanceId: 'validation',
    sku: 'validation',
    ...usageInput,
  });
  const { service: _service, instanceId: _instanceId, sku: _sku, ...billingInput } = validated;
  return {
    sandboxId,
    ...(sandboxKind ? { sandboxKind } : {}),
    ...billingInput,
  };
}

/** Isolated sandbox identities accepted by each remaining runtime's billing class. */
function expectedIsolatedSandboxIdClasses(
  sandboxClassName: SandboxClassName
): readonly SandboxIdClass[] {
  if (sandboxClassName === 'SandboxContainment') return ['isolated-standard'];
  if (sandboxClassName === 'SandboxContainersCodeReview') return ['code-review'];
  return ['isolated-small'];
}

export function assertSandboxBillingAllocation(
  sandboxClassName: SandboxClassName,
  input: SandboxBillingInput
): void {
  const sandboxIdClass = resolveSandboxIdClass(input);
  const standardClass = sandboxClassName === 'SandboxContainment';
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

  if (!expectedIsolatedSandboxIdClasses(sandboxClassName).includes(sandboxIdClass)) {
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
  if (
    isContainersBillingClassName(sandboxClassName) &&
    input.subject.type === 'org' &&
    input.actor.type === 'bot'
  ) {
    allowedMetadata.add('billingUserId');
  }
  if (Object.keys(metadata).some(key => !allowedMetadata.has(key))) {
    throw new Error('Isolated sandbox billing metadata contains an unsupported field');
  }
}

export function billingAdmissionFailureFromError(error: unknown): SandboxBillingAdmissionResult {
  if (isNonRetryableAdmissionError(error)) {
    return {
      success: false,
      code: 'invalid_configuration',
      message: 'Compute billing configuration requires correction',
    };
  }
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
