import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  customRouterEntryKey,
  type CustomRouterDefinition,
} from '@kilocode/auto-routing-contracts';
import type * as DbModule from '@kilocode/db';
import type * as CustomRouterStoreModule from './custom-router-store';
import type * as RoutingModeModule from './routing-mode';
import {
  getSharedOwnerSettings,
  inheritedLegacyPoolMode,
  resolveLegacyPoolRouting,
  updateSharedPoolRouter,
} from './legacy-pool-overlap';

const findLegacyPoolRouter = vi.hoisted(() => vi.fn());
const getConfiguredAutoRoutingSettings = vi.hoisted(() => vi.fn());
const clearCustomRouterCache = vi.hoisted(() => vi.fn());
const dbSet = vi.hoisted(() => vi.fn());
const dbReturning = vi.hoisted(() => vi.fn());
const dbRead = vi.hoisted(() => vi.fn());

vi.mock('./custom-router-store', async importOriginal => ({
  ...(await importOriginal<typeof CustomRouterStoreModule>()),
  findLegacyPoolRouter,
  clearCustomRouterCache,
}));
vi.mock('./routing-mode', async importOriginal => ({
  ...(await importOriginal<typeof RoutingModeModule>()),
  getCachedAutoRoutingSettings: getConfiguredAutoRoutingSettings,
  getConfiguredAutoRoutingSettings,
}));
vi.mock('@kilocode/db', async importOriginal => {
  const tx = {
    execute: async () => {},
    select: () => ({ from: () => ({ where: () => ({ limit: dbRead }) }) }),
    update: () => ({ set: dbSet }),
  };
  return {
    ...(await importOriginal<typeof DbModule>()),
    getWorkerDb: () => ({
      transaction: async (work: (transaction: typeof tx) => Promise<unknown>) => work(tx),
    }),
  };
});

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

function storedRow(definition: CustomRouterDefinition) {
  return {
    id: definition.id,
    owned_by_user_id: definition.ownerType === 'user' ? definition.ownerId : null,
    owned_by_organization_id: definition.ownerType === 'org' ? definition.ownerId : null,
    slug: definition.slug,
    name: definition.name,
    base_router: definition.baseRouter,
    mode: definition.mode,
    entries: definition.entries,
    default_entry_key: definition.defaultEntryKey,
    legacy_pool: true,
    legacy_mode_inherited: definition.legacyModeInherited ?? false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findLegacyPoolRouter.mockResolvedValue(null);
  getConfiguredAutoRoutingSettings.mockResolvedValue({ mode: null, pool: null });
  dbRead.mockResolvedValue([storedRow(router())]);
  dbSet.mockImplementation(values => {
    dbReturning.mockResolvedValue([{ ...storedRow(router()), ...values }]);
    return { where: () => ({ returning: dbReturning }) };
  });
});

