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

/**
 * An organization's own endpoint, a direct BYOK provider only its organization's keys define. Its
 * id is `ByokEndpointProviderId` from `@kilocode/db/schema-types`.
 */
const BYOK_ENDPOINT_PROVIDER_ID_PATTERN = /^endpoint-[a-z0-9]{10}$/;

/** Whether `modelId` names a direct BYOK provider or an organization's endpoint. */
export function isDirectByokModelId(modelId: string | undefined | null): boolean {
  if (!modelId) return false;
  const providerId = modelId.toLowerCase().split('/')[0] ?? '';
  return ids.has(providerId) || BYOK_ENDPOINT_PROVIDER_ID_PATTERN.test(providerId);
}
