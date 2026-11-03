import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import type { CustomPricingTiers } from '@kilocode/db/schema-types';
import {
  hasBestEffortGuessDataCollectionRequirement,
  isFreeModel,
} from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import {
  customLlmDefinition,
  deleteCustomLlmForTest,
  insertCustomLlmForTest,
} from '@kilocode/web-shared/tests/helpers/custom-llm.helper';

const pricing: CustomPricingTiers = [
  {
    start_context_length: 0,
    pricing: {
      prompt_per_million: 2,
      completion_per_million: 8,
      input_cache_read_per_million: null,
      input_cache_write_per_million: null,
    },
  },
];

describe('isFreeModel', () => {
  beforeAll(async () => {
    await insertCustomLlmForTest('acme/custom-model');
    await insertCustomLlmForTest('acme/priced-custom-model', customLlmDefinition({ pricing }));
    await insertCustomLlmForTest('stealth/priced-model-free', customLlmDefinition({ pricing }));
  });

  afterAll(async () => {
    await deleteCustomLlmForTest('acme/custom-model');
    await deleteCustomLlmForTest('acme/priced-custom-model');
    await deleteCustomLlmForTest('stealth/priced-model-free');
  });

  test('treats a custom LLM without pricing as free', async () => {
    await expect(isFreeModel('acme/custom-model')).resolves.toBe(true);
  });

  test('treats a custom LLM with pricing as not free', async () => {
    await expect(isFreeModel('acme/priced-custom-model')).resolves.toBe(false);
  });

  test('uses custom LLM pricing even when the id looks free', async () => {
    await expect(isFreeModel('stealth/priced-model-free')).resolves.toBe(false);
  });

  test('assumes custom LLMs require data collection, like other free models', async () => {
    await expect(hasBestEffortGuessDataCollectionRequirement('acme/custom-model')).resolves.toBe(
      true
    );
    await expect(hasBestEffortGuessDataCollectionRequirement('openai/gpt-4o')).resolves.toBe(false);
  });

  test('assumes priced custom LLMs require data collection too', async () => {
    await expect(
      hasBestEffortGuessDataCollectionRequirement('acme/priced-custom-model')
    ).resolves.toBe(true);
  });

  test('follows the built-in rules for other models', async () => {
    await expect(isFreeModel('openrouter/free')).resolves.toBe(true);
    await expect(isFreeModel('openai/gpt-4o')).resolves.toBe(false);
  });
});
