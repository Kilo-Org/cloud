import {
  COMPATIBLE_USER_AGENT,
  type DirectByokModel,
  type DirectByokProvider,
} from '@/lib/ai-gateway/providers/direct-byok/types';

export const TENCENT_TOKEN_PLAN_PROVIDER_ID = 'tencent-token-plan';

export const TENCENT_TOKEN_PLAN_MODELS = [
  {
    id: 'auto',
    name: 'Auto',
    context_length: 196_608,
    max_completion_tokens: 32_768,
  },
  {
    id: 'glm-5.2',
    name: 'GLM-5.2',
    flags: ['recommended', 'reasoning'],
    context_length: 1_048_576,
    max_completion_tokens: 131_072,
  },
  {
    id: 'kimi-k2.6',
    name: 'Kimi-K2.6',
    flags: ['vision', 'reasoning'],
    context_length: 262_144,
    max_completion_tokens: 262_144,
  },
  {
    id: 'minimax-m3',
    name: 'MiniMax-M3',
    flags: ['reasoning'],
    context_length: 1_048_576,
    max_completion_tokens: 131_072,
  },
  {
    id: 'deepseek-v4-flash-202605',
    name: 'DeepSeek-V4-Flash (Vendor Direct)',
    flags: ['reasoning'],
    context_length: 1_048_576,
    max_completion_tokens: 393_216,
  },
  {
    id: 'deepseek-v4-pro-202606',
    name: 'DeepSeek-V4-Pro (Vendor Direct)',
    flags: ['reasoning'],
    context_length: 1_048_576,
    max_completion_tokens: 393_216,
  },
] as const satisfies ReadonlyArray<DirectByokModel>;

export default {
  id: TENCENT_TOKEN_PLAN_PROVIDER_ID,
  base_url: 'https://tokenhub-intl.tencentcloudmaas.com/plan/v3',
  supported_chat_apis: ['chat_completions'],
  default_ai_sdk_provider: 'openai-compatible',
  transformRequest(context) {
    context.extraHeaders['user-agent'] = COMPATIBLE_USER_AGENT;
  },
  models: () => Promise.resolve(TENCENT_TOKEN_PLAN_MODELS),
} satisfies DirectByokProvider;
