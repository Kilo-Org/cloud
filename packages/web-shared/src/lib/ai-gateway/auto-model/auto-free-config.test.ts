import { beforeEach, describe, expect, it } from '@jest/globals';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { ai_gateway_config } from '@kilocode/db/schema';
import type { AutoFreeConfig } from '@kilocode/db/schema-types';
import { isAutoFreeEligibleModelId, readConfiguredAutoFreeModels } from './auto-free-config';

beforeEach(async () => {
  await cleanupDbForTest();
});

describe('readConfiguredAutoFreeModels', () => {
  it('returns null when no row exists', async () => {
    expect(await readConfiguredAutoFreeModels()).toBeNull();
  });

  it('returns null when no auto-free config is stored', async () => {
    await db.insert(ai_gateway_config).values({ config: {} });
    expect(await readConfiguredAutoFreeModels()).toBeNull();
  });

  it('returns null when the stored config is invalid', async () => {
    await db.insert(ai_gateway_config).values({
      auto_free: { models: [{ model: 'test/model:free' }] } as unknown as AutoFreeConfig,
    });
    expect(await readConfiguredAutoFreeModels()).toBeNull();
  });

  it('returns the stored models', async () => {
    const config: AutoFreeConfig = {
      models: [
        { model: 'test/model:free', weight: 2, reasoning: { enabled: true, effort: 'low' } },
      ],
    };
    await db.insert(ai_gateway_config).values({ auto_free: config });
    expect(await readConfiguredAutoFreeModels()).toEqual(config.models);
  });
});

describe('isAutoFreeEligibleModelId', () => {
  it.each([
    ['openrouter/free', true],
    ['poolside/laguna-s-2.1:free', true],
    ['stealth/space-bunny-alpha', true],
    ['provider/paid-model', false],
    ['kilo-auto/free', false],
    ['anthropic/claude-sonnet-4:free', false],
    ['openai/gpt-oss-120b:free', true],
    ['openai/gpt-5:free', false],
  ])('%s -> %s', (model, expected) => {
    expect(isAutoFreeEligibleModelId(model)).toBe(expected);
  });
});
