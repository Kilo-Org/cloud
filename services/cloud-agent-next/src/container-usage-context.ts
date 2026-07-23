import {
  billingActorSchema,
  billingSubjectSchema,
  usageContextSchema,
  type UsageContext,
} from '@kilocode/container-usage';
import { z } from 'zod';
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
export type SandboxBillingInput = Omit<UsageContext, 'service' | 'instanceId' | 'sku'>;
export type MeteredSandboxInstance = SandboxInstance & {
  configureBilling(input: unknown): Promise<void>;
};

const sandboxBillingInputEnvelopeSchema = z
  .object({
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
    subject,
    actor,
    ...(actor.type === 'bot' ? { onBehalfOf: subject } : {}),
    ...(isolated ? { sessionId: metadata.identity.sessionId } : {}),
    metadata: isolated
      ? {
          allocation: 'isolated',
          origin: normalizedOrigin(metadata.identity.billingOrigin),
          ...(metadata.repository ? { repository_provider: metadata.repository.type } : {}),
        }
      : { allocation: 'shared' },
  };
}

export function parseSandboxBillingInput(input: unknown): SandboxBillingInput {
  const parsed = sandboxBillingInputEnvelopeSchema.parse(input);
  const validated = usageContextSchema.parse({
    service: 'cloud-agent-next',
    instanceId: 'validation',
    sku: 'validation',
    ...parsed,
  });
  const { service: _service, instanceId: _instanceId, sku: _sku, ...billingInput } = validated;
  return billingInput;
}

export function assertSandboxBillingAllocation(
  sandboxClassName: SandboxClassName,
  input: SandboxBillingInput
): void {
  const shared = sandboxClassName === 'Sandbox' || sandboxClassName === 'SandboxContainment';
  if (shared) {
    if (input.sessionId !== undefined || input.metadata?.allocation !== 'shared') {
      throw new Error('Shared sandbox billing cannot contain session attribution');
    }
    if (Object.keys(input.metadata).some(key => key !== 'allocation')) {
      throw new Error('Shared sandbox billing metadata must contain only allocation');
    }
    return;
  }

  if (!input.sessionId || input.metadata?.allocation !== 'isolated') {
    throw new Error('Isolated sandbox billing requires session attribution');
  }
  const allowedMetadata = new Set(['allocation', 'origin', 'repository_provider']);
  if (Object.keys(input.metadata).some(key => !allowedMetadata.has(key))) {
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

export async function configureSandboxBillingInput(
  sandbox: SandboxInstance,
  input: SandboxBillingInput
): Promise<void> {
  await (sandbox as MeteredSandboxInstance).configureBilling(input);
}
