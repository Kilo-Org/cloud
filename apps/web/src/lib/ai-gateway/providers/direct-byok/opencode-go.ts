import { cachedEnhancedDirectByokModelList } from '@/lib/ai-gateway/providers/direct-byok/model-list';
import type {
  DirectByokModel,
  DirectByokProvider,
} from '@/lib/ai-gateway/providers/direct-byok/types';
import type { CustomLlmProvider } from '@kilocode/db';

export function getOpenCodeGoAiSdkProvider(model: DirectByokModel): CustomLlmProvider | undefined {
  const modelId = model.id.toLowerCase();
  return modelId.includes('minimax') || modelId.includes('qwen') ? 'anthropic' : undefined;
}

export default {
  id: 'opencode-go',
  base_url: 'https://opencode.ai/zen/go/v1',
  supported_chat_apis: ['chat_completions', 'messages'],
  default_ai_sdk_provider: 'openai-compatible',
  ai_sdk_provider: getOpenCodeGoAiSdkProvider,
  transformRequest() {},
  models: cachedEnhancedDirectByokModelList({
    providerId: 'opencode-go',
    recommendedModels: [
      {
        id: 'qwen3.7-plus',
        name: 'Qwen3.7 Plus',
        flags: ['vision'],
        context_length: 1_000_000,
        max_completion_tokens: 65_536,
      },
    ],
  }),
} satisfies DirectByokProvider;
