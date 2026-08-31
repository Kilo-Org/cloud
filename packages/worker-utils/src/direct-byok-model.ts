/**
 * Provider ids whose models route to the user's own API key (direct BYOK) and
 * never bill Kilo credits. A model id is `<providerId>/<model...>` — see
 * `formatDirectByokModelId` in
 * apps/web/src/lib/ai-gateway/providers/direct-byok/index.ts:17.
 *
 * Source of truth is `DIRECT_BYOK_PROVIDERS_META` in
 * apps/web/src/lib/ai-gateway/providers/direct-byok/direct-byok-meta.ts:4.
 * This copy exists because Cloudflare Workers cannot import from apps/web.
 * A drift-guard test keeps the two lists equal.
 */
export const DIRECT_BYOK_PROVIDER_IDS = [
  'alibaba-token-plan',
  'byteplus-coding',
  'chutes-byok',
  'crofai',
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
  'xiaomi-token-plan-ams',
  'xiaomi-token-plan-sgp',
  'zai-coding',
] as const;

const ids: ReadonlySet<string> = new Set(DIRECT_BYOK_PROVIDER_IDS);

export function isDirectByokModelId(modelId: string | undefined | null): boolean {
  if (!modelId) return false;
  return ids.has(modelId.toLowerCase().split('/')[0] ?? '');
}
