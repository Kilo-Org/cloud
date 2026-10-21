import { getBillingContext, type ContainerUsageRpcMethods } from '@kilocode/container-usage';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { expect } from 'vitest';
import type { SandboxControlV2 } from '../../../src/control-plane/sandbox/sandbox-do.js';
import type { SandboxBillingInput } from '../../../src/container-usage-context.js';
import type { SandboxId } from '../../../src/types.js';
import { waitFor } from '../wait-for.js';

/** The `vercel-small` configuration that `buildControlPlaneSandboxSelection` pins. */
export const VERCEL_SMALL_CONFIGURATION = {
  provider: 'vercel',
  resources: { vcpus: 2, memory: 4096 },
} as const;

/** Isolated Vercel billing in the shape that `buildSandboxBillingInput` builds. */
export function vercelBilling(input: {
  sandboxId: string;
  sessionId: string;
  userId: string;
  orgId?: string;
}): SandboxBillingInput {
  return {
    sandboxId: input.sandboxId as SandboxId,
    subject:
      input.orgId === undefined
        ? { type: 'user', id: input.userId }
        : { type: 'org', id: input.orgId },
    actor: { type: 'user', id: input.userId },
    sessionId: input.sessionId,
    metadata: { origin: 'cloud-agent' },
  };
}

/** A Vercel selection with the configuration and billing that production pins. */
export function vercelSandboxSelection(input: Parameters<typeof vercelBilling>[0]) {
  return {
    provider: 'vercel' as const,
    configuration: VERCEL_SMALL_CONFIGURATION,
    billing: vercelBilling(input),
  };
}

function intervalIdFor(input: { instanceId: string; startEpochMs: number }): string {
  return `${input.instanceId}:${input.startEpochMs}`;
}

/** A usage meter that acknowledges every interval, so Vercel admission admits each create. */
export function createAckingUsageMeter(): ContainerUsageRpcMethods {
  return {
    async recordStart(input) {
      return {
        success: true,
        ack: { intervalId: intervalIdFor(input), durable: 'pg', dedup: false },
      };
    },
    async recordHeartbeat(input) {
      return {
        intervalId: intervalIdFor(input),
        durable: 'pg',
        dedup: false,
        budget: { verdict: 'continue' },
      };
    },
    async recordStop(input) {
      return { intervalId: intervalIdFor(input), durable: 'pg', dedup: false };
    },
  };
}

/** Binds the acking meter to one Sandbox DO instance, not to the shared test env. */
export function installAckingUsageMeter(instance: SandboxControlV2): void {
  Object.assign(instance, {
    env: { ...instance.env, CONTAINER_USAGE_METER: createAckingUsageMeter() },
  });
}

/**
 * Gives a Sandbox DO the owner and the acking meter for a create that does not
 * come from a prepare. Production stores the owner on the first prepare.
 */
export async function installVercelBilling(
  instance: SandboxControlV2,
  state: DurableObjectState,
  ownerId: string
): Promise<void> {
  await state.storage.put('control_plane_owner', ownerId);
  installAckingUsageMeter(instance);
}

/**
 * Settles the previous Vercel interval. Until then a new create gets `retry`
 * and waits one create backoff, which is longer than a test.
 */
export async function awaitVercelSettlement(
  stub: DurableObjectStub<SandboxControlV2>
): Promise<void> {
  await waitFor(async () => {
    await runDurableObjectAlarm(stub);
    expect(
      await runInDurableObject(stub, (_instance, state) => getBillingContext(state.storage))
    ).toBeUndefined();
  });
}
