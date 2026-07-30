import { describe, expect, it } from 'vitest';
import type { KiloGatewayModelOption } from './kilo-api-client';
import type { ExtensionModelPickerRow } from './model-picker-rows';
import { buildExtensionModelPickerRows } from './model-picker-rows';

const model = (
  id: string,
  {
    isPreferred = false,
    name = id,
  }: {
    readonly isPreferred?: boolean;
    readonly name?: string;
  } = {}
): KiloGatewayModelOption => ({
  id,
  isPreferred,
  name,
  variants: [],
});

const modelIds = (rows: ExtensionModelPickerRow[]): string[] =>
  rows.flatMap(row => (row.type === 'model' ? [row.model.id] : []));

const headerTitles = (rows: ExtensionModelPickerRow[]): string[] =>
  rows.flatMap(row => (row.type === 'header' ? [row.title] : []));

const modelRows = (rows: ExtensionModelPickerRow[]) =>
  rows.flatMap(row => (row.type === 'model' ? [row] : []));

describe('extension model picker rows', () => {
  it('orders sections favorites → recommended → all models and preserves catalog order', () => {
    const models = [
      model('preferred-a', { isPreferred: true, name: 'Preferred A' }),
      model('all-a', { name: 'All A' }),
      model('fav-a', { name: 'Favorite A' }),
      model('preferred-b', { isPreferred: true, name: 'Preferred B' }),
      model('all-b', { name: 'All B' }),
      model('fav-b', { name: 'Favorite B' }),
    ];

    const rows = buildExtensionModelPickerRows({
      favoriteIds: new Set(['fav-a', 'fav-b']),
      models,
      search: '',
    });

    expect(headerTitles(rows)).toStrictEqual(['FAVORITES', 'RECOMMENDED', 'ALL MODELS']);
    expect(modelIds(rows)).toStrictEqual([
      'fav-a',
      'fav-b',
      'preferred-a',
      'preferred-b',
      'all-a',
      'all-b',
    ]);
  });

  it('keeps a preferred favorite only under favorites with no duplicate model keys', () => {
    const models = [
      model('both', { isPreferred: true, name: 'Both' }),
      model('only-preferred', { isPreferred: true, name: 'Only Preferred' }),
      model('only-all', { name: 'Only All' }),
    ];

    const rows = buildExtensionModelPickerRows({
      favoriteIds: new Set(['both']),
      models,
      search: '',
    });

    const keys = rows.map(row => row.key);
    const bothRow = modelRows(rows).find(row => row.model.id === 'both');

    expect(headerTitles(rows)).toStrictEqual(['FAVORITES', 'RECOMMENDED', 'ALL MODELS']);
    expect(modelIds(rows)).toStrictEqual(['both', 'only-preferred', 'only-all']);
    expect({ keysUnique: new Set(keys).size === keys.length, rowCount: rows.length }).toStrictEqual(
      {
        keysUnique: true,
        rowCount: 6,
      }
    );
    expect(bothRow).toMatchObject({ isFavorite: true, type: 'model' });
  });

  it('filters by name and id case-insensitively before partitioning', () => {
    const models = [
      model('anthropic/claude', { isPreferred: true, name: 'Claude Sonnet' }),
      model('openai/gpt', { name: 'GPT Four' }),
      model('fav-id', { name: 'Other Name' }),
    ];
    const favoriteIds = new Set(['fav-id']);

    const byName = buildExtensionModelPickerRows({
      favoriteIds,
      models,
      search: '  claude  ',
    });
    expect(headerTitles(byName)).toStrictEqual(['RECOMMENDED']);
    expect(modelIds(byName)).toStrictEqual(['anthropic/claude']);

    const byId = buildExtensionModelPickerRows({ favoriteIds, models, search: 'OPENAI/' });
    expect(headerTitles(byId)).toStrictEqual(['ALL MODELS']);
    expect(modelIds(byId)).toStrictEqual(['openai/gpt']);

    const favoriteMiss = buildExtensionModelPickerRows({
      favoriteIds,
      models,
      search: 'claude',
    });
    expect(headerTitles(favoriteMiss)).not.toContain('FAVORITES');
  });

  it('omits the favorites header when empty and returns no rows when nothing matches', () => {
    const models = [
      model('preferred-a', { isPreferred: true, name: 'Preferred A' }),
      model('all-a', { name: 'All A' }),
    ];

    const noFavorites = buildExtensionModelPickerRows({
      favoriteIds: new Set(),
      models,
      search: '',
    });
    expect(headerTitles(noFavorites)).toStrictEqual(['RECOMMENDED', 'ALL MODELS']);
    expect(headerTitles(noFavorites)).not.toContain('FAVORITES');

    const noMatches = buildExtensionModelPickerRows({
      favoriteIds: new Set(['preferred-a']),
      models,
      search: 'zzzz',
    });
    expect(noMatches).toStrictEqual([]);
  });

  it('marks isFavorite true only on rows under FAVORITES', () => {
    const models = [
      model('fav', { isPreferred: true, name: 'Favorite Preferred' }),
      model('rec', { isPreferred: true, name: 'Recommended' }),
      model('all', { name: 'All' }),
    ];

    const favoriteFlags = Object.fromEntries(
      modelRows(
        buildExtensionModelPickerRows({
          favoriteIds: new Set(['fav']),
          models,
          search: '',
        })
      ).map(row => [row.model.id, row.isFavorite])
    );

    expect(favoriteFlags).toStrictEqual({ all: false, fav: true, rec: false });
  });
});
