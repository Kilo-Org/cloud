import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';
import { XIAOMI_TOKEN_PLAN_MODELS } from '@/lib/ai-gateway/providers/direct-byok/xiaomi-token-plan-models';

export default {
  id: 'xiaomi-token-plan-ams',
  base_url: 'https://token-plan-ams.xiaomimimo.com/v1',
  ai_sdk_provider: 'openai-compatible',
  transformRequest() {},
  models: () => Promise.resolve(XIAOMI_TOKEN_PLAN_MODELS),
} satisfies DirectByokProvider;
