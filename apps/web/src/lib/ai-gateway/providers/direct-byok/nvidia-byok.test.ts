import type { TransformRequestContext } from '@/lib/ai-gateway/providers/types';
import nvidiaByok from './nvidia-byok';

const SUPER_MODEL_ID = 'nvidia/nemotron-3-super-120b-a12b';

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
  test('removes gateway-only request fields', () => {
    const body = transform({
      model: SUPER_MODEL_ID,
      provider: { order: ['nvidia'] },
      providerOptions: { gateway: {} },
      transforms: ['middle-out'],
      reasoning: { effort: 'low' },
      include_reasoning: true,
      safety_identifier: 'user-hash',
      prompt_cache_key: 'task-hash',
      temperature: 0.5,
    });

    expect(body).toMatchObject({
      model: SUPER_MODEL_ID,
      reasoning_effort: 'low',
      temperature: 0.5,
    });
    expect(body).not.toHaveProperty('provider');
    expect(body).not.toHaveProperty('providerOptions');
    expect(body).not.toHaveProperty('transforms');
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('include_reasoning');
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
});
