import { afterEach, describe, expect, test } from '@jest/globals';
import { isFreeModel } from '@/lib/ai-gateway/is-free-model';
import {
  appendLocalFakeDeterministicCatalogModels,
  getLocalFakeDeterministicCatalogEntry,
  getLocalFakeLlmProvider,
  isLocalFakeDeterministicModel,
  isLocalFakeLlmEnabled,
  LOCAL_FAKE_DETERMINISTIC_MODEL_ID,
} from '@/lib/ai-gateway/local-fake-llm';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';

function replaceEnv(overrides: {
  NODE_ENV?: NodeJS.ProcessEnv['NODE_ENV'];
  FAKE_LLM_URL?: string;
  VERCEL?: string;
}) {
  const nextEnv = { ...process.env, ...overrides };
  if (!('VERCEL' in overrides)) {
    delete nextEnv.VERCEL;
  }
  if (!('FAKE_LLM_URL' in overrides)) {
    delete nextEnv.FAKE_LLM_URL;
  }
  return jest.replaceProperty(process, 'env', nextEnv as NodeJS.ProcessEnv);
}

describe('local fake deterministic model', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('matches the bare catalog id and the kilo session id', () => {
    expect(isLocalFakeDeterministicModel(LOCAL_FAKE_DETERMINISTIC_MODEL_ID)).toBe(true);
    expect(isLocalFakeDeterministicModel('kilo/fake-deterministic')).toBe(true);
    expect(isLocalFakeDeterministicModel('kilo-auto/efficient')).toBe(false);
  });

  test('is enabled only in local development with an absolute FAKE_LLM_URL', () => {
    const enabled = replaceEnv({ NODE_ENV: 'development', FAKE_LLM_URL: 'http://localhost:8811' });
    expect(isLocalFakeLlmEnabled()).toBe(true);
    enabled.restore();

    const missingUrl = replaceEnv({ NODE_ENV: 'development' });
    expect(isLocalFakeLlmEnabled()).toBe(false);
    missingUrl.restore();

    const vercel = replaceEnv({
      NODE_ENV: 'development',
      FAKE_LLM_URL: 'http://localhost:8811',
      VERCEL: '1',
    });
    expect(isLocalFakeLlmEnabled()).toBe(false);
    vercel.restore();

    const production = replaceEnv({
      NODE_ENV: 'production',
      FAKE_LLM_URL: 'http://localhost:8811',
    });
    expect(isLocalFakeLlmEnabled()).toBe(false);
    production.restore();

    const relativeUrl = replaceEnv({ NODE_ENV: 'development', FAKE_LLM_URL: 'localhost:8811' });
    expect(isLocalFakeLlmEnabled()).toBe(false);
    relativeUrl.restore();
  });

  test('returns a free catalog entry only when enabled', () => {
    expect(getLocalFakeDeterministicCatalogEntry()).toBeNull();
    expect(appendLocalFakeDeterministicCatalogModels([])).toEqual([]);

    const env = replaceEnv({ NODE_ENV: 'development', FAKE_LLM_URL: 'http://localhost:8811' });
    const entry = getLocalFakeDeterministicCatalogEntry();
    expect(entry).toMatchObject({
      id: LOCAL_FAKE_DETERMINISTIC_MODEL_ID,
      isFree: true,
      context_length: 200_000,
    });
    expect(entry?.supported_parameters).toContain('tools');
    expect(entry?.pricing).toMatchObject({ prompt: '0', completion: '0' });

    const existing: OpenRouterModel[] = [
      {
        id: 'anthropic/claude-sonnet-4.5',
        name: 'Claude',
        created: 0,
        description: '',
        architecture: {
          input_modalities: ['text'],
          output_modalities: ['text'],
          tokenizer: 'test',
        },
        top_provider: { is_moderated: false },
        pricing: { prompt: '1', completion: '1' },
        context_length: 1,
      },
    ];
    expect(appendLocalFakeDeterministicCatalogModels(existing)).toEqual([...existing, entry]);
    expect(appendLocalFakeDeterministicCatalogModels([entry!])).toEqual([entry]);
    env.restore();
  });

  test('builds a custom provider pointed at FAKE_LLM_URL', () => {
    expect(getLocalFakeLlmProvider()).toBeNull();

    const env = replaceEnv({ NODE_ENV: 'development', FAKE_LLM_URL: 'http://localhost:8811/' });
    const provider = getLocalFakeLlmProvider();
    expect(provider).toMatchObject({
      id: 'custom',
      apiUrl: 'http://localhost:8811/api/openrouter',
      apiKey: 'local-fake-llm',
      disableRequestTimeout: true,
    });
    env.restore();
  });

  test('isFreeModel is true only when the local fake LLM is enabled', async () => {
    expect(await isFreeModel(LOCAL_FAKE_DETERMINISTIC_MODEL_ID)).toBe(false);
    expect(await isFreeModel('kilo/fake-deterministic')).toBe(false);

    const env = replaceEnv({ NODE_ENV: 'development', FAKE_LLM_URL: 'http://localhost:8811' });
    expect(await isFreeModel(LOCAL_FAKE_DETERMINISTIC_MODEL_ID)).toBe(true);
    expect(await isFreeModel('kilo/fake-deterministic')).toBe(true);
    expect(await isFreeModel('anthropic/claude-sonnet-4')).toBe(false);
    env.restore();
  });
});
