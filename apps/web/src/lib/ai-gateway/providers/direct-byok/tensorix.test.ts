import {
  DirectUserByokInferenceProviderIdSchema,
  UserByokTestModels,
} from '../openrouter/inference-provider-id';
import DIRECT_BYOK_PROVIDERS from './direct-byok-definitions';
import { DIRECT_BYOK_PROVIDERS_META } from './direct-byok-meta';
import tensorix from './tensorix';

const DOCUMENTED_CHAT_MODELS = [
  'z-ai/glm-5.1',
  'z-ai/glm-4.6',
  'minimax/minimax-m2.5',
  'minimax/minimax-m2',
  'moonshotai/kimi-k2.5',
  'deepseek/deepseek-chat-v3.1',
  'deepseek/deepseek-v3.2',
  'deepseek/deepseek-r1-0528',
  'qwen/qwen3-235b-a22b-2507',
  'qwen/qwen3-coder-30b-a3b-instruct',
  'meta-llama/llama-3.3-70b-instruct',
  'meta-llama/llama-4-maverick',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
];

describe('Tensorix direct BYOK provider', () => {
  test('is registered as an OpenAI-compatible provider', () => {
    expect(tensorix.id).toBe('tensorix');
    expect(tensorix.base_url).toBe('https://api.tensorix.ai/v1');
    expect(tensorix.supported_chat_apis).toEqual(['chat_completions']);
    expect(tensorix.default_ai_sdk_provider).toBe('openai-compatible');
    expect(tensorix.force_ai_sdk_provider).toBe('openai-compatible');
    expect(DirectUserByokInferenceProviderIdSchema.parse('tensorix')).toBe('tensorix');
    expect(DIRECT_BYOK_PROVIDERS).toContain(tensorix);
    expect(DIRECT_BYOK_PROVIDERS_META.tensorix).toBe('Tensorix');
    expect(UserByokTestModels.tensorix).toBe('z-ai/glm-5.1');
  });

  test('exposes the documented chat models', async () => {
    const models = await tensorix.models();

    expect(models.map(model => model.id)).toEqual(DOCUMENTED_CHAT_MODELS);
    expect(models).toContainEqual(
      expect.objectContaining({
        id: 'z-ai/glm-5.1',
        flags: ['recommended'],
      })
    );
    expect(models).toContainEqual(
      expect.objectContaining({
        id: 'moonshotai/kimi-k2.5',
        flags: ['vision'],
      })
    );
  });
});
