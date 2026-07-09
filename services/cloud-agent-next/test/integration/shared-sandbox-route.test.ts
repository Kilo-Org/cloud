import { describe, expect, it, vi } from 'vitest';

import {
  resolveSharedSandboxAssignment,
  recordSharedSandboxFailover,
  SHARED_SANDBOX_FAILOVER_SUFFIX,
  type SharedSandboxOverrideStore,
} from '../../src/shared-sandbox-route.js';

const routeKey = 'usr-000000000000000000000000000000000000000000000000' as const;
const failoverSandboxId = 'usr-b4593afcaf2e9e1dfb1611150b786cfe8aeba3c77352a3df' as const;

function createStore(initialValue: string | null = null): SharedSandboxOverrideStore & {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
} {
  let value = initialValue;
  return {
    get: vi.fn(async () => value),
    put: vi.fn(async (_key: string, nextValue: string) => {
      value = nextValue;
    }),
  };
}

describe('shared sandbox failover routing', () => {
  it('uses the base sandbox when no failover suffix is stored', async () => {
    const store = createStore();

    await expect(resolveSharedSandboxAssignment(store, routeKey)).resolves.toEqual({
      sandboxId: routeKey,
    });
  });

  it('derives the alternate sandbox from the stored suffix', async () => {
    const store = createStore(SHARED_SANDBOX_FAILOVER_SUFFIX);

    await expect(resolveSharedSandboxAssignment(store, routeKey)).resolves.toEqual({
      sandboxId: failoverSandboxId,
      suffix: SHARED_SANDBOX_FAILOVER_SUFFIX,
    });
  });

  it('records one-way failover as a derivation suffix', async () => {
    const store = createStore();

    await recordSharedSandboxFailover(store, routeKey);

    expect(store.put).toHaveBeenCalledWith(
      `shared-sandbox-route:${routeKey}`,
      SHARED_SANDBOX_FAILOVER_SUFFIX
    );
    await expect(resolveSharedSandboxAssignment(store, routeKey)).resolves.toEqual({
      sandboxId: failoverSandboxId,
      suffix: SHARED_SANDBOX_FAILOVER_SUFFIX,
    });
  });

  it('does not rewrite an existing failover assignment', async () => {
    const store = createStore(SHARED_SANDBOX_FAILOVER_SUFFIX);

    await recordSharedSandboxFailover(store, routeKey);

    expect(store.put).not.toHaveBeenCalled();
  });

  it('rejects an unknown suffix instead of routing back to the base sandbox', async () => {
    const store = createStore('unknown-slot');

    await expect(resolveSharedSandboxAssignment(store, routeKey)).rejects.toThrow(
      'Invalid shared sandbox override'
    );
  });

  it('fails closed when the override cannot be read', async () => {
    const store = createStore();
    store.get.mockRejectedValueOnce(new Error('KV unavailable'));

    await expect(resolveSharedSandboxAssignment(store, routeKey)).rejects.toThrow('KV unavailable');
  });
});
