import { beforeEach, describe, expect, it } from '@jest/globals';
import { ai_gateway_config } from '@kilocode/db/schema';
import type { LatestAliasTarget } from '@kilocode/db/schema-types';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import type {
  GatewayModelMap,
  GatewayModelWithEndpoints,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';
import {
  LATEST_ALIAS_TARGET_MIN_AGE_MS,
  applyLatestAliasTargets,
  describeLatestAliasTarget,
  latestAliasTargetsConfig,
  readLatestAliasTargets,
  updateLatestAliasTargets,
} from '@kilocode/web-shared/lib/ai-gateway/providers/latest-alias-targets';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const ALIAS = '~vendor/model-latest';

function model(id: string, aliasTarget?: string): GatewayModelWithEndpoints {
  return {
    id,
    name: id,
    endpoints: [{ provider_name: 'test' }],
    ...(aliasTarget && { alias_target: { slug: aliasTarget } }),
  };
}

function models(aliasTarget: string, ...ids: string[]): GatewayModelMap {
  return Object.fromEntries(
    [model(ALIAS, aliasTarget), ...ids.map(id => model(id))].map(entry => [entry.id, entry])
  );
}

function stored(...entries: LatestAliasTarget[]) {
  return new Map(entries.map(entry => [entry.alias, entry]));
}

describe('updateLatestAliasTargets', () => {
  it('takes the live target at once for an alias without a stored target', () => {
    expect(
      updateLatestAliasTargets({
        previous: new Map(),
        models: models('vendor/new', 'vendor/new'),
        createdAtMs: new Map([['vendor/new', NOW]]),
        nowMs: NOW,
      })
    ).toEqual([{ alias: ALIAS, target: 'vendor/new' }]);
  });

  it('keeps the stored target until the new target is 24 hours old', () => {
    expect(
      updateLatestAliasTargets({
        previous: stored({ alias: ALIAS, target: 'vendor/old' }),
        models: models('vendor/new', 'vendor/old', 'vendor/new'),
        createdAtMs: new Map([['vendor/new', NOW - 2 * HOUR]]),
        nowMs: NOW,
      })
    ).toEqual([
      {
        alias: ALIAS,
        target: 'vendor/old',
        pending: {
          target: 'vendor/new',
          effective_at: new Date(NOW - 2 * HOUR + LATEST_ALIAS_TARGET_MIN_AGE_MS).toISOString(),
        },
      },
    ]);
  });

  it('switches once the new target is 24 hours old', () => {
    expect(
      updateLatestAliasTargets({
        previous: stored({ alias: ALIAS, target: 'vendor/old' }),
        models: models('vendor/new', 'vendor/old', 'vendor/new'),
        createdAtMs: new Map([['vendor/new', NOW - LATEST_ALIAS_TARGET_MIN_AGE_MS]]),
        nowMs: NOW,
      })
    ).toEqual([{ alias: ALIAS, target: 'vendor/new' }]);
  });

  it('counts from when the switch was first seen when the creation time is unknown', () => {
    const first = updateLatestAliasTargets({
      previous: stored({ alias: ALIAS, target: 'vendor/old' }),
      models: models('vendor/new', 'vendor/old', 'vendor/new'),
      createdAtMs: new Map(),
      nowMs: NOW,
    });
    expect(first[0]?.pending?.effective_at).toBe(
      new Date(NOW + LATEST_ALIAS_TARGET_MIN_AGE_MS).toISOString()
    );

    const later = updateLatestAliasTargets({
      previous: stored(...first),
      models: models('vendor/new', 'vendor/old', 'vendor/new'),
      createdAtMs: new Map(),
      nowMs: NOW + 23 * HOUR,
    });
    expect(later).toEqual(first);

    expect(
      updateLatestAliasTargets({
        previous: stored(...later),
        models: models('vendor/new', 'vendor/old', 'vendor/new'),
        createdAtMs: new Map(),
        nowMs: NOW + LATEST_ALIAS_TARGET_MIN_AGE_MS,
      })
    ).toEqual([{ alias: ALIAS, target: 'vendor/new' }]);
  });

  it('drops a pending switch when the live target returns to the stored target', () => {
    expect(
      updateLatestAliasTargets({
        previous: stored({
          alias: ALIAS,
          target: 'vendor/old',
          pending: { target: 'vendor/new', effective_at: new Date(NOW + HOUR).toISOString() },
        }),
        models: models('vendor/old', 'vendor/old', 'vendor/new'),
        createdAtMs: new Map(),
        nowMs: NOW,
      })
    ).toEqual([{ alias: ALIAS, target: 'vendor/old' }]);
  });

  it('switches at once when the stored target left the catalog', () => {
    expect(
      updateLatestAliasTargets({
        previous: stored({ alias: ALIAS, target: 'vendor/gone' }),
        models: models('vendor/new', 'vendor/new'),
        createdAtMs: new Map([['vendor/new', NOW]]),
        nowMs: NOW,
      })
    ).toEqual([{ alias: ALIAS, target: 'vendor/new' }]);
  });

  it('keeps the stored entry while the live target is not in the catalog', () => {
    const entry = { alias: ALIAS, target: 'vendor/old' };
    expect(
      updateLatestAliasTargets({
        previous: stored(entry),
        models: models('vendor/unlisted', 'vendor/old'),
        createdAtMs: new Map(),
        nowMs: NOW,
      })
    ).toEqual([entry]);
  });

  it('drops aliases that left the catalog and ignores non-alias ids', () => {
    expect(
      updateLatestAliasTargets({
        previous: stored({ alias: '~vendor/gone-latest', target: 'vendor/old' }),
        models: { 'vendor/a': model('vendor/a', 'vendor/b'), 'vendor/b': model('vendor/b') },
        createdAtMs: new Map(),
        nowMs: NOW,
      })
    ).toEqual([]);
  });
});

describe('applyLatestAliasTargets', () => {
  it('points an alias at its stored target', () => {
    const live = models('vendor/new', 'vendor/old', 'vendor/new');
    const result = applyLatestAliasTargets(
      live,
      stored({ alias: ALIAS, target: 'vendor/old' }),
      NOW
    );
    expect(result[ALIAS]?.alias_target?.slug).toBe('vendor/old');
    expect(live[ALIAS]?.alias_target?.slug).toBe('vendor/new');
  });

  it('uses a pending target once it takes effect', () => {
    const result = applyLatestAliasTargets(
      models('vendor/new', 'vendor/old', 'vendor/new'),
      stored({
        alias: ALIAS,
        target: 'vendor/old',
        pending: { target: 'vendor/new', effective_at: new Date(NOW - 1).toISOString() },
      }),
      NOW
    );
    expect(result[ALIAS]?.alias_target?.slug).toBe('vendor/new');
  });

  it('falls back to the live target when the stored target is not in the catalog', () => {
    const result = applyLatestAliasTargets(
      models('vendor/new', 'vendor/new'),
      stored({ alias: ALIAS, target: 'vendor/gone' }),
      NOW
    );
    expect(result[ALIAS]?.alias_target?.slug).toBe('vendor/new');
  });
});

describe('describeLatestAliasTarget', () => {
  const namesById = new Map([
    ['vendor/old', 'Old Model'],
    ['vendor/new', 'New Model'],
  ]);

  it('names the current target', () => {
    expect(
      describeLatestAliasTarget({ target: 'vendor/old', stored: undefined, namesById, nowMs: NOW })
    ).toBe('This alias currently points to Old Model (`vendor/old`).');
  });

  it('names the pending target and roughly when the alias switches', () => {
    expect(
      describeLatestAliasTarget({
        target: 'vendor/old',
        stored: {
          alias: ALIAS,
          target: 'vendor/old',
          pending: { target: 'vendor/new', effective_at: new Date(NOW + 5.4 * HOUR).toISOString() },
        },
        namesById,
        nowMs: NOW,
      })
    ).toBe(
      'This alias currently points to Old Model (`vendor/old`). It will switch to New Model (`vendor/new`) in approximately 5 hours.'
    );
  });

  it('says one hour when the switch is less than an hour away', () => {
    expect(
      describeLatestAliasTarget({
        target: 'vendor/old',
        stored: {
          alias: ALIAS,
          target: 'vendor/old',
          pending: { target: 'unnamed/model', effective_at: new Date(NOW + 60_000).toISOString() },
        },
        namesById,
        nowMs: NOW,
      })
    ).toBe(
      'This alias currently points to Old Model (`vendor/old`). It will switch to `unnamed/model` in approximately 1 hour.'
    );
  });
});

describe('readLatestAliasTargets', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('reads nothing when no targets are stored', async () => {
    await expect(readLatestAliasTargets(db)).resolves.toEqual(new Map());
  });

  it('reads the stored targets by alias', async () => {
    const entry = { alias: ALIAS, target: 'vendor/old' };
    await db
      .insert(ai_gateway_config)
      .values({ latest_alias_targets: latestAliasTargetsConfig([entry]) });
    await expect(readLatestAliasTargets(db)).resolves.toEqual(new Map([[ALIAS, entry]]));
  });
});
