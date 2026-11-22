import {
  LOCAL_FAKE_DETERMINISTIC_MODEL_ID,
  LOCAL_FAKE_TRANSCRIPTION_MODEL_IDS,
} from '@kilocode/app-shared/local-fake-llm';
import { buildDirectProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/build-direct-provider';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import type { OpenRouterCatalogModel } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/catalog-schemas';

export const LOCAL_FAKE_LLM_API_KEY = 'local-fake-llm';

function parseAbsoluteHttpUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * The single enablement guard and URL normalization for every local fake LLM
 * endpoint: development only, never on Vercel, and only for a parseable
 * http/https `FAKE_LLM_URL`, with one trailing slash removed so callers append
 * their own path.
 */
function getLocalFakeBaseUrl(): string | null {
  if (process.env.NODE_ENV !== 'development') return null;
  if (process.env.VERCEL) return null;
  const url = parseAbsoluteHttpUrl(process.env.FAKE_LLM_URL);
  return url ? url.href.replace(/\/$/, '') : null;
}

/** The fake LLM serves the OpenRouter API surface under `/api/openrouter`. */
function localFakeOpenRouterBaseUrl(baseUrl: string): string {
  return `${baseUrl}/api/openrouter`;
}

/** The bare catalog id and its `kilo/`-prefixed session id both name the same local fake. */
function matchesLocalFakeModelId(id: string | undefined | null, modelId: string): boolean {
  if (!id) return false;
  return id === modelId || id === `kilo/${modelId}`;
}

export function isLocalFakeDeterministicModel(id: string | undefined | null): boolean {
  return matchesLocalFakeModelId(id, LOCAL_FAKE_DETERMINISTIC_MODEL_ID);
}

export function isLocalFakeTranscriptionModel(id: string | undefined | null): boolean {
  return LOCAL_FAKE_TRANSCRIPTION_MODEL_IDS.some(model => matchesLocalFakeModelId(id, model));
}

export function isLocalFakeLlmEnabled(): boolean {
  return getLocalFakeBaseUrl() !== null;
}

export function getLocalFakeDeterministicCatalogEntry(): OpenRouterCatalogModel | null {
  if (!isLocalFakeLlmEnabled()) return null;
  return {
    id: LOCAL_FAKE_DETERMINISTIC_MODEL_ID,
    name: 'Fake Deterministic',
    created: 0,
    description: 'Deterministic fake model for local Cloud Agent development.',
    architecture: {
      input_modalities: ['text'],
      output_modalities: ['text'],
      tokenizer: 'fake',
    },
    top_provider: {
      is_moderated: false,
      context_length: 200_000,
      max_completion_tokens: 8192,
    },
    pricing: {
      prompt: '0',
      completion: '0',
      request: '0',
      image: '0',
      web_search: '0',
      internal_reasoning: '0',
    },
    context_length: 200_000,
    supported_parameters: ['tools', 'temperature'],
    isFree: true,
  };
}

export function appendLocalFakeDeterministicCatalogModels(
  models: OpenRouterCatalogModel[]
): OpenRouterCatalogModel[] {
  const entry = getLocalFakeDeterministicCatalogEntry();
  if (!entry || models.some(model => model.id === entry.id)) {
    return models;
  }
  return [...models, entry];
}

export function getLocalFakeLlmProvider(): Provider | null {
  const baseUrl = getLocalFakeBaseUrl();
  if (!baseUrl) return null;
  return buildDirectProvider(
    'custom',
    ['chat_completions'],
    {
      base_url: localFakeOpenRouterBaseUrl(baseUrl),
      internal_id: LOCAL_FAKE_DETERMINISTIC_MODEL_ID,
    },
    { type: 'api_key', apiKey: LOCAL_FAKE_LLM_API_KEY, apiKeyHeader: null }
  );
}

/**
 * OpenRouter-shaped provider that points speech-to-text traffic at the local
 * fake LLM, for e2e runs without a real OpenRouter key.
 */
export function getLocalFakeTranscriptionProvider(): Provider | null {
  const baseUrl = getLocalFakeBaseUrl();
  if (!baseUrl) return null;
  return {
    ...OPENROUTER,
    apiUrl: localFakeOpenRouterBaseUrl(baseUrl),
    apiKey: LOCAL_FAKE_LLM_API_KEY,
  };
}

/** Full transcription-models catalog URL on the local fake LLM, or null. */
export function getLocalFakeTranscriptionModelsUrl(): string | null {
  const baseUrl = getLocalFakeBaseUrl();
  if (!baseUrl) return null;
  return `${localFakeOpenRouterBaseUrl(baseUrl)}/models?output_modalities=transcription`;
}
