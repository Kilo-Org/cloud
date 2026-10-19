import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import {
  isFreeModel,
  isFreeModelExcludingCustomLlms,
} from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import {
  deleteCustomLlmForTest,
  insertCustomLlmForTest,
} from '@kilocode/web-shared/tests/helpers/custom-llm.helper';

describe('isFreeModel', () => {
  beforeAll(async () => {
    await insertCustomLlmForTest('acme/custom-model');
  });

  afterAll(async () => {
    await deleteCustomLlmForTest('acme/custom-model');
  });

  test('treats every custom LLM as free', async () => {
    await expect(isFreeModel('acme/custom-model')).resolves.toBe(true);
    expect(isFreeModelExcludingCustomLlms('acme/custom-model')).toBe(false);
  });

  test('follows the built-in rules for other models', async () => {
    await expect(isFreeModel('openrouter/free')).resolves.toBe(true);
    await expect(isFreeModel('openai/gpt-4o')).resolves.toBe(false);
  });
});
