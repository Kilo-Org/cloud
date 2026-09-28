import { buildDirectProvider } from '@/lib/ai-gateway/providers/build-direct-provider';
import { OPENROUTER } from '@/lib/ai-gateway/providers/definitions/openrouter';
import type { Provider } from '@/lib/ai-gateway/providers/types';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';

export const LOCAL_FAKE_DETERMINISTIC_MODEL_ID = 'fake-deterministic';

/**
 * Speech-to-text catalog ids served by the local fake LLM
 * (`services/cloud-agent-next/test/e2e/fake-llm-server.ts`). Keep in sync with
 * its `TRANSCRIPTION_MODELS`.
 */
export const LOCAL_FAKE_TRANSCRIPTION_MODEL_IDS = ['fake-transcribe', 'fake-transcribe-broken'];

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

export function isLocalFakeDeterministicModel(id: string | undefined | null): boolean {
  if (!id) return false;
  return (
    id === LOCAL_FAKE_DETERMINISTIC_MODEL_ID || id === `kilo/${LOCAL_FAKE_DETERMINISTIC_MODEL_ID}`
  );
}

export function isLocalFakeTranscriptionModel(id: string | undefined | null): boolean {
  if (!id) return false;
  return LOCAL_FAKE_TRANSCRIPTION_MODEL_IDS.some(model => id === model || id === `kilo/${model}`);
}

export function isLocalFakeLlmEnabled(): boolean {
  if (process.env.NODE_ENV !== 'development') return false;
  if (process.env.VERCEL) return false;
  return parseAbsoluteHttpUrl(process.env.FAKE_LLM_URL) !== null;
}

export function getLocalFakeDeterministicCatalogEntry(): OpenRouterModel | null {
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
  models: OpenRouterModel[]
): OpenRouterModel[] {
  const entry = getLocalFakeDeterministicCatalogEntry();
  if (!entry || models.some(model => model.id === entry.id)) {
    return models;
  }
  return [...models, entry];
}

export function getLocalFakeLlmProvider(): Provider | null {
  const url = parseAbsoluteHttpUrl(process.env.FAKE_LLM_URL);
  if (!isLocalFakeLlmEnabled() || !url) return null;
  const baseUrl = url.href.replace(/\/$/, '');
  return buildDirectProvider(
    'custom',
    ['chat_completions'],
    {
      base_url: `${baseUrl}/api/openrouter`,
      internal_id: LOCAL_FAKE_DETERMINISTIC_MODEL_ID,
      api_key: LOCAL_FAKE_LLM_API_KEY,
    },
    null
  );
}

/**
 * OpenRouter-shaped provider that points speech-to-text traffic at the local
 * fake LLM, for e2e runs without a real OpenRouter key.
 */
export function getLocalFakeTranscriptionProvider(): Provider | null {
  const url = parseAbsoluteHttpUrl(process.env.FAKE_LLM_URL);
  if (!isLocalFakeLlmEnabled() || !url) return null;
  return {
    ...OPENROUTER,
    apiUrl: `${url.href.replace(/\/$/, '')}/api/openrouter`,
    apiKey: LOCAL_FAKE_LLM_API_KEY,
  };
}

/** Full transcription-models catalog URL on the local fake LLM, or null. */
export function getLocalFakeTranscriptionModelsUrl(): string | null {
  const url = parseAbsoluteHttpUrl(process.env.FAKE_LLM_URL);
  if (!isLocalFakeLlmEnabled() || !url) return null;
  return `${url.href.replace(/\/$/, '')}/api/openrouter/models?output_modalities=transcription`;
}
