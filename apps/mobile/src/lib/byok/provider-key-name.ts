import { i18n } from '@/i18n';

/**
 * The provider names the app translates, and only those.
 *
 * Most BYOK provider names are product marks: "DeepSeek", "Cohere" and "Mistral
 * AI" read the same in every language, so they have no catalog entry and this
 * table does not name them. A name earns an entry when it appends prose to the
 * mark — a qualifier the reader has to understand — as "Legacy Codestral-only
 * key", "OpenAI API key", "Xiaomi (pay as you go)" and the two "(direct)"
 * providers do.
 *
 * The server sends the same names in English, so this table is the app's only
 * translation layer for them: one key per descriptive name, and every surface
 * that shows a provider name reads it through `providerKeyName`.
 */
const PROVIDER_KEY_NAME_KEYS = {
  codestral: 'profile.providerKeys.names.codestral',
  openai: 'profile.providerKeys.names.openai',
  'openai-chatgpt': 'profile.providerKeys.names.openaiChatgpt',
  xiaomi: 'profile.providerKeys.names.xiaomi',
  zai: 'profile.providerKeys.names.zai',
  'bedrock-byok': 'profile.providerKeys.names.bedrockByok',
  'vertex-byok': 'profile.providerKeys.names.vertexByok',
} as const satisfies Record<string, string>;

const PROVIDER_KEY_NAME_MAP = new Map<string, string>(Object.entries(PROVIDER_KEY_NAME_KEYS));

/**
 * Two server names end in the credential noun ("OpenAI API key", "Legacy
 * Codestral-only key"). A title and the switch label around it already read
 * "… the {{provider}} key", so the name loses that noun wherever it is shown
 * and the sentence keeps it once. Translated values are stored without it, and
 * this strip covers the English fallback of a name the table does not hold.
 */
export function providerKeyName(providerId: string, serverName: string): string {
  const key = PROVIDER_KEY_NAME_MAP.get(providerId);
  const name = key === undefined ? serverName : i18n.t(key);
  return name.replace(/\s+key$/i, '');
}
