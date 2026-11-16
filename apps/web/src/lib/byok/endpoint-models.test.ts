import { describe, expect, test } from '@jest/globals';
import { parseByokEndpointModelsResponse, toByokEndpointModelId } from './endpoint-models';

// Trimmed from real `GET /models` responses of each provider.
const OPENROUTER = {
  data: [
    {
      id: 'qwen/qwen4-max',
      canonical_slug: 'qwen/qwen4-max-20261115',
      name: 'Qwen: Qwen4 Max',
      context_length: 1000000,
      architecture: {
        modality: 'text+image+video->text',
        input_modalities: ['text', 'image', 'video'],
        output_modalities: ['text'],
      },
      top_provider: { context_length: 1000000, max_completion_tokens: 131072 },
    },
    {
      id: 'deepseek/deepseek-v4',
      name: 'DeepSeek: DeepSeek V4',
      context_length: 163840,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      top_provider: { context_length: 163840, max_completion_tokens: null },
    },
  ],
  total_count: 2,
};

const VERCEL_AI_GATEWAY = {
  object: 'list',
  data: [
    {
      id: 'alibaba/qwen-3-14b',
      object: 'model',
      name: 'Qwen3-14B',
      context_window: 40960,
      max_tokens: 16384,
      type: 'language',
      modalities: { input: ['text'], output: ['text'] },
    },
    {
      id: 'google/gemini-3-flash',
      object: 'model',
      name: 'Gemini 3 Flash',
      context_window: 1048576,
      max_tokens: 65536,
      type: 'language',
      modalities: { input: ['text', 'image', 'file'], output: ['text'] },
    },
    {
      id: 'openai/text-embedding-3-small',
      object: 'model',
      name: 'text-embedding-3-small',
      context_window: 8192,
      max_tokens: 0,
      type: 'embedding',
      modalities: { input: ['text'], output: ['text'] },
    },
  ],
};

const MISTRAL = {
  object: 'list',
  data: [
    {
      id: 'codestral-2508',
      object: 'model',
      capabilities: { completion_chat: true, function_calling: true, vision: false },
      name: 'codestral-2508',
      max_context_length: 256000,
      type: 'base',
    },
    {
      id: 'mistral-medium-2508',
      object: 'model',
      capabilities: { completion_chat: true, vision: true },
      name: 'mistral-medium-2508',
      max_context_length: 131072,
      type: 'base',
    },
    {
      id: 'mistral-embed',
      object: 'model',
      capabilities: { completion_chat: false, vision: false },
      name: 'mistral-embed',
      max_context_length: 8192,
      type: 'base',
    },
  ],
};

const NOVITA = {
  data: [
    {
      id: 'tencent/hy4-flash',
      object: 'model',
      title: 'tencent/hy4-flash',
      context_size: 1000000,
      display_name: 'Hy4 Flash',
      model_type: 'chat',
      max_output_tokens: 64000,
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
    },
  ],
};

const ANTHROPIC = {
  data: [
    {
      type: 'model',
      id: 'claude-fable-5-2',
      display_name: 'Claude Fable 5.2',
      max_input_tokens: 1000000,
      max_tokens: 128000,
      capabilities: { image_input: { supported: true }, pdf_input: { supported: true } },
    },
  ],
  has_more: false,
  first_id: 'claude-fable-5-2',
  last_id: 'claude-fable-5-2',
};

const OPENAI = {
  object: 'list',
  data: [
    { id: 'gpt-5.5', object: 'model', created: 1776902400, owned_by: 'system' },
    { id: 'tts-1', object: 'model', created: 1681940951, owned_by: 'openai-internal' },
  ],
};

