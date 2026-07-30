import type { TransformRequestContext } from '@/lib/ai-gateway/providers/types';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import nvidiaByok from './nvidia-byok';

describe('NVIDIA BYOK', () => {
  test('uses reasoning_effort and removes unsupported request parameters', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'nvidia-byok/z-ai/glm-5.2',
        messages: [{ role: 'user', content: 'Hello' }],
        provider: { order: ['nvidia'] },
        transforms: ['middle-out'],
        reasoning: { effort: 'high' },
        safety_identifier: 'safety-id',
        prompt_cache_key: 'cache-key',
      },
    };

    nvidiaByok.transformRequest({ request } as TransformRequestContext);

    expect(request.body.reasoning_effort).toBe('high');
    expect(request.body.provider).toBeUndefined();
    expect(request.body.transforms).toBeUndefined();
    expect(request.body.reasoning).toBeUndefined();
    expect(request.body.safety_identifier).toBeUndefined();
    expect(request.body.prompt_cache_key).toBeUndefined();
  });
});
