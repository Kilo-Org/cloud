import type { TransformRequestContext } from '@/lib/ai-gateway/providers/types';
import type { DirectByokModel } from './types';
import nvidiaByok from './nvidia-byok';

const SUPER_MODEL_ID = 'nvidia/nemotron-3-super-120b-a12b';
const SUPER_MODEL: DirectByokModel = {
  id: SUPER_MODEL_ID,
  name: 'Nemotron 3 Super',
  flags: ['reasoning'],
  context_length: 262144,
  max_completion_tokens: 262144,
  variants: {
    none: { reasoning: { enabled: false, effort: 'none' } },
    high: { reasoning: { enabled: true, effort: 'high' } },
  },
};

function transform(body: Record<string, unknown>, model: DirectByokModel = SUPER_MODEL) {
  const request = {
    kind: 'chat_completions',
    body: {
      messages: [{ role: 'user', content: 'Hello' }],
      ...body,
    },
  } as TransformRequestContext['request'];

  nvidiaByok.transformRequest({ request } as TransformRequestContext, model);
  return request.body;
}

describe('NVIDIA direct BYOK', () => {
  test('removes gateway-only request fields', () => {
    const body = transform({
      model: SUPER_MODEL_ID,
      provider: { order: ['nvidia'] },
      providerOptions: { gateway: {} },
      transforms: ['middle-out'],
      reasoning: { effort: 'low' },
      safety_identifier: 'user-hash',
      prompt_cache_key: 'task-hash',
      temperature: 0.5,
    });

    expect(body).toMatchObject({
      model: SUPER_MODEL_ID,
      temperature: 0.5,
    });
    expect(body).not.toHaveProperty('provider');
    expect(body).not.toHaveProperty('providerOptions');
    expect(body).not.toHaveProperty('transforms');
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('safety_identifier');
    expect(body).not.toHaveProperty('prompt_cache_key');
  });

  test('translates an explicit reasoning disable to the documented none effort', () => {
    expect(transform({ model: SUPER_MODEL_ID, reasoning: { enabled: false } })).toHaveProperty(
      'reasoning_effort',
      'none'
    );
  });

  test('preserves an explicit reasoning effort', () => {
    expect(
      transform({
        model: SUPER_MODEL_ID,
        reasoning_effort: 'high',
        reasoning: { effort: 'low' },
      })
    ).toHaveProperty('reasoning_effort', 'high');
    expect(
      transform({ model: SUPER_MODEL_ID, reasoning_effort: 'unsupported' })
    ).not.toHaveProperty('reasoning_effort');
  });

  test('strips efforts not supported by the selected model', () => {
    const gptOssModel: DirectByokModel = {
      id: 'openai/gpt-oss-120b',
      name: 'GPT-OSS-120B',
      flags: ['reasoning'],
      context_length: 128000,
      max_completion_tokens: 8192,
      variants: {
        low: { reasoning: { enabled: true, effort: 'low' } },
        medium: { reasoning: { enabled: true, effort: 'medium' } },
        high: { reasoning: { enabled: true, effort: 'high' } },
      },
    };

    expect(transform({ reasoning_effort: 'medium' }, gptOssModel)).toHaveProperty(
      'reasoning_effort',
      'medium'
    );
    expect(transform({ reasoning_effort: 'max' }, gptOssModel)).not.toHaveProperty(
      'reasoning_effort'
    );
    expect(transform({ reasoning: { enabled: false } }, gptOssModel)).not.toHaveProperty(
      'reasoning_effort'
    );
  });
});
