import * as z from 'zod';
import { GoogleServiceAccountSigningKeySchema } from '@kilocode/db/schema-types';

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
  'claude-on-aws',
  'cloudflare',
  'cohere',
  'coreweave',
  'crusoe',
  'darkbloom',
  'decart',
  'deepinfra',
  'deepseek',
  'digitalocean',
  'fireworks',
  'friendli',
  'gmicloud',
  'google-ai-studio',
  'google-vertex',
  'groq',
  'inception',
  'inceptron',
  'io-net',
  'ionstream',
  'longcat',
  'mancer',
  'mara',
  'meta',
  'minimax',
  'mistral',
  'modal',
  'modelrun',
  'moonshotai',
  'morph',
  'nebius',
  'nex-agi',
  'nextbit',
  'novita',
  'nvidia',
  'open-inference',
  'openai',
  'parasail',
  'perceptron',
  'perplexity',
  'phala',
  'poolside',
  // Not an OpenRouter provider: only Vercel AI Gateway serves reflection/beam-free.
  // OpenRouter offers Beam only as a paid model through third-party providers.
  'reflection',
  'reka',
  'relace',
  'sail-research',
  'sakana',
  'sambanova',
  'sambanova-turbo',
  'seed',
  'siliconflow',
  'stealth',
  'stepfun',
  'streamlake',
  'tencent',
  'together',
  'upstage',
  'venice',
  'wafer',
  'xai',
  'xiaomi',
  'z-ai',
]);

export const VercelUserByokInferenceProviderIdSchema = z.enum([
  'anthropic',
  'azure',
  'bedrock',
  'deepseek',
  'fireworks',
  'gmicloud',
  'google', // Google AI Studio
  'inception',
  'openai',
  'minimax',
  'mistral',
  'moonshotai',
  'nebius',
  'novita',
  'perplexity',
  'vertex',
  'xai',
  'xiaomi',
  'zai',
]);

export type VercelUserByokInferenceProviderId = z.infer<
  typeof VercelUserByokInferenceProviderIdSchema
>;

export const DirectUserByokInferenceProviderIdSchema = z.enum([
  'alibaba-token-plan',
  'bedrock-byok',
  'byteplus-coding',
  'chutes-byok',
  'codestral',
  'edenai',
  'inceptron-byok',
  'kimi-coding',
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
]);

/**
 * Direct BYOK providers in proof of concept. Keys for them can only be added
 * where `isExperimentalByokEnabled` allows it.
 */
export const ExperimentalByokProviderIdSchema = DirectUserByokInferenceProviderIdSchema.extract([
  'bedrock-byok',
  'vertex-byok',
]);

export type ExperimentalByokProviderId = z.infer<typeof ExperimentalByokProviderIdSchema>;

export function isExperimentalByokProviderId(
  providerId: string
): providerId is ExperimentalByokProviderId {
  return ExperimentalByokProviderIdSchema.safeParse(providerId).success;
}

export type DirectUserByokInferenceProviderId = z.infer<
  typeof DirectUserByokInferenceProviderIdSchema
>;

/**
 * Keys for a whole gateway rather than one inference provider. They serve the
 * regular catalog models under their regular ids, ordered by preference: when a
 * user has both, the Vercel AI Gateway key wins for models Vercel can serve.
 */
export const GatewayUserByokProviderIdSchema = z.enum(['vercel-ai-gateway', 'openrouter']);

export type GatewayUserByokProviderId = z.infer<typeof GatewayUserByokProviderIdSchema>;

export function isGatewayUserByokProviderId(
  providerId: string
): providerId is GatewayUserByokProviderId {
  return GatewayUserByokProviderIdSchema.safeParse(providerId).success;
}

export const UserByokProviderIdSchema = VercelUserByokInferenceProviderIdSchema.or(
  DirectUserByokInferenceProviderIdSchema
).or(GatewayUserByokProviderIdSchema);

export type UserByokProviderId = z.infer<typeof UserByokProviderIdSchema>;

