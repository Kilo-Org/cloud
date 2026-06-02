import * as z from 'zod';
import { isGptOssModel } from '@/lib/ai-gateway/providers/openai';

export const OpenRouterInferenceProviderIdSchema = z.enum([
  'ai21',
  'aion-labs',
  'akashml',
  'alibaba',
  'amazon-bedrock',
  'ambient',
  'anthropic',
  'arcee-ai',
  'atlas-cloud',
  'azure',
  'baidu',
  'baseten',
  'cerebras',
  'chutes',
  'clarifai',
  'cloudflare',
  'cohere',
  'deepinfra',
  'deepseek',
  'dekallm',
  'featherless',
  'fireworks',
  'friendli',
  'gmicloud',
  'google-ai-studio',
  'google-vertex',
  'groq',
  'inception',
  'inceptron',
  'infermatic',
  'inflection',
  'io-net',
  'ionstream',
  'liquid',
  'mancer',
  'mara',
  'minimax',
  'mistral',
  'modelrun',
  'moonshotai',
  'morph',
  'nebius',
  'nextbit',
  'novita',
  'nvidia',
  'open-inference',
  'openai',
  'parasail',
  'perplexity',
  'phala',
  'poolside',
  'reka',
  'relace',
  'sambanova',
  'sambanova-turbo',
  'seed',
  'siliconflow',
  'stealth',
  'stepfun',
  'streamlake',
  'switchpoint',
  'together',
  'upstage',
  'venice',
  'wandb',
  'xai',
  'xiaomi',
  'z-ai',
]);

export const VercelUserByokInferenceProviderIdSchema = z.enum([
  'anthropic',
  'bedrock',
  'deepseek',
  'fireworks',
  'google', // Google AI Studio
  'inception',
  'openai',
  'minimax',
  'mistral',
  'moonshotai',
  'novita',
  'perplexity',
  'xai',
  'xiaomi',
  'zai',
]);

export type VercelUserByokInferenceProviderId = z.infer<
  typeof VercelUserByokInferenceProviderIdSchema
>;

export const DirectUserByokInferenceProviderIdSchema = z.enum([
  'byteplus-coding',
  'chutes-byok',
  'codestral',
  'kimi-coding',
  'neuralwatt',
  'ollama-cloud',
  'xiaomi-token-plan-ams',
  'xiaomi-token-plan-sgp',
  'zai-coding',
]);

export type DirectUserByokInferenceProviderId = z.infer<
  typeof DirectUserByokInferenceProviderIdSchema
>;

export const UserByokProviderIdSchema = VercelUserByokInferenceProviderIdSchema.or(
  DirectUserByokInferenceProviderIdSchema
);

export type UserByokProviderId = z.infer<typeof UserByokProviderIdSchema>;

export const UserByokTestModels = {
  [VercelUserByokInferenceProviderIdSchema.enum.anthropic]: 'anthropic/claude-haiku-4.5',
  [VercelUserByokInferenceProviderIdSchema.enum.bedrock]: 'anthropic/claude-haiku-4.5',
  [VercelUserByokInferenceProviderIdSchema.enum.deepseek]: 'deepseek/deepseek-v3.2',
  [VercelUserByokInferenceProviderIdSchema.enum.fireworks]: 'openai/gpt-oss-20b',
  [VercelUserByokInferenceProviderIdSchema.enum.inception]: 'inception/mercury-2',
  [VercelUserByokInferenceProviderIdSchema.enum.moonshotai]: 'moonshotai/kimi-k2.5',
  [VercelUserByokInferenceProviderIdSchema.enum.novita]: 'openai/gpt-oss-20b',
  [VercelUserByokInferenceProviderIdSchema.enum.google]: 'google/gemini-2.5-flash-lite',
  [VercelUserByokInferenceProviderIdSchema.enum.minimax]: 'minimax/minimax-m2.5',
  [VercelUserByokInferenceProviderIdSchema.enum.mistral]: 'mistral/mistral-medium-3.5',
  [VercelUserByokInferenceProviderIdSchema.enum.openai]: 'openai/gpt-5-nano',
  [VercelUserByokInferenceProviderIdSchema.enum.perplexity]: 'perplexity/sonar',
  [VercelUserByokInferenceProviderIdSchema.enum.xai]: 'xai/grok-4.1-fast-non-reasoning',
  [VercelUserByokInferenceProviderIdSchema.enum.xiaomi]: 'xiaomi/mimo-v2-flash',
  [VercelUserByokInferenceProviderIdSchema.enum.zai]: 'zai/glm-4.7-flash',
  [DirectUserByokInferenceProviderIdSchema.enum['byteplus-coding']]: 'bytedance-seed-code',
  [DirectUserByokInferenceProviderIdSchema.enum['chutes-byok']]: 'Qwen/Qwen3-30B-A3B',
  [DirectUserByokInferenceProviderIdSchema.enum.codestral]: 'mistral/codestral',
  [DirectUserByokInferenceProviderIdSchema.enum['kimi-coding']]: 'kimi-for-coding',
  [DirectUserByokInferenceProviderIdSchema.enum.neuralwatt]: 'Qwen/Qwen3.5-35B-A3B',
  [DirectUserByokInferenceProviderIdSchema.enum['ollama-cloud']]: 'kimi-k2.6:cloud',
  [DirectUserByokInferenceProviderIdSchema.enum['xiaomi-token-plan-ams']]: 'mimo-v2-flash',
  [DirectUserByokInferenceProviderIdSchema.enum['xiaomi-token-plan-sgp']]: 'mimo-v2-flash',
  [DirectUserByokInferenceProviderIdSchema.enum['zai-coding']]: 'glm-4.7',
} satisfies Record<UserByokProviderId, string>;

