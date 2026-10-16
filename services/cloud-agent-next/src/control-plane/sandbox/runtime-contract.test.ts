import { describe, expect, it } from 'vitest';
import {
  acceptRuntimeContract,
  readRuntimeContract,
  resetRuntimeContract,
  RUNTIME_CONTRACT_KEY,
} from './runtime-contract.js';

function storage(values = new Map<string, unknown>()) {
  return {
    values,
    get: (key: string) => values.get(key),
    put: (key: string, value: unknown) => {
      values.set(key, value);
    },
    delete: (key: string) => values.delete(key),
  };
}

describe('allocation runtime contract', () => {
  it.each([undefined, { allocationId: 'previous', mode: 'worktree' }])(
    'keeps an existing allocation compatible when its record is missing or stale: %j',
    record => {
      const store = storage();
      if (record !== undefined) store.put(RUNTIME_CONTRACT_KEY, record);
      expect(acceptRuntimeContract(store, 'existing', 'worktree')).toBe(true);
      expect(readRuntimeContract(store, 'existing')).toBe('legacy');
    }
  );

  it('does not change runtime identity when a stored contract is malformed', () => {
    const store = storage();
    store.put(RUNTIME_CONTRACT_KEY, { allocationId: 'existing', mode: 'invalid' });
    expect(() => acceptRuntimeContract(store, 'existing', 'worktree')).toThrow();
  });

  it('pins a fresh allocation to its first wrapper across storage reloads', () => {
    const store = storage();
    resetRuntimeContract(store, 'first');
    expect(acceptRuntimeContract(store, 'first', undefined)).toBe(true);
    const reloaded = storage(structuredClone(store.values));
    expect(acceptRuntimeContract(reloaded, 'first', 'worktree')).toBe(true);
    expect(readRuntimeContract(reloaded, 'first')).toBe('legacy');
  });

  it('enables sharing only on a new allocation and rejects a capability downgrade', () => {
    const store = storage();
    resetRuntimeContract(store, 'first');
    acceptRuntimeContract(store, 'first', undefined);
    resetRuntimeContract(store, null);
    expect(store.values.size).toBe(0);
    resetRuntimeContract(store, 'second');
    expect(readRuntimeContract(store, 'second')).toBe('pending');
    expect(acceptRuntimeContract(store, 'second', 'worktree')).toBe(true);
    const reloaded = storage(structuredClone(store.values));
    expect(acceptRuntimeContract(reloaded, 'second', undefined)).toBe(false);
    expect(readRuntimeContract(reloaded, 'second')).toBe('worktree');
    expect(acceptRuntimeContract(reloaded, 'second', 'worktree')).toBe(true);
  });
});
