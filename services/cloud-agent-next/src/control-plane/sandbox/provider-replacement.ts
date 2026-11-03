import { z } from 'zod';
import type { ByocVercelSource } from '../../byoc/vercel-provider.js';
import {
  sandboxProviderConfigurationSchema,
  type SandboxProviderConfiguration,
} from '../../sandbox-control/provider.js';
import {
  vercelProviderLocatorSchema,
  type VercelProviderLocator,
} from '../../sandbox-control/vercel-provider.js';

export const PENDING_PROVIDER_REPLACEMENT_PREFIX = 'pending_provider_replacement/';

export type ReplacementProviderPin = {
  allocationName: string;
  byoc?: ByocVercelSource;
  configuration: SandboxProviderConfiguration | null;
  locator: VercelProviderLocator | null;
};

export type PendingProviderReplacement = {
  allocationId: string;
  createdAt: number;
  expiresAt: number;
  nextReconcileAt: number;
  pin: ReplacementProviderPin;
  intent: {
    intentId: string;
    createdAt: number;
    allocationName: string;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const byocSourceSchema = z.custom<ByocVercelSource>(value => {
  if (!isRecord(value)) return false;
  return (
    typeof value.credentialId === 'string' &&
    value.credentialId.length > 0 &&
    (typeof value.organizationId === 'string' || typeof value.userId === 'string')
  );
});

const pendingProviderReplacementSchema = z
  .object({
    allocationId: z.string().min(1),
    createdAt: z.number().finite().nonnegative(),
    expiresAt: z.number().finite().nonnegative(),
    nextReconcileAt: z.number().finite().nonnegative(),
    pin: z
      .object({
        allocationName: z.string().min(1),
        byoc: byocSourceSchema.optional(),
        configuration: sandboxProviderConfigurationSchema.nullable(),
        locator: vercelProviderLocatorSchema.nullable(),
      })
      .strict(),
    intent: z
      .object({
        intentId: z.string().min(1),
        createdAt: z.number().finite().nonnegative(),
        allocationName: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export function pendingProviderReplacementKey(allocationId: string): string {
  return `${PENDING_PROVIDER_REPLACEMENT_PREFIX}${allocationId}`;
}

export async function writePendingProviderReplacement(
  storage: Pick<DurableObjectStorage, 'put'>,
  replacement: PendingProviderReplacement
): Promise<void> {
  await storage.put(pendingProviderReplacementKey(replacement.allocationId), replacement);
}

export async function readPendingProviderReplacement(
  storage: Pick<DurableObjectStorage, 'get'>,
  allocationId: string
): Promise<PendingProviderReplacement | undefined> {
  return pendingProviderReplacementSchema
    .optional()
    .parse(await storage.get(pendingProviderReplacementKey(allocationId)));
}

export async function listPendingProviderReplacements(
  storage: Pick<DurableObjectStorage, 'list' | 'delete'>
): Promise<PendingProviderReplacement[]> {
  const entries = await storage.list({ prefix: PENDING_PROVIDER_REPLACEMENT_PREFIX });
  const replacements: PendingProviderReplacement[] = [];
  for (const [key, value] of entries) {
    const parsed = pendingProviderReplacementSchema.safeParse(value);
    if (parsed.success) replacements.push(parsed.data);
    else await storage.delete(key);
  }
  return replacements;
}

export async function clearPendingProviderReplacement(
  storage: Pick<DurableObjectStorage, 'delete'>,
  allocationId: string
): Promise<void> {
  await storage.delete(pendingProviderReplacementKey(allocationId));
}
