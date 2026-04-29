import {
  COMPATIBLE_USER_AGENT,
  type DirectByokProvider,
} from '@/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'firepass',
  name: 'Fire Pass',
  base_url: 'https://api.fireworks.ai/inference/v1',
  ai_sdk_provider: 'openai-compatible',
  transformRequest(context) {
    context.extraHeaders['user-agent'] = COMPATIBLE_USER_AGENT;
  },
  models: [
    {
      id: 'accounts/fireworks/routers/kimi-k2p5-turbo',
      name: 'Kimi K2.5 Turbo',
      flags: ['recommended', 'vision'],
      context_length: 262144,
      max_completion_tokens: 32768,
      description:
        'Fire Pass grants access to Kimi K2.5 Turbo on Fireworks with no per-token charges for this model. Kimi K2.5 Turbo is a fast variant of Kimi K2.5, a reasoning model optimized for complex coding tasks with a 256K context window.',
      variants: null,
    },
  ],
} satisfies DirectByokProvider;
