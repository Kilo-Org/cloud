import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type * as DbModule from '@kilocode/db';
import {
  customRouterEntryKey,
  type CustomRouterDefinition,
  type CustomRouterEntry,
} from '@kilocode/auto-routing-contracts';
import {
  clearCustomRouterCache,
  findServingCustomRouter,
  hasGatewayAlias,
} from './custom-router-store';

const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  observedAtMs: 1_766_000_000_000 as number | null,
  aliasTargets: null as unknown,
  selections: [] as unknown[],
  reads: 0,
}));

vi.mock('@kilocode/db', async importOriginal => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    getWorkerDb: () => {
      state.reads++;
      return {
        select: (fields?: unknown) => {
          state.selections.push(fields);
          const freshness = fields !== undefined;
          const joined = () => ({
            where: () => ({
              limit: async () =>
                state.rows.map(item =>
                  freshness
                    ? {
                        router: item,
                        aliasTargets: state.aliasTargets,
                        observedAtMs: state.observedAtMs,
                      }
                    : item
                ),
            }),
          });
          return {
            from: () => ({ ...joined(), leftJoin: () => joined() }),
          };
        },
      };
    },
  };
});

const env = { HYPERDRIVE: { connectionString: 'postgres://worker' } } as unknown as Env;
const OWNER = { type: 'user' as const, id: 'user-1' };
const SONNET = 'anthropic/claude-sonnet-4.6';
const ALIAS = '~anthropic/latest';

function storedRow(entries: CustomRouterEntry[]) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    owned_by_organization_id: null,
    owned_by_user_id: OWNER.id,
    created_by_user_id: OWNER.id,
    slug: 'mine',
    name: 'Mine',
    base_router: 'efficient',
    mode: 'cost_per_accuracy',
    entries,
    default_entry_key: customRouterEntryKey(entries[0] ?? concreteEntry),
    legacy_pool: false,
    legacy_mode_inherited: false,
    created_at: '2026-11-20T00:00:00.000Z',
    updated_at: '2026-11-20T00:00:00.000Z',
  };
}

function definition(entries: CustomRouterEntry[]): CustomRouterDefinition {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    ownerType: 'user',
    ownerId: OWNER.id,
    slug: 'mine',
    name: 'Mine',
    baseRouter: 'efficient',
    mode: 'cost_per_accuracy',
    entries,
    defaultEntryKey: customRouterEntryKey(entries[0] ?? concreteEntry),
  };
}

const aliasEntry: CustomRouterEntry = { kind: 'gateway', model: ALIAS };
const concreteEntry: CustomRouterEntry = { kind: 'gateway', model: SONNET };
const pinnedAliasEntry: CustomRouterEntry = {
  kind: 'gateway',
  model: ALIAS,
  servingPin: { model: SONNET, pinnedAt: '2026-11-20T00:00:00.000Z' },
};
const clientEntry: CustomRouterEntry = {
  kind: 'client',
  provider: 'ollama',
  model: 'qwen3:32b',
  variants: [],
  capabilities: {
    contextLength: 32_000,
    inputModalities: ['text'],
    toolCall: true,
    reasoning: false,
  },
  pricing: null,
};

beforeEach(() => {
  clearCustomRouterCache();
  state.rows = [];
  state.aliasTargets = null;
  state.observedAtMs = 1_766_000_000_000;
  state.selections = [];
  state.reads = 0;
});

describe('custom router alias predicate', () => {
  it.each([
    ['a bare gateway alias', aliasEntry, true],
    ['a concrete gateway model', concreteEntry, false],
    ['an alias linked to a platform measurement', { ...aliasEntry, measuredAs: SONNET }, false],
    ['a client entry', clientEntry, false],
  ] as const)('classifies a pool holding %s', (_label, entry, expected) => {
    expect(hasGatewayAlias(definition([entry]))).toBe(expected);
  });

  it('treats a pool as alias-dependent when any entry is a bare alias', () => {
    expect(hasGatewayAlias(definition([concreteEntry, aliasEntry]))).toBe(true);
    expect(hasGatewayAlias(definition([clientEntry, concreteEntry]))).toBe(false);
  });
});

