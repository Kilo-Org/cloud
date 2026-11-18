import { beforeEach, describe, expect, test } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config } from '@kilocode/db/schema';
import type { PreferredProviderOrderConfig } from '@kilocode/db/schema-types';
import { readPreferredProviderOrderConfig } from '@kilocode/web-shared/lib/ai-gateway/providers/preferred-provider-order-config';

describe('readPreferredProviderOrderConfig', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  test('returns no rules when no config row exists', async () => {
    expect(await readPreferredProviderOrderConfig()).toEqual({ rules: [] });
  });

  test('returns no rules when the column is null', async () => {
    await db.insert(ai_gateway_config).values({ preferred_models: { models: ['provider/a'] } });
    expect(await readPreferredProviderOrderConfig()).toEqual({ rules: [] });
  });

  test('reads the stored config', async () => {
    const config: PreferredProviderOrderConfig = {
      rules: [
        { includes: ['claude'], providers: ['google-vertex', 'amazon-bedrock'] },
        { includes: ['gpt'], excludes: ['gpt-oss'], providers: ['openai'] },
      ],
    };
    await db.insert(ai_gateway_config).values({ preferred_provider_order: config });
    expect(await readPreferredProviderOrderConfig()).toEqual(config);
  });

  test('throws on an invalid stored config', async () => {
    await db.insert(ai_gateway_config).values({
      preferred_provider_order: { rules: [{ includes: ['Claude'], providers: ['openai'] }] },
    });
    await expect(readPreferredProviderOrderConfig()).rejects.toThrow();
  });
});
