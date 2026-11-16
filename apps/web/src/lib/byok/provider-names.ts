import {
  DirectUserByokInferenceProviderIdSchema,
  GatewayUserByokProviderIdSchema,
  VercelUserByokInferenceProviderIdSchema,
  type GatewayUserByokProviderId,
  type UserByokProviderId,
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

/**
 * One row of a provider picker. The id carries the provider union rather than a
 * bare string, because it is the value a key is created with: the lists are built
 * from the enum itself, so a provider added to the schema appears here without a
 * second edit and an id the create procedure rejects cannot be produced.
 */
export type ByokProviderOption = { readonly id: UserByokProviderId; readonly name: string };

/**
 * Keys that exist but cannot be added: each serves a key created before its
 * provider was retired. They are listed so an existing key keeps its name, and
 * every addable list subtracts them.
 */
const LEGACY_ONLY_BYOK_PROVIDERS = [
  { id: 'codestral', name: 'Legacy Codestral-only key' },
] as const satisfies readonly ByokProviderOption[];

type LegacyOnlyByokProviderId = (typeof LEGACY_ONLY_BYOK_PROVIDERS)[number]['id'];

function isLegacyOnlyByokProviderId(providerId: string): providerId is LegacyOnlyByokProviderId {
  return LEGACY_ONLY_BYOK_PROVIDERS.some(provider => provider.id === providerId);
}

const VERCEL_BYOK_PROVIDERS: readonly ByokProviderOption[] =
  VercelUserByokInferenceProviderIdSchema.options.map(id => ({
    id,
    name: VERCEL_BYOK_PROVIDER_NAMES[id],
  }));

export const DIRECT_BYOK_PROVIDERS_LIST: readonly ByokProviderOption[] =
  DirectUserByokInferenceProviderIdSchema.options.flatMap(id => {
    // A legacy-only key is not a direct provider and has no direct-BYOK display name.
    if (isLegacyOnlyByokProviderId(id)) return [];
    return [{ id, name: DIRECT_BYOK_PROVIDERS_META[id] }];
  });

const GATEWAY_BYOK_PROVIDER_NAMES = {
  'vercel-ai-gateway': 'Vercel AI Gateway',
  openrouter: 'OpenRouter',
} satisfies Record<GatewayUserByokProviderId, string>;

const GATEWAY_BYOK_PROVIDERS_LIST: readonly ByokProviderOption[] =
  GatewayUserByokProviderIdSchema.options.map(id => ({
    id,
    name: GATEWAY_BYOK_PROVIDER_NAMES[id],
  }));

export const BYOK_PROVIDERS: readonly ByokProviderOption[] = [
  ...DIRECT_BYOK_PROVIDERS_LIST,
  ...LEGACY_ONLY_BYOK_PROVIDERS,
  ...VERCEL_BYOK_PROVIDERS,
  ...GATEWAY_BYOK_PROVIDERS_LIST,
].toSorted((a, b) => a.name.localeCompare(b.name));

/**
 * The providers a key can be added for, in the order the pickers show them: every
 * provider except the legacy-only keys, which only serve a key that already
 * exists. The experimental direct providers are filtered per owner at the
 * call site, because their entitlement belongs to the organization.
 */
export const ADD_BYOK_PROVIDERS: readonly ByokProviderOption[] = BYOK_PROVIDERS.filter(
  provider => !isLegacyOnlyByokProviderId(provider.id)
);

export function getByokProviderDisplayName(providerId: string): string {
  const provider = BYOK_PROVIDERS.find(p => p.id === providerId);
  return provider?.name || providerId;
}

/** Some display names already name the credential ("OpenAI API key"), so they keep one "key". */
export function byokKeyLabel(names: string[]): string {
  const providers = names.map(name => name.replace(/\s+key$/i, ''));
  return `${providers.join(', ')} ${names.length === 1 ? 'key' : 'keys'}`;
}
