import * as z from 'zod';

export const OpenRouterInferenceProviderIdSchema = z.enum([
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

export const VercelNonUserByokInferenceProviderIdSchema = z.enum(['bedrock', 'vertex']);

export const VercelInferenceProviderIdSchema = VercelUserByokInferenceProviderIdSchema.or(
  VercelNonUserByokInferenceProviderIdSchema
);

export type OpenRouterInferenceProviderId = z.infer<typeof OpenRouterInferenceProviderIdSchema>;

export type VercelInferenceProviderId = z.infer<typeof VercelInferenceProviderIdSchema>;

const openRouterToVercelInferenceProviderMapping = {
  [OpenRouterInferenceProviderIdSchema.enum['amazon-bedrock']]:
    VercelNonUserByokInferenceProviderIdSchema.enum.bedrock,
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
  'x-ai': VercelUserByokInferenceProviderIdSchema.enum.xai,
  'z-ai': VercelUserByokInferenceProviderIdSchema.enum.zai,
} as Record<string, VercelUserByokInferenceProviderId | undefined>;

export function inferUserByokProviderForModel(model: string): UserByokProviderId | null {
  return model.startsWith('mistralai/codestral')
    ? AutocompleteUserByokProviderIdSchema.enum.codestral
    : inferVercelFirstPartyInferenceProviderForModel(model);
}

export function inferVercelFirstPartyInferenceProviderForModel(
  model: string
): VercelUserByokInferenceProviderId | null {
  return model.startsWith('openai/gpt-oss')
    ? null
    : (modelPrefixToVercelInferenceProviderMapping[model.split('/')[0]] ?? null);
}
