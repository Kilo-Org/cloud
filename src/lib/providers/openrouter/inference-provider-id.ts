import * as z from 'zod';

export const OpenRouterInferenceProviderIdSchema = z.enum([
  'alibaba',
  'amazon-bedrock',
  'anthropic',
  'arcee-ai',
  'baseten',
  'deepinfra',
  'fireworks',
  'google-ai-studio',
  'google-vertex',
  'inception',
  'moonshotai',
  'morph',
  'novita',
  'parasail',
  'xai',
  'minimax',
  'mistral',
  'seed',
  'streamlake',
  'stealth',
  'xiaomi',
  'z-ai',

  // not real OpenRouter providers
  'corethink',
]);

export const VercelUserByokInferenceProviderIdSchema = z.enum([
  'alibaba',
  'anthropic',
  'arcee-ai',
  'baseten',
  'bedrock',
  'bytedance',
  'fireworks',
  'google', // Google AI Studio
  'inception',
  'minimax',
  'mistral',
  'moonshotai',
  'novita',
  'openai',
  'parasail',
  'streamlake',
  'xai',
  'zai',
]);

export type VercelUserByokInferenceProviderId = z.infer<
  typeof VercelUserByokInferenceProviderIdSchema
>;

export const DirectUserByokInferenceProviderIdSchema = z.enum([
  'byteplus-coding',
  'codestral',
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
  [VercelUserByokInferenceProviderIdSchema.enum.alibaba]: 'alibaba/qwen3.5-flash',
  [VercelUserByokInferenceProviderIdSchema.enum.anthropic]: 'anthropic/claude-haiku-4.5',
  [VercelUserByokInferenceProviderIdSchema.enum['arcee-ai']]: 'arcee-ai/trinity-mini',
  [VercelUserByokInferenceProviderIdSchema.enum.baseten]: 'zai/glm-4.6',
  [VercelUserByokInferenceProviderIdSchema.enum.bedrock]: 'anthropic/claude-haiku-4.5',
  [VercelUserByokInferenceProviderIdSchema.enum.bytedance]: 'bytedance/seed-1.6',
  [VercelUserByokInferenceProviderIdSchema.enum.fireworks]: 'openai/gpt-oss-20b',
  [VercelUserByokInferenceProviderIdSchema.enum.google]: 'google/gemini-2.5-flash-lite',
  [VercelUserByokInferenceProviderIdSchema.enum.inception]: 'inception/mercury-2',
  [VercelUserByokInferenceProviderIdSchema.enum.minimax]: 'minimax/minimax-m2.5',
  [VercelUserByokInferenceProviderIdSchema.enum.mistral]: 'mistral/devstral-2',
  [VercelUserByokInferenceProviderIdSchema.enum.moonshotai]: 'moonshotai/kimi-k2',
  [VercelUserByokInferenceProviderIdSchema.enum.novita]: 'meta/llama-3.1-8b',
  [VercelUserByokInferenceProviderIdSchema.enum.openai]: 'openai/gpt-5-nano',
  [VercelUserByokInferenceProviderIdSchema.enum.parasail]: 'openai/gpt-oss-20b',
  [VercelUserByokInferenceProviderIdSchema.enum.streamlake]: 'kwaipilot/kat-coder-pro-v1',
  [VercelUserByokInferenceProviderIdSchema.enum.xai]: 'xai/grok-4.1-fast-non-reasoning',
  [VercelUserByokInferenceProviderIdSchema.enum.zai]: 'zai/glm-4.7-flash',
  [DirectUserByokInferenceProviderIdSchema.enum['byteplus-coding']]: 'bytedance-seed-code',
  [DirectUserByokInferenceProviderIdSchema.enum.codestral]: 'mistral/codestral',
  [DirectUserByokInferenceProviderIdSchema.enum['zai-coding']]: 'glm-4.7',
} satisfies Record<UserByokProviderId, string>;

export const VercelNonUserByokInferenceProviderIdSchema = z.enum(['vertex']);

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
    VercelUserByokInferenceProviderIdSchema.enum.bytedance,
  [OpenRouterInferenceProviderIdSchema.enum['z-ai']]:
    VercelUserByokInferenceProviderIdSchema.enum.zai,
} as Record<string, VercelInferenceProviderId | undefined>;

export function openRouterToVercelInferenceProviderId(providerId: string) {
  const slashIndex = providerId.indexOf('/');
  const normalizedProviderId = (
    slashIndex >= 0 ? providerId.slice(0, slashIndex) : providerId
  ).toLowerCase();
  return openRouterToVercelInferenceProviderMapping[normalizedProviderId] ?? normalizedProviderId;
}

const modelPrefixToVercelInferenceProviderMapping = {
  anthropic: VercelUserByokInferenceProviderIdSchema.enum.anthropic,
  google: VercelUserByokInferenceProviderIdSchema.enum.google,
  openai: VercelUserByokInferenceProviderIdSchema.enum.openai,
  minimax: VercelUserByokInferenceProviderIdSchema.enum.minimax,
  mistralai: VercelUserByokInferenceProviderIdSchema.enum.mistral,
  qwen: VercelUserByokInferenceProviderIdSchema.enum.alibaba,
  'x-ai': VercelUserByokInferenceProviderIdSchema.enum.xai,
  'z-ai': VercelUserByokInferenceProviderIdSchema.enum.zai,
} as Record<string, VercelInferenceProviderId | undefined>;

export function inferVercelFirstPartyInferenceProviderForModel(
  model: string
): VercelInferenceProviderId | null {
  return model.startsWith('openai/gpt-oss')
    ? null
    : (modelPrefixToVercelInferenceProviderMapping[model.split('/')[0]] ?? null);
}

export const AwsCredentialsSchema = z.object({
  accessKeyId: z.string(),
  secretAccessKey: z.string(),
  region: z.string(),
});

export type AwsCredentials = z.infer<typeof AwsCredentialsSchema>;
