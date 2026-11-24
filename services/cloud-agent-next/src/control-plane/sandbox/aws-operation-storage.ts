import {
  awsEcsOperationSchema,
  decodeAwsEcsProviderRef,
  encodeAwsEcsProviderRef,
  type AwsEcsOperation,
  type AwsEcsOperationStorage,
} from '../../sandbox-control/aws-ecs-operation.js';
import type { AgentSandboxProvider } from '../../shared/sandbox-provider.js';

const PREFIX = 'aws-ecs-operation:';

export function awsEcsOperationStorage(
  storage: Pick<DurableObjectStorage, 'get' | 'list' | 'delete' | 'transaction'>
): AwsEcsOperationStorage {
  return {
    get: id => storage.get(PREFIX + id),
    async update(id, transition) {
      return storage.transaction(async transaction => {
        const next = transition(await transaction.get(PREFIX + id));
        await transaction.put(PREFIX + id, next);
        return next;
      });
    },
    async list() {
      const entries = await storage.list({ prefix: PREFIX, limit: 33 });
      return new Map([...entries].map(([key, value]) => [key.slice(PREFIX.length), value]));
    },
    async delete(id) {
      await storage.delete(PREFIX + id);
    },
  };
}

/** Read only the recorded ECS operation. A foreign reference never selects another record. */
export async function readAwsEgressOperation(input: {
  provider: AgentSandboxProvider;
  providerRef: string | null;
  sandboxId: string;
  storage: Pick<DurableObjectStorage, 'get' | 'list' | 'delete' | 'transaction'>;
}): Promise<AwsEcsOperation | null> {
  if (input.provider !== 'aws-ecs') return null;
  const ref = decodeAwsEcsProviderRef(input.providerRef);
  if (!ref || ref.sandboxId !== input.sandboxId) return null;
  const value = awsEcsOperationSchema.safeParse(
    await awsEcsOperationStorage(input.storage).get(ref.intentId)
  ).data;
  return value && encodeAwsEcsProviderRef(value.ref) === input.providerRef ? value : null;
}
