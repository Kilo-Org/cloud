import { cachedEnhancedDirectByokModelList } from '@/lib/ai-gateway/providers/direct-byok/model-list';
import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';

export function isOpenCodeGoAnthropicMessagesModel(model: string): boolean {
  return model.startsWith('opencode-go/') && (model.includes('minimax') || model.includes('qwen'));
}

export default {
  id: 'opencode-go',
  base_url: 'https://opencode.ai/zen/go/v1',
  supported_chat_apis: ['chat_completions', 'messages'],
  default_ai_sdk_provider: 'openai-compatible',
  transformRequest(context) {
    if (context.request.kind === 'messages') {
      context.extraHeaders['x-api-key'] = context.provider.apiKey;
    }
  },
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
