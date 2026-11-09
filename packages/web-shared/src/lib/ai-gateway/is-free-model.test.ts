import { afterAll, afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import type { CustomPricingTiers } from '@kilocode/db/schema-types';
import {
  hasBestEffortGuessDataCollectionRequirement,
  isFreeModel,
} from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import { LOCAL_FAKE_TRANSCRIPTION_MODEL_IDS } from '@kilocode/web-shared/lib/ai-gateway/local-fake-llm';
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

/**
 * The enablement guard reads the environment on every call, so the cases stub the variables
 * instead of passing an override: a local fake is served only in development, outside Vercel,
 * with a parseable URL.
 */
function stubFakeLlmEnvironment(where: 'local' | 'local-without-url' | 'on-vercel') {
  const stubbed = { ...process.env };
  delete stubbed.VERCEL;
  delete stubbed.FAKE_LLM_URL;
  stubbed.NODE_ENV = 'development';
  if (where !== 'local-without-url') stubbed.FAKE_LLM_URL = 'http://127.0.0.1:11434/v1/';
  if (where === 'on-vercel') stubbed.VERCEL = '1';
  return jest.replaceProperty(process, 'env', stubbed);
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('isFreeModel', () => {
  test('judges custom LLM ids by the same rules as other ids', () => {
    expect(isFreeModel('acme/custom-model')).toBe(false);
    expect(isFreeModel('acme/custom-model-free')).toBe(true);
    expect(isFreeModel('stealth/custom-model')).toBe(true);
  });

  test.each([
    ['openrouter/free', true],
    ['acme/x:free', true],
    ['stealth/model-alpha', true],
    ['anthropic/claude-haiku-4.5', false],
  ])('judges %s -> %s without reading the environment', (model, expected) => {
    expect(isFreeModel(model)).toBe(expected);
  });

  test('charges nothing for the local fake models while the fake LLM is enabled', () => {
    stubFakeLlmEnvironment('local');

    expect(isFreeModel('fake-deterministic')).toBe(true);
    expect(isFreeModel('kilo/fake-deterministic')).toBe(true);
    for (const model of LOCAL_FAKE_TRANSCRIPTION_MODEL_IDS) {
      expect(isFreeModel(model)).toBe(true);
      expect(isFreeModel(`kilo/${model}`)).toBe(true);
    }
  });

  test('charges for the local fake ids once the fake LLM is not reachable', () => {
    stubFakeLlmEnvironment('local-without-url');

    expect(isFreeModel('fake-deterministic')).toBe(false);
    for (const model of LOCAL_FAKE_TRANSCRIPTION_MODEL_IDS) {
      expect(isFreeModel(model)).toBe(false);
    }
  });

  test('charges for the local fake ids on a deployment, where a fake is never served', () => {
    stubFakeLlmEnvironment('on-vercel');

    expect(isFreeModel('fake-deterministic')).toBe(false);
  });
});

describe('hasBestEffortGuessDataCollectionRequirement', () => {
  beforeAll(async () => {
    await insertCustomLlmForTest('acme/custom-model');
    await insertCustomLlmForTest('acme/priced-custom-model', customLlmDefinition({ pricing }));
    await insertCustomLlmForTest(
      'acme/no-training-model',
      customLlmDefinition({ pricing, may_train_on_prompts: false })
    );
    await insertCustomLlmForTest(
      'acme/training-model',
      customLlmDefinition({ pricing, may_train_on_prompts: true })
    );
  });

  afterAll(async () => {
    await deleteCustomLlmForTest('acme/custom-model');
    await deleteCustomLlmForTest('acme/priced-custom-model');
    await deleteCustomLlmForTest('acme/no-training-model');
    await deleteCustomLlmForTest('acme/training-model');
  });

  test.each([
    ['acme/custom-model', true],
    ['acme/priced-custom-model', true],
    ['acme/training-model', true],
    ['acme/no-training-model', false],
    ['openrouter/free', true],
    ['openai/gpt-4o', false],
    ['fake-deterministic', false],
  ])('%s -> %s', async (model, expected) => {
    stubFakeLlmEnvironment('local-without-url');

    await expect(hasBestEffortGuessDataCollectionRequirement(model)).resolves.toBe(expected);
  });

  test('judges the local fake model by whether the fake LLM is enabled', async () => {
    const enabled = stubFakeLlmEnvironment('local');
    await expect(hasBestEffortGuessDataCollectionRequirement('fake-deterministic')).resolves.toBe(
      true
    );
    enabled.restore();

    stubFakeLlmEnvironment('local-without-url');
    await expect(hasBestEffortGuessDataCollectionRequirement('fake-deterministic')).resolves.toBe(
      false
    );
  });
});
