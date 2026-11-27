import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  findCustomRouter,
  findServingCustomRouter,
  hasGatewayAlias,
} from './custom-router-store';

const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  observedAtMs: 1_766_000_000_000 as number | null,
  aliasTargets: null as unknown,
  selections: [] as unknown[],
  reads: 0,
  /** Held until resolved so a test can decide which read finishes first. */
  holdRead: null as Promise<void> | null,
  /** Thrown by the next read that is not held. */
  failRead: null as Error | null,
}));

vi.mock('@kilocode/db', async importOriginal => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    getWorkerDb: () => {
      state.reads++;
      // Captured at the read's start: a later change of `rows` is what a newer read would see.
      const rows = state.rows;
      const hold = state.holdRead;
      const fail = state.failRead;
      state.holdRead = null;
      state.failRead = null;
      return {
        select: (fields?: unknown) => {
          state.selections.push(fields);
          const freshness = fields !== undefined;
          const joined = () => ({
            where: () => ({
              limit: async () => {
                if (hold) await hold;
                if (fail) throw fail;
                return rows.map(item =>
                  freshness
                    ? {
                        router: item,
                        aliasTargets: state.aliasTargets,
                        observedAtMs: state.observedAtMs,
                      }
                    : item
                );
              },
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
  state.holdRead = null;
  state.failRead = null;
});

afterEach(() => {
  vi.restoreAllMocks();
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

  it('gives each concurrent request its own read and caches the one that succeeded', async () => {
    const firstRead = Promise.withResolvers<void>();
    state.holdRead = firstRead.promise;
    state.failRead = new Error('This promise was created by a request that has since ended.');
    state.rows = [storedRow([concreteEntry])];

    const cancelled = findCustomRouter(env, OWNER, 'mine');
    const served = await findCustomRouter(env, OWNER, 'mine');
    expect(served?.slug).toBe('mine');

    firstRead.resolve();
    await expect(cancelled).rejects.toThrow('has since ended');

    // The definition the second request read is the cached one, not the failed read.
    await expect(findCustomRouter(env, OWNER, 'mine')).resolves.toBe(served);
    expect(state.reads).toBe(2);
  });

  it('does not let a read that started earlier replace a newer cached read', async () => {
    const held = Promise.withResolvers<void>();
    const newerEntry: CustomRouterEntry = { kind: 'gateway', model: 'openai/gpt-5.2' };
    state.holdRead = held.promise;
    state.rows = [storedRow([concreteEntry])];
    const slow = findCustomRouter(env, OWNER, 'mine');

    state.rows = [storedRow([newerEntry])];
    const newer = await findCustomRouter(env, OWNER, 'mine');
    expect(newer?.entries).toEqual([newerEntry]);

    held.resolve();
    await slow;
    // The later read's answer stands even though the earlier read finished last.
    expect((await findCustomRouter(env, OWNER, 'mine'))?.entries).toEqual([newerEntry]);
    expect(state.reads).toBe(2);
  });

  it('expires the cached read from when it started, not from when it finished', async () => {
    let clock = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const held = Promise.withResolvers<void>();
    state.holdRead = held.promise;
    state.rows = [storedRow([concreteEntry])];
    const slow = findCustomRouter(env, OWNER, 'mine');

    // The read finishes 29 s after it started, so a finish-based TTL would keep it for 59 s.
    clock += 29_000;
    held.resolve();
    await slow;
    clock += 2_000;
    await findCustomRouter(env, OWNER, 'mine');
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