describe('serving definition read', () => {
  it('keeps the cached read for a pool with no alias entry', async () => {
    state.rows = [storedRow([concreteEntry])];
    const first = await findServingCustomRouter(env, OWNER, 'mine');
    const second = await findServingCustomRouter(env, OWNER, 'mine');
    expect(first?.router.slug).toBe('mine');
    expect(first?.aliasTargets.size).toBe(0);
    // The definition is the cached one; only the wrapper is rebuilt.
    expect(second?.router).toBe(first?.router);
    expect(state.reads).toBe(1);
  });

  it('re-reads a pool with an alias entry on the database clock', async () => {
    state.rows = [storedRow([aliasEntry])];
    expect((await findServingCustomRouter(env, OWNER, 'mine'))?.router.entries).toEqual([
      aliasEntry,
    ]);
    expect(state.reads).toBe(2);

    // The promotion landed in PostgreSQL after the cached read; the next request must serve it.
    state.rows = [storedRow([pinnedAliasEntry])];
    state.observedAtMs = 1_766_000_100_000;
    expect((await findServingCustomRouter(env, OWNER, 'mine'))?.router.entries).toEqual([
      pinnedAliasEntry,
    ]);
    expect(state.reads).toBe(3);
  });

  it('reads the stored alias targets in the same statement as the row', async () => {
    state.rows = [storedRow([aliasEntry])];
    state.aliasTargets = { aliases: [{ alias: ALIAS, target: SONNET }] };
    const serving = await findServingCustomRouter(env, OWNER, 'mine');
    expect(serving?.aliasTargets.get(ALIAS)).toBe(SONNET);
    const freshness = state.selections[state.selections.length - 1] as Record<string, unknown>;
    expect(Object.keys(freshness).sort()).toEqual(['aliasTargets', 'observedAtMs', 'router']);
  });

  it('ignores an unreadable stored alias target config', async () => {
    state.rows = [storedRow([aliasEntry])];
    state.aliasTargets = { aliases: [{ alias: 'not-an-alias', target: SONNET }] };
    expect(await findServingCustomRouter(env, OWNER, 'mine')).toMatchObject({
      aliasTargets: new Map(),
    });
  });

  it('reads the database clock in the same statement as the row', async () => {
    state.rows = [storedRow([aliasEntry])];
    await findServingCustomRouter(env, OWNER, 'mine');
    const freshness = state.selections[state.selections.length - 1] as { observedAtMs: SQL };
    expect(new PgDialect().sqlToQuery(freshness.observedAtMs).sql).toContain('clock_timestamp()');
  });

  it('treats a row the freshness read cannot find as a revoked pool', async () => {
    state.rows = [storedRow([aliasEntry])];
    expect(await findServingCustomRouter(env, OWNER, 'mine')).not.toBeNull();
    state.rows = [];
    // The cached definition must not be served: the pool row is gone.
    expect(await findServingCustomRouter(env, OWNER, 'mine')).toBeNull();
  });

  it('gives each concurrent request its own read instead of joining a pending one', async () => {
    state.rows = [storedRow([concreteEntry])];
    const [first, second] = await Promise.all([
      findServingCustomRouter(env, OWNER, 'mine'),
      findServingCustomRouter(env, OWNER, 'mine'),
    ]);
    expect(first?.router.slug).toBe('mine');
    expect(second?.router.slug).toBe('mine');
    // A pending read belongs to the request that started it, so two requests read twice and only
    // the resolved definitions are cached.
    expect(state.reads).toBe(2);
  });

  it('keeps a cached null without reading the database', async () => {
    expect(await findServingCustomRouter(env, OWNER, 'mine')).toBeNull();
    expect(await findServingCustomRouter(env, OWNER, 'mine')).toBeNull();
    expect(state.reads).toBe(1);
  });

  it('fails closed when the freshness read returns no database clock', async () => {
    state.rows = [storedRow([aliasEntry])];
    state.observedAtMs = null;
    await expect(findServingCustomRouter(env, OWNER, 'mine')).rejects.toThrow('no database clock');
  });
});
