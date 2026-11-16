import {
  awsOperationSchema,
  decodeAwsProviderRef,
  encodeAwsProviderRef,
} from '../../sandbox-control/aws-operation.js';
import {
  awsEcsOperationSchema,
  decodeAwsEcsProviderRef,
  encodeAwsEcsProviderRef,
} from '../../sandbox-control/aws-ecs-operation.js';
import type { AgentSandboxProvider } from '../../shared/sandbox-provider.js';
import type { AwsEgressOperation } from '../../egress/aws-admission.js';
import type { AwsOperationStorage } from '../../sandbox-control/aws-operation.js';

import type { AwsEcsOperationStorage } from '../../sandbox-control/aws-ecs-operation.js';
import type { AwsComputeStorage } from '../../sandbox-control/aws-compute-lifecycle.js';

export function awsOperationStorage(
  storage: Pick<DurableObjectStorage, 'get' | 'list' | 'delete' | 'transaction'>
): AwsOperationStorage {
  return computeStorage(storage, 'aws-operation:');
}
export function awsEcsOperationStorage(
  storage: Pick<DurableObjectStorage, 'get' | 'list' | 'delete' | 'transaction'>
): AwsEcsOperationStorage {
  return computeStorage(storage, 'aws-ecs-operation:');
}
function computeStorage<Record>(
  storage: Pick<DurableObjectStorage, 'get' | 'list' | 'delete' | 'transaction'>,
  prefix: 'aws-operation:' | 'aws-ecs-operation:'
): AwsComputeStorage<Record> {
  return {
    get: id => storage.get(prefix + id),
    async update(id, transition) {
      return storage.transaction(async transaction => {
        const next = transition(await transaction.get(prefix + id));
        await transaction.put(prefix + id, next);
        return next;
      });
    },
    async list() {
      const entries = await storage.list({ prefix, limit: 33 });
      return new Map([...entries].map(([key, value]) => [key.slice(prefix.length), value]));
    },
    async delete(id) {
      await storage.delete(prefix + id);
    },
  };
}

/** Read only the recorded engine's namespace. Foreign references never select another provider. */
export async function readAwsEgressOperation(input: {
  provider: AgentSandboxProvider;
  providerRef: string | null;
  sandboxId: string;
  storage: Pick<DurableObjectStorage, 'get' | 'list' | 'delete' | 'transaction'>;
}): Promise<AwsEgressOperation | null> {
  if (input.provider === 'aws') {
    const ref = decodeAwsProviderRef(input.providerRef);
    if (!ref || ref.sandboxId !== input.sandboxId) return null;
    const value = awsOperationSchema.safeParse(
      await awsOperationStorage(input.storage).get(ref.intentId)
    ).data;
    return value && encodeAwsProviderRef(value.ref) === input.providerRef ? value : null;
  }
  if (input.provider === 'aws-ecs') {
    const ref = decodeAwsEcsProviderRef(input.providerRef);
    if (!ref || ref.sandboxId !== input.sandboxId) return null;
    const value = awsEcsOperationSchema.safeParse(
      await awsEcsOperationStorage(input.storage).get(ref.intentId)
    ).data;
    return value && encodeAwsEcsProviderRef(value.ref) === input.providerRef ? value : null;
  }
  return null;
}
