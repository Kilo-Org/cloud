import { buildDirectProvider } from '@/lib/ai-gateway/experiments/build-direct-provider';
import type { Provider } from '@/lib/ai-gateway/providers/types';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';

export const LOCAL_FAKE_DETERMINISTIC_MODEL_ID = 'fake-deterministic';

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
  return {
    ...buildDirectProvider(
      'custom',
      ['chat_completions'],
      {
        base_url: `${baseUrl}/api/openrouter`,
        internal_id: LOCAL_FAKE_DETERMINISTIC_MODEL_ID,
        api_key: 'local-fake-llm',
      },
      null
    ),
    disableRequestTimeout: true,
  };
}
