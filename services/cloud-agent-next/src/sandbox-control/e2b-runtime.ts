import { E2BProviderError } from '../byoc/e2b-errors.js';
import { E2B_CREDENTIAL_REQUEST_TIMEOUT_MS } from '../byoc/e2b-credential-resolver.js';
import { parseE2BReleaseConfig, type E2BRuntimeEnv } from '../byoc/e2b-runtime-config.js';
import type { E2BSandboxProviderBinding } from '../sandbox-provider-binding.js';
import {
  e2bAllocationConfigSchema,
  type E2BAllocationConfig,
  type E2BSubmittedAllocationConfig,
} from '../sandbox-state/model/allocation.js';

import { z } from 'zod';

export const E2B_INITIAL_LEASE_MS = 300_000;
export const E2B_MAX_LIFETIME_MS = 3_600_000;
export const E2B_RECONCILIATION_WINDOW_MS = 60_000;
/** How long a single discovery scan may run; exported so the lead below is a sum. */
export const E2B_SCAN_TIMEOUT_MS = 10_000;
/**
 * The first recovery wake must leave room for the credential retrieval HTTP call
 * and the scan that follows it. The lead is the sum of the two budgets, never a
 * second hardcoded constant, so the two cannot drift.
 */
export const E2B_RECONCILIATION_LEAD_MS =
  E2B_CREDENTIAL_REQUEST_TIMEOUT_MS + E2B_SCAN_TIMEOUT_MS;
export const E2B_RESOURCE_PROFILE = Object.freeze({ cpuCount: 2, memoryMB: 4096 } as const);

/** The E2B physical sandbox id shape, shared by the API client and the ref codec. */
export const e2bPhysicalIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9-]*$/)
  .refine(value => value === value.trim());

export type E2BProviderRef = { physicalId: string; intentId: string };

export function parseE2BAllocationConfig(raw: unknown): E2BAllocationConfig {
  const parsed = e2bAllocationConfigSchema.safeParse(raw);
  if (!parsed.success) throw new E2BProviderError('byoc_e2b_policy_mismatch');
  return parsed.data;
}

/**
 * The demand-time pending block. `hardStopAt` is pinned from `createdAt`, exactly
 * as `createE2BCreateIntent` did on the flat model.
 */
export function createE2BPendingConfig(input: {
  binding: E2BSandboxProviderBinding;
  sandboxId: string;
  env: E2BRuntimeEnv;
  createdAt: number;
}): E2BAllocationConfig {
  const release = parseE2BReleaseConfig(input.env);
  const parsed = e2bAllocationConfigSchema.safeParse({
    binding: input.binding,
    sandboxId: input.sandboxId,
    ...release,
    resourceProfile: E2B_RESOURCE_PROFILE,
    hardStopAt: input.createdAt + E2B_MAX_LIFETIME_MS,
    submissionState: 'pending',
  });
  if (!parsed.success) throw new E2BProviderError('byoc_e2b_template_unavailable');
  return parsed.data;
}

/** The owner identity check shared by every operation on a pinned block. */
export function parseOwnedE2BConfig(
  raw: unknown,
  binding: E2BSandboxProviderBinding,
  sandboxId: string
): E2BAllocationConfig {
  const config = parseE2BAllocationConfig(raw);
  if (config.binding.organizationId !== binding.organizationId) {
    throw new E2BProviderError('byoc_e2b_policy_mismatch');
  }
  if (config.binding.credentialId !== binding.credentialId) {
    throw new E2BProviderError('byoc_e2b_policy_mismatch');
  }
  if (config.sandboxId !== sandboxId) {
    throw new E2BProviderError('byoc_e2b_policy_mismatch');
  }
  return config;
}

/**
 * The only computer of `submittedAt`, `createDeadlineAt`,
 * `reconciliationDeadlineAt` and `reconciliationAlarmAt`. The reducer copies the
 * returned block verbatim; it never recomputes a timestamp.
 */
