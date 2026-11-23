import { z } from 'zod';
import {
  assertNetworkSecretDestinations,
  networkSecretsSchema,
  networkSecretStoredPolicySchema,
  networkSecretEnvelopeSchema,
  NETWORK_SECRET_LIMITS,
} from '@kilocode/worker-utils/network-secrets';
import {
  createControlPlaneCredential,
  parseControlPlaneCredential,
} from '../sandbox-control/managed-credential.js';
import { deriveKiloSandboxTargets, type KiloTargetEnv } from '../kilo/kilo-targets.js';
import type { ControlPlaneCredentialSource } from '../shared/control-plane-protocol.js';
import { CLOUD_AGENT_SESSION_SYNC_ORIGIN } from '@kilocode/worker-utils/cloud-agent-session-sync';
import { NetworkSecretConfigurationError } from './errors.js';

export const networkSecretGrantsSchema = z
  .array(
    networkSecretStoredPolicySchema.extend({
      key: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      alias: z
        .string()
        .max(512)
        .refine(alias => parseControlPlaneCredential(alias)?.purpose === 'secret'),
      envelope: networkSecretEnvelopeSchema,
    })
  )
  .max(NETWORK_SECRET_LIMITS.MAX_SECRETS);
export type NetworkSecretGrant = z.infer<typeof networkSecretGrantsSchema>[number];

export function mintNetworkSecretGrants(
  sandboxId: string,
  snapshot: unknown,
  excludedUrls: readonly string[]
): NetworkSecretGrant[] {
  try {
    const secrets = networkSecretsSchema.parse(snapshot ?? {});
    assertNetworkSecretDestinations(secrets, excludedUrls);
    return Object.entries(secrets).map(([key, secret]) => ({
      key,
      ...secret,
      alias: createControlPlaneCredential(sandboxId, 'secret'),
    }));
  } catch {
    throw new NetworkSecretConfigurationError();
  }
}

export function networkSecretEnvironment(
  grants: readonly NetworkSecretGrant[] | undefined
): Record<string, string> {
  return Object.fromEntries((grants ?? []).map(secret => [secret.key, secret.alias]));
}

export function networkSecretExcludedUrls(
  env: KiloTargetEnv & { WORKER_URL?: string },
  source: ControlPlaneCredentialSource,
  repositoryUrls: readonly string[] = []
): string[] {
  return [
    ...networkSecretInfrastructureUrls(env, source.kiloToken),
    ...(source.repository?.type === 'gitlab' ? [source.repository.url] : []),
    ...repositoryUrls,
  ];
}

export function networkSecretInfrastructureUrls(
  env: KiloTargetEnv & { WORKER_URL?: string },
  kiloToken = ''
): string[] {
  try {
    const targets = deriveKiloSandboxTargets(env, kiloToken);
    if (!targets.success) throw new Error('Network secret destinations unavailable');
    return [
      ...Object.values(targets.targets),
      CLOUD_AGENT_SESSION_SYNC_ORIGIN,
      ...(env.WORKER_URL ? [env.WORKER_URL] : []),
    ];
  } catch {
    throw new NetworkSecretConfigurationError();
  }
}
