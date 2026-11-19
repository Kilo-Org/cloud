/**
 * Mock data for OpenRouter models API tests
 */

import { OPENROUTER_CATALOGUE_MINIMUM_COUNTS } from '../../lib/ai-gateway/providers/openrouter';

/**
 * Creates a mock Response object for testing
 */
export function createMockResponse({
  ok = true,
  status = 200,
  statusText = 'OK',
  jsonData = {},
}: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  jsonData?: unknown;
} = {}): Response {
  return {
    ok,
    status,
    statusText,
    json: () => Promise.resolve(jsonData),
    headers: new Headers(),
    body: null,
    bodyUsed: false,
    redirected: false,
    type: 'default',
    url: '',
    clone: () => ({}) as Response,
    // These methods must return Promises as per the Response interface
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob()),
    formData: () => Promise.resolve(new FormData()),
    text: () => Promise.resolve(''),
  } as Response;
}

/** Prefix of the filler entries that pad a fixture catalogue to the live-read floor. */
export const FILLER_MODEL_ID_PREFIX = 'fixture/filler/';

/** Pad a fixture catalogue to the live-read floor with neutral, schema-valid filler models. */
export function cataloguePayload(models: readonly unknown[]): { data: unknown[] } {
  const fillerCount = Math.max(0, OPENROUTER_CATALOGUE_MINIMUM_COUNTS.models - models.length);
  const filler = Array.from({ length: fillerCount }, (_, index) => ({
    id: `${FILLER_MODEL_ID_PREFIX}${index}`,
    name: `Filler ${index}`,
    created: 0,
    description: `Neutral filler model ${index}.`,
    architecture: {
      input_modalities: ['text'],
      output_modalities: ['text'],
      tokenizer: 'other',
    },
    top_provider: { is_moderated: false },
    pricing: { prompt: '0', completion: '0' },
    context_length: 32000,
  }));
  return { data: [...models, ...filler] };
}

/** Drop the filler entries from a catalogue the code returned. */
export function withoutFillerModels<T extends { id: string }>(models: readonly T[]): T[] {
  return models.filter(model => !model.id.startsWith(FILLER_MODEL_ID_PREFIX));
}

export const mockOpenRouterModels = {
  data: [
    {
      id: 'anthropic/claude-sonnet-4',
      name: 'Claude Sonnet 4',
      created: 1714000000,
      description: 'Claude Sonnet 4',
      architecture: {
        input_modalities: ['text'],
        output_modalities: ['text'],
        tokenizer: 'claude',
      },
      top_provider: {
        is_moderated: true,
      },
      pricing: {
        prompt: '0.000003',
        completion: '0.000015',
        image: '0',
        request: '0',
        input_cache_read: '0',
        input_cache_write: '0',
        web_search: '0',
        internal_reasoning: '0',
      },
      context_length: 200000,
    },
    {
      id: 'anthropic/claude-3.7-sonnet',
      name: 'Claude 3.7 Sonnet',
      created: 1714000000,
      description: 'Claude 3.7 Sonnet model',
      architecture: {
        input_modalities: ['text'],
        output_modalities: ['text'],
        tokenizer: 'claude',
      },
      top_provider: {
        is_moderated: true,
      },
      pricing: {
        prompt: '0.000003',
        completion: '0.000015',
        image: '0',
        request: '0',
        input_cache_read: '0',
        input_cache_write: '0',
        web_search: '0',
        internal_reasoning: '0',
      },
      context_length: 200000,
    },
    {
      id: 'google/gemini-2.5-pro',
      name: 'Gemini 2.5 Pro',
      created: 1713000000,
      description: 'Gemini 2.5 Pro model',
      architecture: {
        input_modalities: ['text'],
        output_modalities: ['text'],
        tokenizer: 'gemini',
      },
      top_provider: {
        is_moderated: true,
      },
      pricing: {
        prompt: '0.00000125',
        completion: '0.00001',
        image: '0',
        request: '0',
        input_cache_read: '0',
        input_cache_write: '0',
        web_search: '0',
        internal_reasoning: '0',
      },
      context_length: 1000000,
    },
    {
      id: 'openai/gpt-4.1',
      name: 'GPT-4.1',
      created: 1712000000,
      description: 'GPT-4.1 model',
      architecture: {
        input_modalities: ['text'],
        output_modalities: ['text'],
        tokenizer: 'openai',
      },
      top_provider: {
        is_moderated: true,
      },
      pricing: {
        prompt: '0.000002',
        completion: '0.000008',
        image: '0',
        request: '0',
        input_cache_read: '0',
        input_cache_write: '0',
        web_search: '0',
        internal_reasoning: '0',
      },
      context_length: 128000,
    },
    {
      id: 'some-other-model',
      name: 'Other Model',
      created: 1711000000,
      description: 'Some other model',
      architecture: {
        input_modalities: ['text'],
        output_modalities: ['text'],
        tokenizer: 'other',
      },
      top_provider: {
        is_moderated: true,
      },
      pricing: {
        prompt: '0.000001',
        completion: '0.000005',
        image: '0',
        request: '0',
        input_cache_read: '0',
        input_cache_write: '0',
        web_search: '0',
        internal_reasoning: '0',
      },
      context_length: 32000,
    },
    {
      id: 'qwen/qwen3-coder',
      name: 'Qwen3 Coder',
      created: 1715000000,
      description: 'Qwen3 Coder model',
      architecture: {
        input_modalities: ['text'],
        output_modalities: ['text'],
        tokenizer: 'qwen',
      },
      top_provider: {
        is_moderated: true,
      },
      pricing: {
        prompt: '0.000001',
        completion: '0.000003',
        image: '0',
        request: '0',
        input_cache_read: '0',
        input_cache_write: '0',
        web_search: '0',
        internal_reasoning: '0',
      },
      context_length: 32000,
    },
  ],
};
