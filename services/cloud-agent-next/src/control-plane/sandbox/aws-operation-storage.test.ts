import { describe, expect, it } from 'vitest';
import { ECS_TEST_CONFIG } from '../../../test/fixtures/aws-ecs.js';
import { encodeAwsEcsProviderRef } from '../../sandbox-control/aws-ecs-operation.js';
import { readAwsEgressOperation } from './aws-operation-storage.js';

const identity = { sandboxId: 'ses-abcdef', intentId: 'attempt-1', createdAt: 0 };
const ecs = {
  ref: { ...identity, provider: 'aws-ecs' as const },
  config: ECS_TEST_CONFIG,
  phase: 'created' as const,
};
function fixture() {
  const values = new Map<string, unknown>([['aws-ecs-operation:attempt-1', ecs]]);
  const reads: string[] = [];
  const storage = {
    get: async (key: string) => {
      reads.push(key);
      return values.get(key);
    },
  } as DurableObjectStorage;
  return { values, reads, storage };
}
describe('AWS persisted engine authority', () => {
  it('reads the ECS record for the allocation intent', async () => {
    const f = fixture();
    expect(
      await readAwsEgressOperation({
        provider: 'aws-ecs',
        providerRef: encodeAwsEcsProviderRef(ecs.ref),
        sandboxId: identity.sandboxId,
        storage: f.storage,
      })
    ).toEqual(ecs);
    expect(f.reads).toEqual(['aws-ecs-operation:attempt-1']);
  });
  it('never uses a non-ECS provider or a foreign owner reference to select storage', async () => {
    const f = fixture();
    for (const input of [
      { provider: 'vercel' as const, providerRef: encodeAwsEcsProviderRef(ecs.ref) },
      { provider: 'aws-ecs' as const, providerRef: 'invalid-ref' },
      {
        provider: 'aws-ecs' as const,
        providerRef: encodeAwsEcsProviderRef({ ...ecs.ref, sandboxId: 'foreign' }),
      },
    ])
      expect(
        await readAwsEgressOperation({
          ...input,
          sandboxId: identity.sandboxId,
          storage: f.storage,
        })
      ).toBeNull();
    expect(f.reads).toEqual([]);
  });
  it('fails closed when the ECS namespace contains another engine or reference', async () => {
    const f = fixture();
    f.values.set('aws-ecs-operation:attempt-1', {
      ...ecs,
      ref: { ...identity, provider: 'vercel' },
    });
    expect(
      await readAwsEgressOperation({
        provider: 'aws-ecs',
        providerRef: encodeAwsEcsProviderRef(ecs.ref),
        sandboxId: identity.sandboxId,
        storage: f.storage,
      })
    ).toBeNull();
    f.values.set('aws-ecs-operation:attempt-1', { ...ecs, ref: { ...ecs.ref, createdAt: 1 } });
    expect(
      await readAwsEgressOperation({
        provider: 'aws-ecs',
        providerRef: encodeAwsEcsProviderRef(ecs.ref),
        sandboxId: identity.sandboxId,
        storage: f.storage,
      })
    ).toBeNull();
  });
});
