/**
 * Canonical allocation seeding for Workers integration fixtures.
 *
 * The live DO no longer writes or reads the flat allocation record; it persists
 * only the canonical envelope. `claimCreate`/`confirmInstance`/`observeProvider`
 * were the flat allocation-machine entry points and are removed. This module
 * gives the integration fixtures one canonical way to seed an allocation so the
 * live path observes it through `loadAllocation`, mirroring the shapes the
 * removed builders produced.
 */
import type { AllocationRecord } from '../../src/sandbox-state/model/allocation.js';
import type { CredentialContainmentRequirements } from '../../src/sandbox-state/model/allocation.js';
import {
  allocationFixture,
  type AllocationFixture,
} from '../../src/sandbox-state/model/allocation-fixtures.js';
import { decodeCloudflareProviderRef } from '../../src/sandbox-control/cloudflare-provider.js';
import { decodeVercelProviderRef } from '../../src/sandbox-control/vercel-provider.js';
import { storeAllocation } from '../../src/sandbox-control/durable-state.js';

export type CanonicalStorage = Parameters<typeof storeAllocation>[0];

export const WORKTREE_CONTAINMENT: CredentialContainmentRequirements = {
  kilocode: true,
  github: true,
  worktreeScoped: true,
};

/** Builds the canonical aggregate, throwing when a descriptor has no canonical shape. */
export function canonicalAllocation(fixture: AllocationFixture): AllocationRecord {
  const record = allocationFixture(fixture);
  if (!record) throw new Error('Unrepresentable canonical allocation fixture');
  return record;
}

export async function seedCanonicalAllocation(
  storage: CanonicalStorage,
  fixture: AllocationFixture
): Promise<AllocationRecord> {
  const record = canonicalAllocation(fixture);
  await storeAllocation(storage, record);
  return record;
}

export type RunningFixtureOptions = {
  provider?: 'cloudflare' | 'vercel';
  containment?: CredentialContainmentRequirements;
  intentId?: string;
  allocationName?: string;
  createdAt?: number;
  idleAt?: number | null;
  health?: 'connecting' | 'healthy';
  heartbeatAt?: number;
};

/** The canonical descriptor mirroring the removed `containedRunningRecord` builder. */
export function runningAllocationFixture(
  providerRef: string,
  options: RunningFixtureOptions = {}
): AllocationFixture {
  const cloudflare = decodeCloudflareProviderRef(providerRef);
  const vercel = decodeVercelProviderRef(providerRef);
  const containment = options.containment ?? WORKTREE_CONTAINMENT;
  const provider = options.provider ?? (vercel ? 'vercel' : 'cloudflare');
  const intentId = options.intentId ?? cloudflare?.instanceId ?? 'intent_contained';
  const allocationName = options.allocationName ?? cloudflare?.sandboxId ?? vercel?.sandboxName;
  const health = options.health ?? 'connecting';
  return {
    state: 'running',
    provider,
    providerRef,
    createIntent: {
      intentId,
      createdAt: options.createdAt ?? Date.now(),
      ...(allocationName === undefined ? {} : { allocationName }),
      containment,
    },
    containment: { ...containment, providerRef },
    health,
    ...(health === 'connecting' ? {} : { heartbeatAt: options.heartbeatAt ?? Date.now() }),
    ...(options.idleAt === undefined ? {} : { idleAt: options.idleAt }),
  };
}

/** Seeds a creating allocation, mirroring the removed `claimCreate` seed. */
export async function seedCreatingAllocation(
  storage: CanonicalStorage,
  intentId: string,
  options: { allocationName?: string; containment?: CredentialContainmentRequirements } = {}
): Promise<AllocationRecord> {
  return seedCanonicalAllocation(storage, {
    state: 'creating',
    provider: 'cloudflare',
    createIntent: {
      intentId,
      createdAt: Date.now(),
      ...(options.allocationName === undefined ? {} : { allocationName: options.allocationName }),
      ...(options.containment === undefined ? {} : { containment: options.containment }),
    },
  });
}

/** Seeds a running, contained allocation and returns its provider reference. */
export async function seedCanonicalRunning(
  storage: CanonicalStorage,
  providerRef: string,
  options: RunningFixtureOptions = {}
): Promise<string> {
  await seedCanonicalAllocation(storage, runningAllocationFixture(providerRef, options));
  return providerRef;
}
