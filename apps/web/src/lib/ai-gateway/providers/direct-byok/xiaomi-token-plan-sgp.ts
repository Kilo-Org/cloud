import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';
import { XIAOMI_TOKEN_PLAN_MODELS } from '@/lib/ai-gateway/providers/direct-byok/xiaomi-token-plan-models';

export default {
  id: 'xiaomi-token-plan-sgp',
  base_url: 'https://token-plan-sgp.xiaomimimo.com/v1',
  ai_sdk_provider: 'openai-compatible',
  transformRequest() {},
  models: () => Promise.resolve(XIAOMI_TOKEN_PLAN_MODELS),
} satisfies DirectByokProvider;
