import {
  DirectUserByokInferenceProviderIdSchema,
  openRouterToVercelInferenceProviderId,
  OpenRouterInferenceProviderIdSchema,
  VercelInferenceProviderIdSchema,
} from './inference-provider-id';

describe('inference provider ids', () => {
  test('direct BYOK provider ids do not overlap with OpenRouter provider ids', () => {
    const overlappingProviderIds = DirectUserByokInferenceProviderIdSchema.options.filter(
      providerId => OpenRouterInferenceProviderIdSchema.safeParse(providerId).success
    );

    expect(overlappingProviderIds).toEqual([]);
  });

  test('direct BYOK provider ids do not overlap with Vercel provider ids', () => {
    const overlappingProviderIds = DirectUserByokInferenceProviderIdSchema.options.filter(
      providerId => VercelInferenceProviderIdSchema.safeParse(providerId).success
    );

    expect(overlappingProviderIds).toEqual([]);
  });

  test('maps the OpenRouter Claude AWS provider to its Vercel provider id', () => {
    expect(openRouterToVercelInferenceProviderId('claude-on-aws')).toBe('claudeaws');
  });
});
