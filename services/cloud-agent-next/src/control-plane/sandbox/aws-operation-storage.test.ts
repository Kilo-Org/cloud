import { describe, expect, it } from 'vitest';
import { ECS_TEST_CONFIG } from '../../../test/fixtures/aws-ecs.js';
import { AWS_TEST_CONFIGURATION } from '../../../test/fixtures/aws-provider.js';
import { encodeAwsProviderRef } from '../../sandbox-control/aws-operation.js';
import { encodeAwsEcsProviderRef } from '../../sandbox-control/aws-ecs-operation.js';
import { readAwsEgressOperation } from './aws-operation-storage.js';

const identity = { sandboxId: 'ses-abcdef', intentId: 'attempt-1', createdAt: 0 };
const microvm = {
  ref: { ...identity, provider: 'aws' as const },
  config: AWS_TEST_CONFIGURATION,
  phase: 'created' as const,
};
const ecs = {
  ref: { ...identity, provider: 'aws-ecs' as const },
  config: ECS_TEST_CONFIG,
  phase: 'created' as const,
};
function fixture() {
  const values = new Map<string, unknown>([
    ['aws-operation:attempt-1', microvm],
    ['aws-ecs-operation:attempt-1', ecs],
  ]);
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
  it('reads separate records for the same allocation intent', async () => {
    const f = fixture();
    expect(
      await readAwsEgressOperation({
        provider: 'aws',
        providerRef: encodeAwsProviderRef(microvm.ref),
        sandboxId: identity.sandboxId,
        storage: f.storage,
      })
    ).toEqual(microvm);
    expect(
      await readAwsEgressOperation({
        provider: 'aws-ecs',
        providerRef: encodeAwsEcsProviderRef(ecs.ref),
        sandboxId: identity.sandboxId,
        storage: f.storage,
      })
    ).toEqual(ecs);
    expect(f.reads).toEqual(['aws-operation:attempt-1', 'aws-ecs-operation:attempt-1']);
  });
  it('never uses a foreign engine or owner reference to select storage', async () => {
    const f = fixture();
    expect(
      await readAwsEgressOperation({
        provider: 'aws-ecs',
        providerRef: encodeAwsProviderRef(microvm.ref),
        sandboxId: identity.sandboxId,
        storage: f.storage,
      })
    ).toBeNull();
    expect(
      await readAwsEgressOperation({
        provider: 'aws',
        providerRef: encodeAwsProviderRef({ ...microvm.ref, sandboxId: 'foreign' }),
        sandboxId: identity.sandboxId,
        storage: f.storage,
      })
    ).toBeNull();
    expect(f.reads).toEqual([]);
  });
  it('fails closed when the selected namespace contains another engine or reference', async () => {
    const f = fixture();
    f.values.set('aws-ecs-operation:attempt-1', microvm);
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
