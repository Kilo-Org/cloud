import type { DirectUserByokInferenceProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';

// Client-safe display names for direct BYOK providers.
export const DIRECT_BYOK_PROVIDERS_META = {
  'byteplus-coding': 'BytePlus Coding Plan',
  'kimi-coding': 'Kimi Code',
  neuralwatt: 'Neuralwatt',
  'zai-coding': 'Z.ai Coding Plan',
} as const satisfies Record<Exclude<DirectUserByokInferenceProviderId, 'codestral'>, string>;

export type DirectByokProviderMetaId = keyof typeof DIRECT_BYOK_PROVIDERS_META;
