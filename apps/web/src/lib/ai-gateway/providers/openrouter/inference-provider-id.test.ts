import {
  DirectUserByokInferenceProviderIdSchema,
  getVercelUserByokProviderIdForEndpoint,
  KnownVercelInferenceProviderIdSchema,
  normalizeVercelInferenceProviderIdForRouting,
  openRouterToVercelInferenceProviderId,
  OpenRouterInferenceProviderIdSchema,
  VercelNonUserByokInferenceProviderIdSchema,
  VercelUserByokInferenceProviderIdSchema,
} from './inference-provider-id';

describe('inference provider ids', () => {
  test('direct BYOK provider ids do not overlap with OpenRouter provider ids', () => {
    const overlappingProviderIds = DirectUserByokInferenceProviderIdSchema.options.filter(
      providerId => OpenRouterInferenceProviderIdSchema.safeParse(providerId).success
    );

    expect(overlappingProviderIds).toEqual([]);
  });

  test('direct BYOK provider ids do not overlap with known Vercel provider ids', () => {
    const overlappingProviderIds = DirectUserByokInferenceProviderIdSchema.options.filter(
      providerId => KnownVercelInferenceProviderIdSchema.safeParse(providerId).success
    );

    expect(overlappingProviderIds).toEqual([]);
  });

  test('maps the OpenRouter Claude AWS provider to its Vercel provider id', () => {
    expect(openRouterToVercelInferenceProviderId('claude-on-aws')).toBe('claudeaws');
  });

  test('preserves provider ids that are not in the known provider registry', () => {
    expect(openRouterToVercelInferenceProviderId('future-provider')).toBe('future-provider');
    expect(normalizeVercelInferenceProviderIdForRouting('future-provider')).toBe('future-provider');
  });

  test('promotes Vertex to a user BYOK provider', () => {
    expect(VercelUserByokInferenceProviderIdSchema.safeParse('vertex').success).toBe(true);
    expect(VercelNonUserByokInferenceProviderIdSchema.safeParse('vertex').success).toBe(false);
    expect(openRouterToVercelInferenceProviderId('google-vertex')).toBe('vertex');
  });

  test('uses the Vertex user key for Vertex Anthropic endpoints', () => {
    expect(normalizeVercelInferenceProviderIdForRouting('vertexAnthropic')).toBe('vertex');
    expect(getVercelUserByokProviderIdForEndpoint('vertexAnthropic')).toBe('vertex');
    expect(getVercelUserByokProviderIdForEndpoint('vertex')).toBe('vertex');
    expect(getVercelUserByokProviderIdForEndpoint('unsupported')).toBeUndefined();
  });
});
