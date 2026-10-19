import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  customRouterEntryKey,
  type AutoRoutingMode,
  type CustomRouterDefinition,
} from '@kilocode/auto-routing-contracts';
import type * as CustomRouterStoreModule from './custom-router-store';
import type * as RoutingModeModule from './routing-mode';
import { getSharedOwnerSettings, resolveLegacyPoolRouting } from './legacy-pool-overlap';

const findLegacyPoolRouter = vi.hoisted(() => vi.fn());
const getConfiguredAutoRoutingSettings = vi.hoisted(() => vi.fn());
const getConfiguredAutoRoutingMode = vi.hoisted(() => vi.fn());

vi.mock('./custom-router-store', async importOriginal => ({
  ...(await importOriginal<typeof CustomRouterStoreModule>()),
  findLegacyPoolRouter,
}));
vi.mock('./routing-mode', async importOriginal => ({
  ...(await importOriginal<typeof RoutingModeModule>()),
  getCachedAutoRoutingSettings: getConfiguredAutoRoutingSettings,
  getConfiguredAutoRoutingSettings,
  getConfiguredAutoRoutingMode,
}));

const env = {
  HYPERDRIVE: { connectionString: 'postgres://worker' },
} as Pick<Env, 'HYPERDRIVE' | 'AUTO_ROUTING_MODE_CONFIG'>;
const caller = { userId: 'user-1', organizationId: 'org-1' };

function router(overrides: Partial<CustomRouterDefinition> = {}): CustomRouterDefinition {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    ownerType: 'user',
    ownerId: caller.userId,
    slug: 'efficient',
    name: 'Efficient',
    baseRouter: 'efficient',
    mode: 'cost_per_accuracy',
    entries: [{ kind: 'gateway', model: 'pool/current' }],
    defaultEntryKey: customRouterEntryKey({ kind: 'gateway', model: 'pool/current' }),
    legacyPool: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findLegacyPoolRouter.mockResolvedValue(null);
  getConfiguredAutoRoutingSettings.mockResolvedValue({ mode: null, pool: null });
  getConfiguredAutoRoutingMode.mockResolvedValue(null);
});

describe('legacy pool overlap', () => {
  it('reads the canonical pool and the DO mode without consulting the old pool snapshot', async () => {
    const canonical = router({ mode: 'best_accuracy' });
    findLegacyPoolRouter.mockResolvedValue(canonical);
    await expect(
      getSharedOwnerSettings(env, { ownerType: 'user', ownerId: caller.userId })
    ).resolves.toEqual({
      mode: null,
      pool: [{ model: 'pool/current' }],
      router: canonical,
    });
    expect(getConfiguredAutoRoutingMode).toHaveBeenCalledWith(env, {
      ownerType: 'user',
      ownerId: caller.userId,
    });
    expect(getConfiguredAutoRoutingSettings).not.toHaveBeenCalled();
    expect(canonical.mode).toBe('best_accuracy');
  });

  it('applies the organization DO mode to the platform alias without mutating custom mode', async () => {
    const canonical = router();
    findLegacyPoolRouter.mockImplementation(async (_env, owner) =>
      owner.type === 'user' ? canonical : null
    );
    getConfiguredAutoRoutingSettings.mockResolvedValue({ mode: 'best_accuracy', pool: null });
    await expect(resolveLegacyPoolRouting(env, caller)).resolves.toMatchObject({
      mode: 'best_accuracy',
      router: { id: canonical.id, mode: 'best_accuracy', entries: canonical.entries },
    });
    expect(canonical.mode).toBe('cost_per_accuracy');
  });

  it('keeps an unmigrated org pool ahead of a migrated personal pool', async () => {
    findLegacyPoolRouter.mockImplementation(async (_env, owner) =>
      owner.type === 'user' ? router() : null
    );
    getConfiguredAutoRoutingSettings.mockResolvedValue({
      mode: null,
      pool: [{ model: 'org/old' }],
    });
    await expect(resolveLegacyPoolRouting(env, caller)).resolves.toMatchObject({
      router: null,
      pool: [{ model: 'org/old' }],
      mode: 'cost_per_accuracy',
    });
  });

  it.each([
    { personal: 'best_accuracy', org: null, expected: 'best_accuracy' },
    { personal: 'best_accuracy', org: 'cost_per_accuracy', expected: 'cost_per_accuracy' },
    { personal: 'cost_per_accuracy', org: 'best_accuracy', expected: 'best_accuracy' },
    { personal: null, org: null, expected: 'cost_per_accuracy' },
  ] satisfies {
    personal: AutoRoutingMode | null;
    org: AutoRoutingMode | null;
    expected: AutoRoutingMode;
  }[])('uses DO mode precedence even when both owners have migrated pools: %j', async modes => {
    const personal = router({ mode: 'cost_per_accuracy', legacyModeInherited: false });
    const org = router({
      ownerType: 'org',
      ownerId: caller.organizationId,
      mode: 'best_accuracy',
      legacyModeInherited: true,
    });
    findLegacyPoolRouter.mockImplementation(async (_env, owner) =>
      owner.type === 'org' ? org : personal
    );
    getConfiguredAutoRoutingMode.mockImplementation(async (_env, owner) =>
      owner.ownerType === 'org' ? modes.org : modes.personal
    );
    await expect(resolveLegacyPoolRouting(env, caller)).resolves.toMatchObject({
      mode: modes.expected,
      router: { ...org, mode: modes.expected },
    });
    expect(personal.mode).toBe('cost_per_accuracy');
    expect(org.mode).toBe('best_accuracy');
    expect(getConfiguredAutoRoutingSettings).not.toHaveBeenCalled();
  });

  it('falls back to DO pool settings for nonmigrated owners', async () => {
    getConfiguredAutoRoutingSettings.mockResolvedValue({ mode: 'best_accuracy', pool: null });
    await expect(
      getSharedOwnerSettings(env, { ownerType: 'user', ownerId: caller.userId })
    ).resolves.toEqual({ mode: 'best_accuracy', pool: null, router: null });
    await expect(resolveLegacyPoolRouting(env, caller)).resolves.toBeUndefined();
  });

  it('fails closed on canonical storage failures instead of reading old pool settings', async () => {
    findLegacyPoolRouter.mockRejectedValue(new Error('database unavailable'));
    await expect(resolveLegacyPoolRouting(env, caller)).rejects.toThrow('database unavailable');
    expect(getConfiguredAutoRoutingSettings).not.toHaveBeenCalled();
  });
});
