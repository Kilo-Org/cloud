import { describe, expect, it } from 'vitest';
import {
  getBillingContext,
  setBillingContext,
  updateBillingContext,
  type BillingContextStorage,
} from './context';

function memoryStorage(): BillingContextStorage {
  const values = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key, value) => {
      values.set(key, value);
    },
    delete: async key => values.delete(key),
  };
}

const input = {
  service: 'cloud-agent-next',
  instanceId: 'instance-1',
  startEpochMs: 123,
  sku: 'cloud-agent-next:Sandbox',
  subject: { type: 'user' as const, id: 'user-1' },
  actor: { type: 'user' as const, id: 'user-1' },
};

describe('billing context', () => {
  it('preserves active interval state when provisioning retries', async () => {
    const storage = memoryStorage();
    const initial = await setBillingContext(storage, input);
    await updateBillingContext(storage, {
      ...initial,
      nextSeq: 2,
      pendingHeartbeat: { seq: 2, usageSinceLast: 10, measuredAtMs: 1_000 },
    });

    const retried = await setBillingContext(storage, input);

    expect(retried).toEqual(await getBillingContext(storage));
    expect(retried).toMatchObject({
      generation: initial.generation,
      nextSeq: 2,
      pendingHeartbeat: { seq: 2, usageSinceLast: 10 },
    });
  });

  it('rejects attribution changes within the same interval', async () => {
    const storage = memoryStorage();
    await setBillingContext(storage, input);

    await expect(
      setBillingContext(storage, { ...input, sku: 'cloud-agent-next:SandboxSmall' })
    ).rejects.toThrow('cannot change within an active interval');
  });
});