describe('parseByokEndpointModelsResponse', () => {
  test('reads OpenRouter limits and image input from the architecture and top provider', () => {
    expect(parseByokEndpointModelsResponse(OPENROUTER)).toEqual([
      {
        id: 'qwen/qwen4-max',
        internal_id: 'qwen/qwen4-max',
        name: 'Qwen: Qwen4 Max',
        context_length: 1000000,
        max_completion_tokens: 131072,
        flags: ['reasoning', 'vision'],
      },
      {
        id: 'deepseek/deepseek-v4',
        internal_id: 'deepseek/deepseek-v4',
        name: 'DeepSeek: DeepSeek V4',
        context_length: 163840,
        max_completion_tokens: 32000,
        flags: ['reasoning'],
      },
    ]);
  });

  test('reads Vercel AI Gateway context windows and skips models that cannot chat', () => {
    expect(parseByokEndpointModelsResponse(VERCEL_AI_GATEWAY)).toEqual([
      {
        id: 'alibaba/qwen-3-14b',
        internal_id: 'alibaba/qwen-3-14b',
        name: 'Qwen3-14B',
        context_length: 40960,
        max_completion_tokens: 16384,
        flags: ['reasoning'],
      },
      {
        id: 'google/gemini-3-flash',
        internal_id: 'google/gemini-3-flash',
        name: 'Gemini 3 Flash',
        context_length: 1048576,
        max_completion_tokens: 65536,
        flags: ['reasoning', 'vision'],
      },
    ]);
  });

  test('reads Mistral capabilities', () => {
    expect(parseByokEndpointModelsResponse(MISTRAL)).toEqual([
      {
        id: 'codestral-2508',
        internal_id: 'codestral-2508',
        name: 'codestral-2508',
        context_length: 256000,
        max_completion_tokens: 32000,
        flags: ['reasoning'],
      },
      {
        id: 'mistral-medium-2508',
        internal_id: 'mistral-medium-2508',
        name: 'mistral-medium-2508',
        context_length: 131072,
        max_completion_tokens: 32000,
        flags: ['reasoning', 'vision'],
      },
    ]);
  });

  test('reads Novita context sizes, output limits, and display names', () => {
    expect(parseByokEndpointModelsResponse(NOVITA)).toEqual([
      {
        id: 'tencent/hy4-flash',
        internal_id: 'tencent/hy4-flash',
        name: 'Hy4 Flash',
        context_length: 1000000,
        max_completion_tokens: 64000,
        flags: ['reasoning', 'vision'],
      },
    ]);
  });

  test('reads Anthropic input and output limits and image capability', () => {
    expect(parseByokEndpointModelsResponse(ANTHROPIC)).toEqual([
      {
        id: 'claude-fable-5-2',
        internal_id: 'claude-fable-5-2',
        name: 'Claude Fable 5.2',
        context_length: 1000000,
        max_completion_tokens: 128000,
        flags: ['reasoning', 'vision'],
      },
    ]);
  });

  test('gives OpenAI models without metadata the default name and limits', () => {
    expect(parseByokEndpointModelsResponse(OPENAI)).toEqual([
      {
        id: 'gpt-5.5',
        internal_id: 'gpt-5.5',
        name: 'gpt-5.5',
        context_length: 200000,
        max_completion_tokens: 32000,
        flags: ['reasoning'],
      },
      {
        id: 'tts-1',
        internal_id: 'tts-1',
        name: 'tts-1',
        context_length: 200000,
        max_completion_tokens: 32000,
        flags: ['reasoning'],
      },
    ]);
  });

  test('accepts a bare array and keeps max output within a small context', () => {
    expect(
      parseByokEndpointModelsResponse([
        { id: 'Local/Model:Q4', max_model_len: 8192, max_tokens: 16384 },
      ])
    ).toEqual([
      {
        id: 'local/model-q4',
        internal_id: 'Local/Model:Q4',
        name: 'Model:Q4',
        context_length: 8192,
        max_completion_tokens: 8192,
        flags: ['reasoning'],
      },
    ]);
  });

  test('skips entries without an id and duplicate upstream ids, and renames clashing ids', () => {
    expect(
      parseByokEndpointModelsResponse({
        data: [{ name: 'no id' }, 'text', { id: 'Model-A' }, { id: 'model-a' }, { id: 'Model-A' }],
      }).map(model => [model.id, model.internal_id])
    ).toEqual([
      ['model-a', 'Model-A'],
      ['model-a-2', 'model-a'],
    ]);
  });

  test('returns no models for an unrecognized response', () => {
    expect(parseByokEndpointModelsResponse({ error: 'nope' })).toEqual([]);
    expect(parseByokEndpointModelsResponse(null)).toEqual([]);
  });
});

describe('toByokEndpointModelId', () => {
  test.each([
    ['anthropic.claude-sonnet-4-5-20250929-v1:0', 'anthropic.claude-sonnet-4-5-20250929-v1-0'],
    ['models/gemini-3-pro', 'models/gemini-3-pro'],
    ['  Meta Llama 4  ', 'meta-llama-4'],
    ['@cf/meta/llama', 'cf/meta/llama'],
  ])('maps %j to %j', (internalId, id) => {
    expect(toByokEndpointModelId(internalId)).toBe(id);
  });

  test('returns null when nothing usable is left', () => {
    expect(toByokEndpointModelId('::')).toBeNull();
  });
});
