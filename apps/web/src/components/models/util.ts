import type { OpenRouterModel } from '@/lib/ai-gateway/providers/openrouter/openrouter-types';

export type FilterState = {
  search: string;
  inputModalities: string[];
  outputModalities: string[];
  contextLengthMin: number;
  contextLengthMax: number;
  promptPricingMin: number;
  promptPricingMax: number;
  series: string[];
  categories: string[];
  supportedParameters: string[];
  providers: string[];
  providerLocations: string[];
  training: 'all' | 'yes' | 'no';
  retainsPrompts: 'all' | 'yes' | 'no';
  canPublish: 'all' | 'yes' | 'no';
  showFreeOnly: boolean;
  sortBySelected: boolean;
};

export interface OpenRouterProvider {
  name: string;
  displayName: string;
  slug: string;
  baseUrl: string;
  dataPolicy: {
    training: boolean;
    trainingOpenRouter?: boolean;
    retainsPrompts: boolean;
    canPublish: boolean;
    termsOfServiceURL?: string;
    privacyPolicyURL?: string;
    requiresUserIDs?: boolean;
    retentionDays?: number;
  };
  headquarters?: string;
  datacenters?: string[];
  hasChatCompletions: boolean;
  hasCompletions: boolean;
  isAbortable: boolean;
  moderationRequired: boolean;
  editors: string[];
  owners: string[];
  adapterName: string;
  isMultipartSupported?: boolean;
  statusPageUrl: string | null;
  byokEnabled: boolean;
  icon?: {
    url: string;
    className?: string;
  };
  ignoredProviderModels: string[];
  models: OpenRouterModel[];
}

export interface ProviderSelection {
  /**
   * The slug of the selected provider
   */
  slug: string;
  /**
   * The slugs of the selected models within the provider.
   * When a user selects a provider, all models within that provider will
   * also be selected. They can deselect models if they wish and this list
   * will reflect that. We use model slugs for identification.
   *
   * Special case: A wildcard model can be specified as "provider/*" to allow
   * all current and future models from that provider.
   */
  models: string[];
}

/**
 * Get the wildcard model slug for a provider
 * @param providerSlug The provider slug (e.g., "anthropic")
 * @returns The wildcard model slug (e.g., "anthropic/*")
 */
export function getWildcardModel(providerSlug: string): string {
  return `${providerSlug}/*`;
}

/**
 * Check if a provider selection has the wildcard model enabled
 * @param selection The provider selection to check
 * @returns true if the wildcard model is present in the models array
 */
export function hasWildcard(selection: ProviderSelection): boolean {
  return selection.models.includes(getWildcardModel(selection.slug));
}

export const INITIAL_FILTER_STATE: FilterState = {
  search: '',
  inputModalities: [],
  outputModalities: [],
  contextLengthMin: 0,
  contextLengthMax: 2000000,
  promptPricingMin: 0,
  promptPricingMax: 0.01,
  series: [],
  categories: [],
  supportedParameters: [],
  providers: [],
  providerLocations: [],
  training: 'all',
  retainsPrompts: 'all',
  canPublish: 'all',
  showFreeOnly: false,
  sortBySelected: false,
};

export const SERIES_OPTIONS = [
  'GPT',
  'Claude',
  'Gemini',
  'Grok',
  'Cohere',
  'Nova',
  'Qwen',
  'Yi',
  'DeepSeek',
  'Mistral',
  'Llama2',
  'Llama3',
  'Llama4',
  'RWKV',
  'Qwen3',
  'Router',
  'Media',
  'Other',
  'PaLM',
];

export const CATEGORY_OPTIONS = [
  'Programming',
  'Roleplay',
  'Marketing',
  'Marketing/Seo',
  'Technology',
  'Science',
  'Translation',
  'Legal',
  'Finance',
  'Health',
  'Trivia',
  'Academia',
];

