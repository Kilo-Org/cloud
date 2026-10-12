import { beforeEach, describe, expect, it } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config } from '@kilocode/db/schema';
import type { GatewayModelListConfig } from '@kilocode/db/schema-types';
import { readGatewayModelList } from './gateway-model-lists';

beforeEach(async () => {
  await cleanupDbForTest();
});

describe('readGatewayModelList', () => {
  it('returns an empty list when no config row exists', async () => {
    expect(await readGatewayModelList('preferred_models')).toEqual([]);
  });

  it('returns an empty list when the column is not set', async () => {
    await db.insert(ai_gateway_config).values({ unavailable_models: { models: ['provider/a'] } });
    expect(await readGatewayModelList('preferred_models')).toEqual([]);
  });

  it('reads each list from its own column', async () => {
    await db.insert(ai_gateway_config).values({
      preferred_models: { models: ['provider/b', 'provider/a'] },
      unavailable_models: { models: ['provider/c:free'] },
    });
    expect(await readGatewayModelList('preferred_models')).toEqual(['provider/b', 'provider/a']);
    expect(await readGatewayModelList('unavailable_models')).toEqual(['provider/c:free']);
  });

  it('throws on an invalid stored list', async () => {
    await db.insert(ai_gateway_config).values({
      preferred_models: { models: ['provider/a', 'provider/a'] } satisfies GatewayModelListConfig,
    });
    await expect(readGatewayModelList('preferred_models')).rejects.toThrow('Duplicate model');
  });
});
