import { DirectUserByokInferenceProviderIdSchema } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';

/**
 * Client-safe metadata for direct BYOK providers.
 *
 * Kept separate from `direct-byok-definitions.ts` because that module
 * pulls in server-only dependencies (Redis, the AI SDK, etc.) through
 * the per-provider definition files. This file must not import any of
 * those modules so it can be safely included in client bundles.
 */
export const DIRECT_BYOK_PROVIDERS_META = [
  {
    id: DirectUserByokInferenceProviderIdSchema.enum['byteplus-coding'],
    name: 'BytePlus Coding Plan',
  },
  { id: DirectUserByokInferenceProviderIdSchema.enum['kimi-coding'], name: 'Kimi Code' },
  { id: DirectUserByokInferenceProviderIdSchema.enum.neuralwatt, name: 'Neuralwatt' },
  { id: DirectUserByokInferenceProviderIdSchema.enum['zai-coding'], name: 'Z.ai Coding Plan' },
] as const;
