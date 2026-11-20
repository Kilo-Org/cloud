import { TRPCError } from '@trpc/server';
import { encryptWithPublicKey } from '@kilocode/encryption';
import { z } from 'zod';
import {
  getSandboxAllocationProvider,
  normalizeSandboxAllocation,
  sandboxAllocationSchema,
} from '@kilocode/worker-utils/sandbox-allocation';
import {
  NETWORK_SECRET_LIMITS,
  networkSecretInputSchema,
  networkSecretPolicySchema,
  networkSecretStoredPolicySchema,
  type NetworkSecretChange,
  type NetworkSecretInput,
  type NetworkSecrets,
} from '@kilocode/worker-utils/network-secrets';
import { networkSecretEnvelopeSchema } from '@kilocode/worker-utils/network-secrets';
import { assertValidEnvironmentKey, validateEnvironmentSecretValue } from './environment-contracts';

const storedNetworkEnvelopeSchema = z.object({ network: networkSecretEnvelopeSchema }).strict();

export function assertNetworkSecretAllocation(
  count: number,
  allocation: string | null | undefined
): void {
  const parsed = sandboxAllocationSchema.safeParse(allocation);
  if (
    count > 0 &&
    parsed.success &&
    getSandboxAllocationProvider(normalizeSandboxAllocation(parsed.data)) !==
      'cloudflare-containers'
  ) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Network secrets require a Cloudflare sandbox',
    });
  }
}

export function validateNetworkSecretChanges(changes: readonly NetworkSecretChange[]): void {
  if (changes.length > NETWORK_SECRET_LIMITS.MAX_SECRETS * 2) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Too many network secret changes' });
  }
  const keys = new Set<string>();
  for (const change of changes) {
    assertValidEnvironmentKey(change.key);
    if (keys.has(change.key))
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Duplicate network secret: ${change.key}`,
      });
    keys.add(change.key);
    if ('delete' in change) continue;
    if (!networkSecretInputSchema.safeParse(change).success) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Invalid network secret: ${change.key}`,
      });
    }
    validateEnvironmentSecretValue(change.value);
  }
}

export function networkSecretColumns(publicKeyBase64: string, input: NetworkSecretInput) {
  if (!publicKeyBase64)
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Agent environment encryption key not configured',
    });
  const policy = networkSecretPolicySchema.parse(input);
  return {
    key: input.key,
    value: JSON.stringify({
      network: encryptWithPublicKey(input.value, Buffer.from(publicKeyBase64, 'base64')),
    }),
    is_secret: true,
    delivery: 'network' as const,
    allowed_hosts: policy.allowedHosts,
    injection_locations: policy.locations,
  };
}

export function assertNetworkSecretKeySpace(
  envKeys: Iterable<string>,
  networkKeys: Iterable<string>
): void {
  const keys = new Set(networkKeys);
  if (keys.size > NETWORK_SECRET_LIMITS.MAX_SECRETS) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Maximum ${NETWORK_SECRET_LIMITS.MAX_SECRETS} network secrets allowed`,
    });
  }
  for (const key of envKeys) {
    if (keys.has(key))
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `"${key}" cannot be both an environment variable and a network secret`,
      });
  }
}

export function storedNetworkSecret(variable: {
  value: string;
  allowedHosts: string[] | null;
  locations: string[] | null;
}): NetworkSecrets[string] {
  return {
    ...networkSecretStoredPolicySchema.parse({
      allowedHosts: variable.allowedHosts,
      locations: variable.locations,
    }),
    envelope: storedNetworkEnvelopeSchema.parse(JSON.parse(variable.value)).network,
  };
}
