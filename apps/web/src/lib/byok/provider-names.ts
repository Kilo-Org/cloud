import {
  DirectUserByokInferenceProviderIdSchema,
  type GatewayUserByokProviderId,
  type VercelUserByokInferenceProviderId,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { DIRECT_BYOK_PROVIDERS_META } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/direct-byok-meta';

// Exhaustive map of Vercel BYOK providers to their display names. The `satisfies`
// clause forces new entries here whenever a provider is added to
// VercelUserByokInferenceProviderIdSchema. The `openai` entry names the pasted
// API key: the personal BYOK page also renders the "Sign in with ChatGPT"
// connection card, so a bare 'OpenAI' there and here would be two different
// things with one name.
export const VERCEL_BYOK_PROVIDER_NAMES = {
  anthropic: 'Anthropic',
  azure: 'Azure Foundry',
  bedrock: 'AWS Bedrock',
  cohere: 'Cohere',
  deepseek: 'DeepSeek',
  openai: 'OpenAI API key',
  inception: 'Inception',
  fireworks: 'Fireworks',
  gmicloud: 'GMI Cloud',
  google: 'Google AI Studio',
  minimax: 'MiniMax',
  mistral: 'Mistral AI',
  moonshotai: 'Moonshot AI',
  nebius: 'Nebius Token Factory',
  novita: 'Novita AI',
  perplexity: 'Perplexity',
  vertex: 'Google Vertex AI',
  xai: 'SpaceXSI',
  xiaomi: 'Xiaomi (pay as you go)',
  zai: 'Z.ai (pay as you go)',
} satisfies Record<VercelUserByokInferenceProviderId, string>;

const VERCEL_BYOK_PROVIDERS = [
  ...Object.entries(VERCEL_BYOK_PROVIDER_NAMES).map(([id, name]) => ({ id, name })),
  { id: DirectUserByokInferenceProviderIdSchema.enum.codestral, name: 'Legacy Codestral-only key' },
];

export const DIRECT_BYOK_PROVIDERS_LIST = Object.entries(DIRECT_BYOK_PROVIDERS_META).map(
  ([id, name]) => ({ id, name })
);

const GATEWAY_BYOK_PROVIDER_NAMES = {
  'vercel-ai-gateway': 'Vercel AI Gateway',
  openrouter: 'OpenRouter',
} satisfies Record<GatewayUserByokProviderId, string>;

const GATEWAY_BYOK_PROVIDERS_LIST = Object.entries(GATEWAY_BYOK_PROVIDER_NAMES).map(
  ([id, name]) => ({ id, name })
);

export const BYOK_PROVIDERS = [
  ...DIRECT_BYOK_PROVIDERS_LIST,
  ...VERCEL_BYOK_PROVIDERS,
  ...GATEWAY_BYOK_PROVIDERS_LIST,
].toSorted((a, b) => a.name.localeCompare(b.name));

export function getByokProviderDisplayName(providerId: string): string {
  const provider = BYOK_PROVIDERS.find(p => p.id === providerId);
  return provider?.name || providerId;
}

/** Some display names already name the credential ("OpenAI API key"), so they keep one "key". */
export function byokKeyLabel(names: string[]): string {
  const providers = names.map(name => name.replace(/\s+key$/i, ''));
  return `${providers.join(', ')} ${names.length === 1 ? 'key' : 'keys'}`;
}
