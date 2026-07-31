import {
  billingActorSchema,
  billingSubjectSchema,
  usageContextSchema,
  type UsageContext,
} from '@kilocode/container-usage';
import { z } from 'zod';
import { logger } from './logger.js';
import type { SessionMetadata } from './persistence/session-metadata.js';
import type { SandboxId, SandboxInstance } from './types.js';

export const SANDBOX_USAGE_SKUS = {
  Sandbox: 'cloud-agent-standard-2026-07',
  SandboxContainment: 'cloud-agent-standard-2026-07',
  SandboxSmall: 'cloud-agent-small-2026-07',
  SandboxSmallContainment: 'cloud-agent-small-2026-07',
  SandboxDIND: 'cloud-agent-dind-2026-07',
  SandboxCodeReview: 'cloud-agent-code-review-2026-07',
  SandboxCodeReviewContainment: 'cloud-agent-code-review-2026-07',
} as const;

export type SandboxClassName = keyof typeof SANDBOX_USAGE_SKUS;
export type SandboxBillingInput = Omit<UsageContext, 'service' | 'instanceId' | 'sku'> & {
  sandboxId: SandboxId;
};
export type MeteredSandboxInstance = SandboxInstance & {
  configureBilling(input: unknown): Promise<void>;
  isContainerRunning(): Promise<boolean>;
};

const sandboxBillingInputEnvelopeSchema = z
  .object({
    sandboxId: z
      .string()
      .min(1)
      .max(63)
      .refine(
        value => /^(ses|crv|dind|org|usr|bot|ubt)-[0-9a-f]+$/.test(value) || value.includes('__'),
        'Invalid sandboxId format'
      )
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

function isIsolatedSandbox(sandboxId: SandboxId): boolean {
  return /^(crv|dind|ses)-/.test(sandboxId);
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
  const isolated = isIsolatedSandbox(sandboxId);

  return {
    sandboxId,
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
  const { sandboxId, ...usageInput } = parsed;
  const validated = usageContextSchema.parse({
    service: 'cloud-agent-next',
    instanceId: 'validation',
    sku: 'validation',
    ...usageInput,
  });
  const { service: _service, instanceId: _instanceId, sku: _sku, ...billingInput } = validated;
  return { sandboxId, ...billingInput };
}

export function assertSandboxBillingAllocation(
  sandboxClassName: SandboxClassName,
  input: SandboxBillingInput
): void {
  const shared = sandboxClassName === 'Sandbox' || sandboxClassName === 'SandboxContainment';
  if (shared) {
    if (input.sessionId !== undefined) {
      throw new Error('Shared sandbox billing cannot contain session attribution');
    }
    const legacySharedId =
      !/^(ses|crv|dind)-/.test(input.sandboxId) && input.sandboxId.includes('__');
    if (!/^(org|usr|bot|ubt)-/.test(input.sandboxId) && !legacySharedId) {
      throw new Error('Shared sandbox billing requires a shared sandbox ID');
    }
    if (input.metadata !== undefined && Object.keys(input.metadata).length > 0) {
      throw new Error('Shared sandbox billing cannot contain metadata');
    }
    return;
  }

  const expectedPrefix =
    sandboxClassName === 'SandboxDIND'
      ? 'dind-'
      : sandboxClassName === 'SandboxSmall' || sandboxClassName === 'SandboxSmallContainment'
        ? 'ses-'
        : 'crv-';
  if (!input.sandboxId.startsWith(expectedPrefix)) {
    throw new Error(`${sandboxClassName} billing requires a ${expectedPrefix} sandbox ID`);
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
