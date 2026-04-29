import {
  cacheDirectByokModelList,
  enhanceDirectByokModelList,
} from '@/lib/ai-gateway/providers/direct-byok/model-list';
import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';

const cachedModels = cacheDirectByokModelList('neuralwatt');

export default {
  id: 'neuralwatt',
  name: 'Neuralwatt',
  base_url: 'https://api.neuralwatt.com/v1',
  ai_sdk_provider: 'openai-compatible',
  transformRequest(_context) {},
  models: (async () =>
    enhanceDirectByokModelList({
      recommendedModels: [
        {
          id: 'moonshotai/Kimi-K2.6',
          name: 'moonshotai/Kimi-K2.6',
          description:
            'Kimi K2.6 demonstrates particularly strong performance in long-horizon coding tasks and produces professional-grade design with code and vision.',
          flags: [],
          context_length: 262144,
          max_completion_tokens: 32000,
          variants: null,
        },
      ],
      remainingModels: await cachedModels(),
      variants: null,
    }))(),
} satisfies DirectByokProvider;
