import type { DirectUserByokInferenceProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';

/**
 * Client-safe display names for direct BYOK providers.
 *
 * Kept separate from `direct-byok-definitions.ts` because that module
 * pulls in server-only dependencies (Redis, the AI SDK, etc.) through
 * the per-provider definition files. This file must not import any of
 * those modules so it can be safely included in client bundles.
 *
 * `codestral` is excluded because it is managed through the Vercel
 * provider list rather than the direct BYOK definitions.
 */
export const DIRECT_BYOK_PROVIDERS_META = {
  'byteplus-coding': 'BytePlus Coding Plan',
  'kimi-coding': 'Kimi Code',
  neuralwatt: 'Neuralwatt',
  'zai-coding': 'Z.ai Coding Plan',
} as const satisfies Partial<Record<DirectUserByokInferenceProviderId, string>>;

export type DirectByokProviderMetaId = keyof typeof DIRECT_BYOK_PROVIDERS_META;
