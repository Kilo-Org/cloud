import { beforeEach, describe, expect, it } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config } from '@kilocode/db/schema';
import type { AutoFreeConfig, CustomLlmDefinition } from '@kilocode/db/schema-types';
import type { CustomLlm } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import {
  customLlmDefinition,
  insertCustomLlmForTest,
  publicCustomLlmDefinition,
} from '@kilocode/web-shared/tests/helpers/custom-llm.helper';
import {
  getIneligibleAutoFreeModelIds,
  isAutoFreeEligibleModelId,
  readConfiguredAutoFreeModels,
} from './auto-free-config';

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
    expect(isAutoFreeEligibleModelId(model, undefined)).toBe(expected);
  });

  function customLlm(definition: CustomLlmDefinition): CustomLlm {
    return { public_id: 'acme/model', definition, encrypted_api_key: null };
  }

  it.each([
    ['a public custom LLM', publicCustomLlmDefinition(['acme']), true],
    [
      'a public custom LLM that lists Chat Completions',
      publicCustomLlmDefinition(['acme'], { api_kinds: ['messages', 'chat_completions'] }),
      true,
    ],
    [
      'a public custom LLM without Chat Completions',
      publicCustomLlmDefinition(['acme'], { api_kinds: ['messages'] }),
      false,
    ],
    [
      'a public custom LLM that speaks Responses by default',
      publicCustomLlmDefinition(['acme'], { opencode_settings: { ai_sdk_provider: 'openai' } }),
      false,
    ],
    ['a private custom LLM', customLlmDefinition(), false],
  ])('%s', (_name, definition, expected) => {
    expect(isAutoFreeEligibleModelId('acme/model', customLlm(definition))).toBe(expected);
  });
});

describe('getIneligibleAutoFreeModelIds', () => {
  it('accepts public custom LLMs and rejects private ones', async () => {
    await insertCustomLlmForTest('acme/public-free', publicCustomLlmDefinition(['acme']));
    await insertCustomLlmForTest('acme/private-free', customLlmDefinition());

    await expect(
      getIneligibleAutoFreeModelIds({
        models: ['acme/public-free', 'acme/private-free', 'provider/paid-model'].map(model => ({
          model,
          weight: 1,
          reasoning: {},
        })),
      })
    ).resolves.toEqual(['acme/private-free', 'provider/paid-model']);
  });
});
