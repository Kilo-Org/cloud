import { jest } from '@jest/globals';
import type { TransformRequestContext } from '@/lib/ai-gateway/providers/types';
import {
  NVIDIA_NEMOTRON_3_SUPER_MODEL_ID,
  NVIDIA_NEMOTRON_3_ULTRA_MODEL_ID,
} from '@/lib/ai-gateway/providers/nvidia';
import { UserByokTestModels } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { getAiSdkProvider, getModelVariants } from '../model-settings';
import nvidiaByok from './nvidia-byok';

jest.mock('@/lib/redis', () => ({
  redisClient: { get: jest.fn(async () => null) },
}));

function transform(body: Record<string, unknown>) {
  const request = {
    kind: 'chat_completions',
    body: {
      messages: [{ role: 'user', content: 'Hello' }],
      ...body,
    },
  } as TransformRequestContext['request'];

  nvidiaByok.transformRequest({ request } as TransformRequestContext);
  return request.body;
}

describe('NVIDIA direct BYOK', () => {
  test('uses NVIDIA hosted Chat Completions without a static model fallback', async () => {
    expect(nvidiaByok.id).toBe('nvidia-byok');
    expect(nvidiaByok.base_url).toBe('https://integrate.api.nvidia.com/v1');
    expect(nvidiaByok.supported_chat_apis).toEqual(['chat_completions']);
    expect(nvidiaByok.default_ai_sdk_provider).toBe('openai-compatible');
    await expect(nvidiaByok.models()).resolves.toEqual([]);
  });

  test('registers the static Nano credential-test model as direct BYOK', () => {
    expect(nvidiaByok.id).toBe('nvidia-byok');
    expect(UserByokTestModels['nvidia-byok']).toBe('nvidia/nemotron-3-nano-30b-a3b');
  });

  test('removes gateway-only request fields', () => {
    const body = transform({
      model: NVIDIA_NEMOTRON_3_SUPER_MODEL_ID,
      provider: { order: ['nvidia'] },
      providerOptions: { gateway: {} },
      transforms: ['middle-out'],
      reasoning: { effort: 'low' },
      include_reasoning: true,
      temperature: 0.5,
    });

    expect(body).toMatchObject({
      model: NVIDIA_NEMOTRON_3_SUPER_MODEL_ID,
      reasoning_effort: 'low',
      temperature: 0.5,
    });
    expect(body).not.toHaveProperty('provider');
    expect(body).not.toHaveProperty('providerOptions');
    expect(body).not.toHaveProperty('transforms');
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('include_reasoning');
  });

  test('removes gateway attribution and cache-hint fields NVIDIA rejects', () => {
    const body = transform({
      model: NVIDIA_NEMOTRON_3_SUPER_MODEL_ID,
      safety_identifier: 'user-hash',
      user: 'user-hash',
      prompt_cache_key: 'task-hash',
    });

    expect(body).not.toHaveProperty('safety_identifier');
    expect(body).not.toHaveProperty('user');
    expect(body).not.toHaveProperty('prompt_cache_key');
  });

  test('uses the documented reasoning efforts for Super and Ultra', () => {
    expect(
      transform({ model: NVIDIA_NEMOTRON_3_SUPER_MODEL_ID, reasoning: { effort: 'low' } })
    ).toHaveProperty('reasoning_effort', 'low');
    expect(
      transform({ model: NVIDIA_NEMOTRON_3_ULTRA_MODEL_ID, reasoning: { effort: 'medium' } })
    ).toHaveProperty('reasoning_effort', 'medium');
  });

  test('translates an explicit reasoning disable to the documented none effort', () => {
    expect(
      transform({ model: NVIDIA_NEMOTRON_3_SUPER_MODEL_ID, reasoning: { enabled: false } })
    ).toHaveProperty('reasoning_effort', 'none');
  });

  test('strips reasoning controls for models without verified reasoning support', () => {
    // gpt-oss and Llama endpoints return 400 for efforts they do not accept.
    expect(
      transform({ model: 'openai/gpt-oss-120b', reasoning_effort: 'none' })
    ).not.toHaveProperty('reasoning_effort');
    expect(
      transform({ model: 'meta/llama-3.1-8b-instruct', reasoning_effort: 'max' })
    ).not.toHaveProperty('reasoning_effort');
  });

  test('keeps documented efforts for gpt-oss models', () => {
    expect(transform({ model: 'openai/gpt-oss-120b', reasoning_effort: 'medium' })).toHaveProperty(
      'reasoning_effort',
      'medium'
    );
  });

  test('preserves valid explicit effort and removes unsupported efforts', () => {
    expect(
      transform({
        model: NVIDIA_NEMOTRON_3_SUPER_MODEL_ID,
        reasoning_effort: 'high',
        reasoning: { effort: 'low' },
      })
    ).toHaveProperty('reasoning_effort', 'high');
    expect(
      transform({
        model: NVIDIA_NEMOTRON_3_SUPER_MODEL_ID,
        reasoning_effort: 'medium',
      })
    ).not.toHaveProperty('reasoning_effort');
  });

  test('pins NVIDIA models to OpenAI-compatible Chat Completions', () => {
    expect(getAiSdkProvider('nvidia-byok/openai/gpt-5.5', 'nvidia-byok')).toBe('openai-compatible');
  });

  test('advertises only NVIDIA-documented reasoning variants', () => {
    expect(
      Object.keys(
        getModelVariants(`nvidia-byok/${NVIDIA_NEMOTRON_3_SUPER_MODEL_ID}`, 'nvidia-byok')!
      )
    ).toEqual(['none', 'low', 'high']);
    expect(
      Object.keys(
        getModelVariants(`nvidia-byok/${NVIDIA_NEMOTRON_3_ULTRA_MODEL_ID}`, 'nvidia-byok')!
      )
    ).toEqual(['none', 'medium', 'high']);
    expect(getModelVariants('nvidia-byok/qwen/qwen3-coder', 'nvidia-byok')).toBeUndefined();
  });
});
