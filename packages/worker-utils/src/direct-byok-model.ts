/**
 * Provider ids whose models route to the user's own API key (direct BYOK) and
 * never bill Kilo credits. A model id is `<providerId>/<model...>` — see
 * `formatDirectByokModelId` in
 * packages/web-shared/src/lib/ai-gateway/providers/direct-byok/index.ts.
 *
 * This is the source of truth: it lives here so Cloudflare Workers can use it,
 * and web-shared derives its direct BYOK schema and display names from it.
 */
export const DIRECT_BYOK_PROVIDER_IDS = [
  'alibaba-token-plan',
  'bedrock-byok',
  'byteplus-coding',
  'chutes-byok',
  'edenai',
  'kimi-coding',
  'inceptron-byok',
  'martian',
  'morph-byok',
  'neuralwatt',
  'nvidia-byok',
  'ollama-cloud',
  'opencode-go',
  'orcarouter',
  'synthetic',
  'vertex-byok',
  'xiaomi-token-plan-ams',
  'xiaomi-token-plan-sgp',
  'zai-coding',
] as const;

export type DirectByokProviderId = (typeof DIRECT_BYOK_PROVIDER_IDS)[number];

const ids: ReadonlySet<string> = new Set(DIRECT_BYOK_PROVIDER_IDS);

export function isDirectByokModelId(modelId: string | undefined | null): boolean {
  if (!modelId) return false;
  return ids.has(modelId.toLowerCase().split('/')[0] ?? '');
}