// Country code to full name mapping
export const COUNTRY_NAMES: Record<string, string> = {
  US: 'United States',
  CA: 'Canada',
  GB: 'United Kingdom',
  UK: 'United Kingdom',
  FR: 'France',
  DE: 'Germany',
  JP: 'Japan',
  CN: 'China',
  KR: 'South Korea',
  IN: 'India',
  AU: 'Australia',
  NL: 'Netherlands',
  SE: 'Sweden',
  NO: 'Norway',
  DK: 'Denmark',
  FI: 'Finland',
  CH: 'Switzerland',
  AT: 'Austria',
  BE: 'Belgium',
  IT: 'Italy',
  ES: 'Spain',
  PT: 'Portugal',
  IE: 'Ireland',
  IL: 'Israel',
  SG: 'Singapore',
  HK: 'Hong Kong',
  TW: 'Taiwan',
  BR: 'Brazil',
  MX: 'Mexico',
  AR: 'Argentina',
  CL: 'Chile',
  CO: 'Colombia',
  PE: 'Peru',
  RU: 'Russia',
  UA: 'Ukraine',
  PL: 'Poland',
  CZ: 'Czech Republic',
  HU: 'Hungary',
  RO: 'Romania',
  BG: 'Bulgaria',
  HR: 'Croatia',
  SI: 'Slovenia',
  SK: 'Slovakia',
  LT: 'Lithuania',
  LV: 'Latvia',
  EE: 'Estonia',
  TR: 'Turkey',
  GR: 'Greece',
  CY: 'Cyprus',
  MT: 'Malta',
  LU: 'Luxembourg',
  IS: 'Iceland',
  LI: 'Liechtenstein',
  MC: 'Monaco',
  SM: 'San Marino',
  VA: 'Vatican City',
  AD: 'Andorra',
  ZA: 'South Africa',
  EG: 'Egypt',
  MA: 'Morocco',
  TN: 'Tunisia',
  DZ: 'Algeria',
  LY: 'Libya',
  SD: 'Sudan',
  ET: 'Ethiopia',
  KE: 'Kenya',
  UG: 'Uganda',
  TZ: 'Tanzania',
  RW: 'Rwanda',
  GH: 'Ghana',
  NG: 'Nigeria',
  SN: 'Senegal',
  CI: 'Ivory Coast',
  ML: 'Mali',
  BF: 'Burkina Faso',
  NE: 'Niger',
  TD: 'Chad',
  CM: 'Cameroon',
  CF: 'Central African Republic',
  GA: 'Gabon',
  CG: 'Republic of the Congo',
  CD: 'Democratic Republic of the Congo',
  AO: 'Angola',
  ZM: 'Zambia',
  ZW: 'Zimbabwe',
  BW: 'Botswana',
  NA: 'Namibia',
  SZ: 'Eswatini',
  LS: 'Lesotho',
  MG: 'Madagascar',
  MU: 'Mauritius',
  SC: 'Seychelles',
  KM: 'Comoros',
  DJ: 'Djibouti',
  SO: 'Somalia',
  ER: 'Eritrea',
};

export function getCountryDisplayName(code: string): string {
  return COUNTRY_NAMES[code.toUpperCase()] || code;
}

export function formatPrice(price: string): string {
  const num = parseFloat(price);
  if (num === 0) return 'Free';
  if (num < 0.000001) return `$${(num * 1000000).toFixed(2)}/1M tokens`;
  if (num < 0.001) return `$${(num * 1000).toFixed(2)}/1K tokens`;
  return `$${num.toFixed(6)}/token`;
}

export function formatContextLength(length: number | null | undefined): string {
  if (length == null || isNaN(length)) return 'N/A';
  if (length >= 1000000) return `${(length / 1000000).toFixed(1)}M`;
  if (length >= 1000) return `${(length / 1000).toFixed(0)}K`;
  return length.toString();
}

export function getModelSeries(model: OpenRouterModel): string {
  const group = model.group?.toLowerCase() || '';
  const name = model.name.toLowerCase();

  if (group.includes('gpt') || name.includes('gpt')) return 'GPT';
  if (group.includes('claude') || name.includes('claude')) return 'Claude';
  if (group.includes('gemini') || name.includes('gemini')) return 'Gemini';
  if (group.includes('grok') || name.includes('grok')) return 'Grok';
  if (group.includes('cohere') || name.includes('cohere')) return 'Cohere';
  if (group.includes('nova') || name.includes('nova')) return 'Nova';
  if (group.includes('qwen') || name.includes('qwen')) return 'Qwen';
  if (group.includes('yi') || name.includes('yi')) return 'Yi';
  if (group.includes('deepseek') || name.includes('deepseek')) return 'DeepSeek';
  if (group.includes('mistral') || name.includes('mistral')) return 'Mistral';
  if (group.includes('llama2') || name.includes('llama-2')) return 'Llama2';
  if (group.includes('llama3') || name.includes('llama-3')) return 'Llama3';
  if (group.includes('llama4') || name.includes('llama-4')) return 'Llama4';
  if (group.includes('rwkv') || name.includes('rwkv')) return 'RWKV';
  if (group.includes('palm') || name.includes('palm')) return 'PaLM';
  if (name.includes('router')) return 'Router';
  if (name.includes('media')) return 'Media';

  return 'Other';
}