describe('shared legacy pool overlap', () => {
  it('uses the canonical row without reading its old DO snapshot or relying on a conversion marker', async () => {
    const canonical = router();
    findLegacyPoolRouter.mockResolvedValue(canonical);
    await expect(
      getSharedOwnerSettings(env, { ownerType: 'user', ownerId: caller.userId })
    ).resolves.toMatchObject({
      mode: canonical.mode,
      pool: [{ model: 'pool/current' }],
      router: canonical,
    });
    expect(getConfiguredAutoRoutingSettings).not.toHaveBeenCalled();
  });

  it('preserves independent organization mode precedence over a migrated personal pool', async () => {
    const canonical = router();
    findLegacyPoolRouter.mockImplementation(async (_env, owner) =>
      owner.type === 'user' ? canonical : null
    );
    getConfiguredAutoRoutingSettings.mockResolvedValue({ mode: 'best_accuracy', pool: null });
    await expect(resolveLegacyPoolRouting(env, caller)).resolves.toMatchObject({
      mode: 'best_accuracy',
      router: { id: canonical.id, mode: 'best_accuracy', entries: canonical.entries },
    });
    await expect(inheritedLegacyPoolMode(env, canonical, caller)).resolves.toMatchObject({
      id: canonical.id,
      mode: 'best_accuracy',
      entries: canonical.entries,
    });
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

  it('uses the migrated org pool before personal settings and leaves an explicit personal ID personal', async () => {
    const personal = router();
    const org = router({ ownerType: 'org', ownerId: caller.organizationId, mode: 'best_accuracy' });
    findLegacyPoolRouter.mockImplementation(async (_env, owner) =>
      owner.type === 'org' ? org : personal
    );
    await expect(resolveLegacyPoolRouting(env, caller)).resolves.toMatchObject({ router: org });
    await expect(inheritedLegacyPoolMode(env, personal, caller)).resolves.toMatchObject({
      ownerType: 'user',
      ownerId: personal.ownerId,
      mode: 'best_accuracy',
    });
  });

  it.each([true, false])(
    'preserves null versus explicit default org mode (inherited=%s)',
    async inherited => {
      const personal = router({ mode: 'best_accuracy' });
      const org = router({
        ownerType: 'org',
        ownerId: caller.organizationId,
        legacyModeInherited: inherited,
      });
      findLegacyPoolRouter.mockImplementation(async (_env, owner) =>
        owner.type === 'org' ? org : personal
      );
      const expected = inherited ? 'best_accuracy' : 'cost_per_accuracy';
      expect((await resolveLegacyPoolRouting(env, caller))?.mode).toBe(expected);
      expect((await inheritedLegacyPoolMode(env, org, caller)).mode).toBe(expected);
    }
  );

  it.each([true, false])(
    'preserves null versus explicit default personal mode (inherited=%s)',
    async inherited => {
      const personal = router({ legacyModeInherited: inherited });
      findLegacyPoolRouter.mockImplementation(async (_env, owner) =>
        owner.type === 'user' ? personal : null
      );
      const settings = await getSharedOwnerSettings(env, {
        ownerType: 'user',
        ownerId: caller.userId,
      });
      expect(settings.mode).toBe(inherited ? null : 'cost_per_accuracy');
      expect(
        (await inheritedLegacyPoolMode(env, personal, { ...caller, organizationId: null })).mode
      ).toBe('cost_per_accuracy');
    }
  );

  it('fails closed on canonical storage failures instead of reading DO settings', async () => {
    findLegacyPoolRouter.mockRejectedValue(new Error('database unavailable'));
    await expect(resolveLegacyPoolRouting(env, caller)).rejects.toThrow('database unavailable');
    expect(getConfiguredAutoRoutingSettings).not.toHaveBeenCalled();
  });

  it('writes old gateway pool edits into the canonical row and preserves a surviving default', async () => {
    const current = router();
    const updated = await updateSharedPoolRouter(env, current, {
      mode: 'best_accuracy',
      settings: { mode: 'best_accuracy', pool: [{ model: 'pool/new' }, { model: 'pool/current' }] },
    });
    expect(updated.defaultEntryKey).toBe(current.defaultEntryKey);
    expect(dbSet).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'best_accuracy',
        entries: [
          { kind: 'gateway', model: 'pool/new' },
          { kind: 'gateway', model: 'pool/current' },
        ],
        default_entry_key: current.defaultEntryKey,
      })
    );
    expect(clearCustomRouterCache).toHaveBeenCalledOnce();
  });

  it('moves a removed default to the first new entry and rejects clearing the migrated pool', async () => {
    const updated = await updateSharedPoolRouter(env, router(), {
      mode: null,
      settings: { mode: null, pool: [{ model: 'pool/new' }] },
    });
    expect(updated.defaultEntryKey).toBe(
      customRouterEntryKey({ kind: 'gateway', model: 'pool/new' })
    );
    expect(updated.legacyModeInherited).toBe(true);
    await expect(
      updateSharedPoolRouter(env, router(), {
        mode: null,
        settings: { mode: null, pool: null },
      })
    ).rejects.toThrow('cannot be cleared');
  });

  it('does not let an old editor silently discard client entries', async () => {
    const current = router({
      entries: [
        { kind: 'gateway', model: 'pool/current' },
        {
          kind: 'client',
          provider: 'ollama',
          model: 'local-model',
          variants: [],
          capabilities: {
            contextLength: null,
            inputModalities: ['text'],
            toolCall: false,
            reasoning: false,
          },
          pricing: null,
        },
      ],
    });
    dbRead.mockResolvedValue([storedRow(current)]);
    await expect(
      updateSharedPoolRouter(env, current, {
        mode: 'best_accuracy',
        settings: { mode: 'best_accuracy', pool: [{ model: 'pool/new' }] },
      })
    ).rejects.toThrow('contains client entries');
    expect(dbSet).not.toHaveBeenCalled();
  });

  it('persists mode-only edits without changing canonical entries or default', async () => {
    const updated = await updateSharedPoolRouter(env, router(), { mode: 'best_accuracy' });
    expect(updated.entries).toEqual(router().entries);
    expect(updated.defaultEntryKey).toBe(router().defaultEntryKey);
    expect(updated.legacyModeInherited).toBe(false);
    expect(dbSet).toHaveBeenCalledWith({ mode: 'best_accuracy', legacy_mode_inherited: false });
  });
});