export const VercelNonUserByokInferenceProviderIdSchema = z.enum([
  'alibaba',
  'arcee-ai',
  'azure',
  'baseten',
  'bfl',
  'bytedance',
  'cerebras',
  'chutes',
  'cohere',
  'deepinfra',
  'groq',
  'interfaze',
  'klingai',
  'meituan',
  'morph',
  'nebius',
  'parasail',
  'prodia',
  'recraft',
  'sambanova',
  'streamlake',
  'togetherai',
  'vertex',
  'vertexAnthropic',
  'voyage',
]);

export const VercelInferenceProviderIdSchema = VercelUserByokInferenceProviderIdSchema.or(
  VercelNonUserByokInferenceProviderIdSchema
);

export type OpenRouterInferenceProviderId = z.infer<typeof OpenRouterInferenceProviderIdSchema>;

export type VercelInferenceProviderId = z.infer<typeof VercelInferenceProviderIdSchema>;

const openRouterToVercelInferenceProviderMapping = {
  [OpenRouterInferenceProviderIdSchema.enum['amazon-bedrock']]:
    VercelUserByokInferenceProviderIdSchema.enum.bedrock,
  [OpenRouterInferenceProviderIdSchema.enum['google-ai-studio']]:
    VercelUserByokInferenceProviderIdSchema.enum.google,
  [OpenRouterInferenceProviderIdSchema.enum['google-vertex']]:
    VercelNonUserByokInferenceProviderIdSchema.enum.vertex,
  [OpenRouterInferenceProviderIdSchema.enum.seed]:
    VercelNonUserByokInferenceProviderIdSchema.enum.bytedance,
  [OpenRouterInferenceProviderIdSchema.enum['z-ai']]:
    VercelUserByokInferenceProviderIdSchema.enum.zai,
  [OpenRouterInferenceProviderIdSchema.enum.together]:
    VercelNonUserByokInferenceProviderIdSchema.enum.togetherai,
} as Record<string, VercelInferenceProviderId | undefined>;

export function normalizeInferenceProviderId(providerId: string): string;
export function normalizeInferenceProviderId(providerId: string | undefined): string | undefined;
export function normalizeInferenceProviderId(providerId: string | undefined) {
  if (!providerId) return providerId;
  const slashIndex = providerId.indexOf('/');
  return (slashIndex >= 0 ? providerId.slice(0, slashIndex) : providerId).toLowerCase();
}

export function openRouterToVercelInferenceProviderId(providerId: string) {
  const normalizedProviderId = normalizeInferenceProviderId(providerId);
  return openRouterToVercelInferenceProviderMapping[normalizedProviderId] ?? normalizedProviderId;
}

const modelPrefixToVercelInferenceProviderMapping = {
  anthropic: VercelUserByokInferenceProviderIdSchema.enum.anthropic,
  google: VercelUserByokInferenceProviderIdSchema.enum.google,
  openai: VercelUserByokInferenceProviderIdSchema.enum.openai,
  minimax: VercelUserByokInferenceProviderIdSchema.enum.minimax,
  mistralai: VercelUserByokInferenceProviderIdSchema.enum.mistral,
  qwen: VercelNonUserByokInferenceProviderIdSchema.enum.alibaba,
  'x-ai': VercelUserByokInferenceProviderIdSchema.enum.xai,
  'z-ai': VercelUserByokInferenceProviderIdSchema.enum.zai,
} as Record<string, VercelInferenceProviderId | undefined>;

export function inferVercelFirstPartyInferenceProviderForModel(
  model: string
): VercelInferenceProviderId | null {
  return isGptOssModel(model)
    ? null
    : (modelPrefixToVercelInferenceProviderMapping[model.split('/')[0]] ?? null);
}

export const AwsCredentialsSchema = z.object({
  accessKeyId: z.string(),
  secretAccessKey: z.string(),
  region: z.string(),
});

export type AwsCredentials = z.infer<typeof AwsCredentialsSchema>;
