import {
  DirectUserByokInferenceProviderIdSchema,
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
});