export const UserByokTestModels = {
  [VercelUserByokInferenceProviderIdSchema.enum.anthropic]: 'anthropic/claude-haiku-4.5',
  [VercelUserByokInferenceProviderIdSchema.enum.azure]: 'openai/gpt-5.4-nano',
  [VercelUserByokInferenceProviderIdSchema.enum.bedrock]: 'anthropic/claude-haiku-4.5',
  [VercelUserByokInferenceProviderIdSchema.enum.deepseek]: 'deepseek/deepseek-v3.2',
  [VercelUserByokInferenceProviderIdSchema.enum.fireworks]: 'openai/gpt-oss-20b',
  [VercelUserByokInferenceProviderIdSchema.enum.gmicloud]: 'zai/glm-5.3-flash',
  [VercelUserByokInferenceProviderIdSchema.enum.inception]: 'inception/mercury-2',
  [VercelUserByokInferenceProviderIdSchema.enum.moonshotai]: 'moonshotai/kimi-k2.5',
  [VercelUserByokInferenceProviderIdSchema.enum.nebius]: 'openai/gpt-oss-120b',
  [VercelUserByokInferenceProviderIdSchema.enum.novita]: 'openai/gpt-oss-20b',
  [VercelUserByokInferenceProviderIdSchema.enum.google]: 'google/gemini-2.5-flash-lite',
  [VercelUserByokInferenceProviderIdSchema.enum.minimax]: 'minimax/minimax-m2.5',
  [VercelUserByokInferenceProviderIdSchema.enum.mistral]: 'mistral/mistral-medium-3.5',
  [VercelUserByokInferenceProviderIdSchema.enum.openai]: 'openai/gpt-5-nano',
  [VercelUserByokInferenceProviderIdSchema.enum.perplexity]: 'perplexity/sonar',
  [VercelUserByokInferenceProviderIdSchema.enum.vertex]: 'google/gemini-2.5-flash-lite',
  [VercelUserByokInferenceProviderIdSchema.enum.xai]: 'spacexai/grok-4.7',
  [VercelUserByokInferenceProviderIdSchema.enum.xiaomi]: 'xiaomi/mimo-v2-flash',
  [VercelUserByokInferenceProviderIdSchema.enum.zai]: 'zai/glm-4.7-flash',
  [DirectUserByokInferenceProviderIdSchema.enum['alibaba-token-plan']]: 'deepseek-v3.2',
  [DirectUserByokInferenceProviderIdSchema.enum['bedrock-byok']]: 'openai.gpt-oss-120b-1:0',
  [DirectUserByokInferenceProviderIdSchema.enum['byteplus-coding']]: 'bytedance-seed-code',
  [DirectUserByokInferenceProviderIdSchema.enum['chutes-byok']]: 'Qwen/Qwen3-30B-A3B',
  [DirectUserByokInferenceProviderIdSchema.enum.codestral]: 'mistral/codestral',
  [DirectUserByokInferenceProviderIdSchema.enum.edenai]: 'openai/gpt-5.6-luna',
  [DirectUserByokInferenceProviderIdSchema.enum['kimi-coding']]: 'kimi-for-coding',
  [DirectUserByokInferenceProviderIdSchema.enum['inceptron-byok']]: 'moonshotai/Kimi-K2.6',
  [DirectUserByokInferenceProviderIdSchema.enum.martian]: 'google/gemini-3.5-flash',
  [DirectUserByokInferenceProviderIdSchema.enum['morph-byok']]: 'morph-qwen35-397b',
  [DirectUserByokInferenceProviderIdSchema.enum.neuralwatt]: 'Qwen/Qwen3.5-35B-A3B',
  [DirectUserByokInferenceProviderIdSchema.enum['nvidia-byok']]:
    'nvidia/nemotron-3-super-120b-a12b',
  [DirectUserByokInferenceProviderIdSchema.enum['orcarouter']]: 'google/gemini-3.6-flash',
  [DirectUserByokInferenceProviderIdSchema.enum['synthetic']]: 'hf:zai-org/GLM-5.1',
  [DirectUserByokInferenceProviderIdSchema.enum['ollama-cloud']]: 'kimi-k2.6:cloud',
  [DirectUserByokInferenceProviderIdSchema.enum['opencode-go']]: 'qwen3.7-plus',
  [DirectUserByokInferenceProviderIdSchema.enum['vertex-byok']]: 'google/gemini-3.5-flash-lite',
  [DirectUserByokInferenceProviderIdSchema.enum['xiaomi-token-plan-ams']]: 'mimo-v2-flash',
  [DirectUserByokInferenceProviderIdSchema.enum['xiaomi-token-plan-sgp']]: 'mimo-v2-flash',
  [DirectUserByokInferenceProviderIdSchema.enum['zai-coding']]: 'glm-4.7',
  [GatewayUserByokProviderIdSchema.enum['vercel-ai-gateway']]: 'openai/gpt-5-nano',
  [GatewayUserByokProviderIdSchema.enum.openrouter]: 'openai/gpt-5-nano',
} satisfies Record<UserByokProviderId, string>;

