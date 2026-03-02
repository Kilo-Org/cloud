import * as z from 'zod';

export const OpenRouterInferenceProviderIdSchema = z.enum([
  'alibaba',
  'amazon-bedrock',
  'anthropic',
  'arcee-ai',
  'deepinfra',
  'fireworks',
  'google-ai-studio',
  'google-vertex',
  'inception',
  'moonshotai',
  'xai',
  'minimax',
  'mistral',
  'novita',
  'streamlake',
  'stealth',
  'z-ai',

  // not real OpenRouter providers
  'corethink',
]);

export const VercelUserByokInferenceProviderIdSchema = z.enum([
  'anthropic',
  'bedrock',
  'google', // Google AI Studio
  'openai',
  'minimax',
  'mistral',
  'xai',
  'zai',
]);

export type VercelUserByokInferenceProviderId = z.infer<
  typeof VercelUserByokInferenceProviderIdSchema
>;

export const AutocompleteUserByokProviderIdSchema = z.enum(['codestral']);

export type UserByokAutocompleteProviderId = z.infer<typeof AutocompleteUserByokProviderIdSchema>;

export const UserByokProviderIdSchema = VercelUserByokInferenceProviderIdSchema.or(
  AutocompleteUserByokProviderIdSchema
);

export type UserByokProviderId = z.infer<typeof UserByokProviderIdSchema>;

export const UserByokTestModels = {
  [VercelUserByokInferenceProviderIdSchema.enum.anthropic]: 'anthropic/claude-haiku-4.5',
  [VercelUserByokInferenceProviderIdSchema.enum.bedrock]: 'anthropic/claude-haiku-4.5',
  [VercelUserByokInferenceProviderIdSchema.enum.google]: 'google/gemini-2.5-flash-lite',
  [VercelUserByokInferenceProviderIdSchema.enum.minimax]: 'minimax/minimax-m2.5',
  [VercelUserByokInferenceProviderIdSchema.enum.mistral]: 'mistral/devstral-2',
  [VercelUserByokInferenceProviderIdSchema.enum.openai]: 'openai/gpt-5-nano',
  [VercelUserByokInferenceProviderIdSchema.enum.xai]: 'xai/grok-4.1-fast-non-reasoning',
  [VercelUserByokInferenceProviderIdSchema.enum.zai]: 'zai/glm-4.7-flash',
  [AutocompleteUserByokProviderIdSchema.enum.codestral]: 'mistral/codestral',
} satisfies Record<UserByokProviderId, string>;

export const VercelNonUserByokInferenceProviderIdSchema = z.enum(['alibaba', 'vertex']);

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
  qwen: VercelNonUserByokInferenceProviderIdSchema.enum.alibaba,
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
