import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import {
  findCustomLlm,
  getPublicCustomLlmInferenceProviders,
  isFreeModelIncludingCustomLlms,
} from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { stepfun_37_flash_free_model } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import {
  deleteCustomLlmForTest,
  insertCustomLlmForTest,
  privateCustomLlmDefinition,
  publicCustomLlmDefinition,
} from '@kilocode/web-shared/tests/helpers/custom-llm.helper';

const freeExclusiveId = stepfun_37_flash_free_model.public_id;

describe('custom LLM catalog', () => {
  beforeAll(async () => {
    await insertCustomLlmForTest('Acme/Public-Model', publicCustomLlmDefinition(['acme']));
    await insertCustomLlmForTest(freeExclusiveId, privateCustomLlmDefinition());
  });

  afterAll(async () => {
    await deleteCustomLlmForTest('Acme/Public-Model');
    await deleteCustomLlmForTest(freeExclusiveId);
  });

  test('finds custom LLMs case-insensitively', async () => {
    await expect(findCustomLlm('acme/public-model')).resolves.toMatchObject({
      public_id: 'Acme/Public-Model',
    });
    await expect(findCustomLlm('acme/unknown')).resolves.toBeNull();
  });

  test('treats public custom LLMs as free and lets custom LLMs override built-in free models', async () => {
    await expect(isFreeModelIncludingCustomLlms('acme/public-model')).resolves.toBe(true);
    await expect(isFreeModelIncludingCustomLlms(freeExclusiveId)).resolves.toBe(false);
    await expect(isFreeModelIncludingCustomLlms('openrouter/free')).resolves.toBe(true);
    await expect(isFreeModelIncludingCustomLlms('openai/gpt-4o')).resolves.toBe(false);
  });

  test('returns inference providers only for public custom LLMs', async () => {
    await expect(getPublicCustomLlmInferenceProviders('acme/public-model')).resolves.toEqual(
      new Set(['acme'])
    );
    await expect(getPublicCustomLlmInferenceProviders(freeExclusiveId)).resolves.toBeNull();
    await expect(getPublicCustomLlmInferenceProviders('openai/gpt-4o')).resolves.toBeNull();
  });
});