// This is a registry of provider IDs referenced explicitly in our mappings, not
// an exhaustive schema for the open-ended provider IDs returned by Vercel.
export const VercelNonUserByokInferenceProviderIdSchema = z.enum([
  'alibaba',
  'arcee-ai',
  'baseten',
  'bfl',
  'blackbox',
  'bytedance',
  'cerebras',
  'claudeaws',
  'cohere',
  'crusoe',
  'deepinfra',
  'digitalocean',
  'friendli',
  'groq',
  'interfaze',
  'klingai',
  'meta',
  'morph',
  'parasail',
  'poolside',
  'prodia',
  'quiverai',
  'recraft',
  'runware',
  'sakana',
  'sambanova',
  'stepfun',
  'streamlake',
  'togetherai',
  'vertexAnthropic',
  'voyage',
  'wafer',
]);

export const VercelInferenceProviderIdSchema = VercelUserByokInferenceProviderIdSchema.or(
  VercelNonUserByokInferenceProviderIdSchema
);

export type OpenRouterInferenceProviderId = z.infer<typeof OpenRouterInferenceProviderIdSchema>;

export type VercelInferenceProviderId = z.infer<typeof VercelInferenceProviderIdSchema>;

const openRouterToVercelInferenceProviderMapping = {
  [OpenRouterInferenceProviderIdSchema.enum['amazon-bedrock']]:
    VercelUserByokInferenceProviderIdSchema.enum.bedrock,
  [OpenRouterInferenceProviderIdSchema.enum['claude-on-aws']]:
    VercelNonUserByokInferenceProviderIdSchema.enum.claudeaws,
  [OpenRouterInferenceProviderIdSchema.enum['google-ai-studio']]:
    VercelUserByokInferenceProviderIdSchema.enum.google,
  [OpenRouterInferenceProviderIdSchema.enum['google-vertex']]:
    VercelUserByokInferenceProviderIdSchema.enum.vertex,
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

export function openRouterToVercelInferenceProviderId(providerId: string): string {
  const normalizedProviderId = normalizeInferenceProviderId(providerId);
  return openRouterToVercelInferenceProviderMapping[normalizedProviderId] ?? normalizedProviderId;
}

export function getVercelUserByokProviderIdForEndpoint(
  providerId: string | undefined
): VercelUserByokInferenceProviderId | undefined {
  return VercelUserByokInferenceProviderIdSchema.safeParse(
    normalizeVercelInferenceProviderIdForRouting(providerId)
  ).data;
}

export function normalizeVercelInferenceProviderIdForRouting(providerId: string): string;
export function normalizeVercelInferenceProviderIdForRouting(
  providerId: string | undefined
): string | undefined;
export function normalizeVercelInferenceProviderIdForRouting(providerId: string | undefined) {
  return providerId === VercelNonUserByokInferenceProviderIdSchema.enum.vertexAnthropic
    ? VercelUserByokInferenceProviderIdSchema.enum.vertex
    : providerId;
}

export const AwsCredentialsSchema = z.object({
  accessKeyId: z.string(),
  secretAccessKey: z.string(),
  region: z.string(),
});

export const BedrockCredentialsSchema = z.union([
  AwsCredentialsSchema.extend({ apiKey: z.never().optional() }),
  z.object({
    apiKey: z.string().trim().min(1),
    region: z.string().trim().min(1),
    accessKeyId: z.never().optional(),
    secretAccessKey: z.never().optional(),
  }),
]);

export type BedrockCredentials = z.infer<typeof BedrockCredentialsSchema>;

export const AzureCredentialsSchema = z.object({
  apiKey: z.string().trim().min(1),
  resourceName: z.string().trim().min(1),
  modelMappings: z
    .array(
      z.object({
        gatewayModelSlug: z.string().trim().min(1),
        customModelId: z.string().trim().min(1),
      })
    )
    .optional(),
});

export type AzureCredentials = z.infer<typeof AzureCredentialsSchema>;

export const VertexCredentialsSchema = z.object({
  project: z.string().min(1),
  location: z.string().min(1),
  googleCredentials: z.object({
    privateKey: z.string().min(1),
    clientEmail: z.string().min(1),
  }),
});

export type VertexCredentials = z.infer<typeof VertexCredentialsSchema>;

/**
 * A Google Cloud service account key file, as downloaded from the console, with
 * an optional Vertex AI `location`. Only the fields needed to sign token
 * requests and address the project are required.
 */
export const GoogleServiceAccountKeyFileSchema = GoogleServiceAccountSigningKeySchema.extend({
  type: z.literal('service_account'),
  project_id: z.string().min(1),
  location: z.string().trim().min(1).optional(),
});

/**
 * Direct Vertex AI BYOK accepts the Vercel-shaped credentials above, or a
 * service account key file with an optional `location` (default `global`).
 */
export const DirectVertexCredentialsSchema = z.union([
  VertexCredentialsSchema,
  GoogleServiceAccountKeyFileSchema,
]);

export type DirectVertexCredentials = z.infer<typeof DirectVertexCredentialsSchema>;