export function markE2BConfigSubmitted(input: {
  config: E2BAllocationConfig;
  binding: E2BSandboxProviderBinding;
  sandboxId: string;
  now: number;
  createDeadlineAt: number;
}): E2BSubmittedAllocationConfig {
  const config = parseOwnedE2BConfig(input.config, input.binding, input.sandboxId);
  if (config.submissionState !== 'pending') {
    throw new E2BProviderError('byoc_e2b_create_unknown');
  }
  if (!Number.isSafeInteger(input.now) || input.now >= config.hardStopAt) {
    throw new E2BProviderError('byoc_e2b_lifetime_exceeded');
  }
  if (!Number.isSafeInteger(input.createDeadlineAt) || input.createDeadlineAt <= input.now) {
    throw new E2BProviderError('byoc_e2b_create_unknown');
  }
  if (input.createDeadlineAt > config.hardStopAt) {
    throw new E2BProviderError('byoc_e2b_create_unknown');
  }
  const reconciliationDeadlineAt = Math.min(
    input.now + E2B_RECONCILIATION_WINDOW_MS,
    config.hardStopAt
  );
  const reconciliationAlarmAt =
    reconciliationDeadlineAt - input.now >= E2B_RECONCILIATION_LEAD_MS
      ? reconciliationDeadlineAt - E2B_RECONCILIATION_LEAD_MS
      : undefined;
  const parsed = e2bAllocationConfigSchema.safeParse({
    ...config,
    submissionState: 'submitted',
    submittedAt: input.now,
    createDeadlineAt: input.createDeadlineAt,
    reconciliationDeadlineAt,
    ...(reconciliationAlarmAt !== undefined ? { reconciliationAlarmAt } : {}),
  });
  if (!parsed.success) throw new E2BProviderError('byoc_e2b_policy_mismatch');
  return parsed.data as E2BSubmittedAllocationConfig;
}

export function parseE2BProviderRef(raw: string | null): E2BProviderRef | null {
  if (typeof raw !== 'string' || raw.length > 256) return null;
  const parts = raw.split(':');
  if (parts.length !== 3 || parts[0] !== 'e2b1') return null;
  const physicalId = e2bPhysicalIdSchema.safeParse(parts[1]);
  const intentId = parts[2] ?? '';
  if (!physicalId.success) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(intentId)) {
    return null;
  }
  return { physicalId: physicalId.data, intentId };
}

export function encodeE2BProviderRef(ref: E2BProviderRef): string {
  const encoded = `e2b1:${ref.physicalId}:${ref.intentId}`;
  if (!parseE2BProviderRef(encoded)) throw new E2BProviderError('byoc_e2b_policy_mismatch');
  return encoded;
}

/**
 * The provider discovery metadata. Identity only: the API key never enters it.
 * The create operation id is the canonical create intent id, passed in because
 * it is not part of the pinned provider block.
 */
export function e2bCreateMetadata(
  config: E2BAllocationConfig,
  intentId: string
): Record<string, string> {
  return {
    source: 'kilo-cloud-agent-next',
    organizationId: config.binding.organizationId,
    credentialId: config.binding.credentialId,
    sandboxId: config.sandboxId,
    operationId: intentId,
    runtimeBuildId: config.runtimeBuildId,
    templateId: config.templateId,
    templateReference: config.templateReference,
  };
}

/**
 * The create operation bound, computed once by the caller from the acquisition
 * deadline, the 120s create deadline and the hard stop, in that order.
 */
export function e2bCreateDeadline(input: {
  acquisitionDeadlineAt: number | null;
  creatingDeadlineAt: number;
  hardStopAt: number;
}): number {
  return Math.min(
    input.acquisitionDeadlineAt ?? input.creatingDeadlineAt,
    input.creatingDeadlineAt,
    input.hardStopAt
  );
}

/** True only when a validated block is a pending create that never POSTed. */
export function e2bCreateWasNotSubmitted(config: E2BAllocationConfig): boolean {
  return config.submissionState === 'pending';
}
