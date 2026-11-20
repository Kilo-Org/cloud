import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

type Affinity = {
  ipAddress: string | undefined;
  userId?: string;
  hash?: number;
};

const affinity = new AsyncLocalStorage<Affinity>();

export function runWithReplicaAffinity<T>(ipAddress: string | undefined, callback: () => T): T {
  return affinity.run({ ipAddress }, callback);
}

export function setVerifiedReplicaUser(userId: string): void {
  const request = affinity.getStore();
  if (request && request.userId === undefined) {
    request.userId = userId;
    request.hash = undefined;
  }
}

export function replicaAffinityHash(): number | undefined {
  const request = affinity.getStore();
  if (!request) return undefined;
  const key = request.userId
    ? `user:${request.userId}`
    : request.ipAddress && `ip:${request.ipAddress}`;
  if (!key) return undefined;
  return (request.hash ??= createHash('sha256').update(key).digest().readUInt32BE(0));
}

const concreteClients = new WeakMap<object, () => object>();

export function createReadReplicaFacade<T extends object>(fallback: T, select: () => T): T {
  const facade = new Proxy(fallback, {
    get(_target, property) {
      const client = select();
      const value: unknown = Reflect.get(client, property, client);
      // Return real query builders and transactions, not another proxy or an async wrapper.
      if (typeof value !== 'function' || property === 'constructor') return value;
      return (...args: unknown[]): unknown => Reflect.apply(value, client, args);
    },
  });
  concreteClients.set(facade, select);
  return facade;
}

export function readReplicaCacheKey(client: object): object {
  return concreteClients.get(client)?.() ?? client;
}
