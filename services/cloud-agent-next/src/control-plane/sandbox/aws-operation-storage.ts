import type { AwsOperationStorage } from '../../sandbox-control/aws-operation.js';

const prefix = 'aws-operation:';

export function awsOperationStorage(
  storage: Pick<DurableObjectStorage, 'get' | 'list' | 'delete' | 'transaction'>
): AwsOperationStorage {
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
