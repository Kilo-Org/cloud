import { beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { getMonitoredModels, getPreferredModels, readPreferredModels } from './preferred-models';

const storedModels = [
  'kilo-auto/efficient',
  'provider/a:free',
  'kilo-auto/free',
  'provider/b:free',
  'anthropic/claude-opus-5.5',
];

beforeAll(async () => {
  await cleanupDbForTest();
  await db.insert(ai_gateway_config).values({ preferred_models: { models: storedModels } });
});

describe('getPreferredModels', () => {
  it('returns the stored list in order', async () => {
    expect(await getPreferredModels()).toEqual(storedModels);
  });
});

describe('getMonitoredModels', () => {
  it('returns the stored list without auto models', async () => {
    expect(await getMonitoredModels()).toEqual([
      'provider/a:free',
      'provider/b:free',
      'anthropic/claude-opus-5.5',
    ]);
  });

  it.each([
    ['only auto models are stored', { models: ['kilo-auto/efficient', 'kilo-auto/free'] }],
    ['no list is stored', null],
  ])('throws when %s', async (_case, preferredModels) => {
    await db
      .update(ai_gateway_config)
      .set({ preferred_models: preferredModels })
      .where(eq(ai_gateway_config.id, 1));
    await jest.isolateModulesAsync(async () => {
      const isolated = await import('./preferred-models');
      await expect(isolated.getMonitoredModels()).rejects.toThrow('No monitored models');
    });
  });
});

describe('readPreferredModels', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('returns an empty list when no config row exists', async () => {
    expect(await readPreferredModels()).toEqual([]);
  });

  it('returns an empty list when the column is not set', async () => {
    await db.insert(ai_gateway_config).values({ unavailable_models: { models: ['provider/a'] } });
    expect(await readPreferredModels()).toEqual([]);
  });

  it('reads only the preferred_models column', async () => {
    await db.insert(ai_gateway_config).values({
      preferred_models: { models: ['provider/b', 'provider/a'] },
      unavailable_models: { models: ['provider/c:free'] },
    });
    expect(await readPreferredModels()).toEqual(['provider/b', 'provider/a']);
  });

  it('throws on an invalid stored list', async () => {
    await db
      .insert(ai_gateway_config)
      .values({ preferred_models: { models: ['provider/a', 'provider/a'] } });
    await expect(readPreferredModels()).rejects.toThrow('Duplicate model');
  });
});
