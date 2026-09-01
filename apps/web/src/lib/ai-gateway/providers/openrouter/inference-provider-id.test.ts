import {
  BedrockCredentialsSchema,
  DirectUserByokInferenceProviderIdSchema,
  getVercelUserByokProviderIdForEndpoint,
  normalizeVercelInferenceProviderIdForRouting,
  openRouterToVercelInferenceProviderId,
  OpenRouterInferenceProviderIdSchema,
  VercelInferenceProviderIdSchema,
  VercelNonUserByokInferenceProviderIdSchema,
  VercelUserByokInferenceProviderIdSchema,
} from './inference-provider-id';

describe('BedrockCredentialsSchema', () => {
  test.each([
    { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret', region: 'us-east-1' },
    { apiKey: 'bedrock-api-key', region: 'eu-west-1' },
  ])('accepts Bedrock credentials: %j', credentials => {
    expect(BedrockCredentialsSchema.parse(credentials)).toEqual(credentials);
  });

  test.each([
    null,
    'bedrock-api-key',
    {},
    { region: 'us-east-1' },
    { apiKey: 'bedrock-api-key' },
    { apiKey: '', region: 'us-east-1' },
    { apiKey: '   ', region: 'us-east-1' },
    { apiKey: 123, region: 'us-east-1' },
    { apiKey: 'bedrock-api-key', region: '' },
    { apiKey: 'bedrock-api-key', region: '   ' },
    { apiKey: 'bedrock-api-key', region: 123 },
    { apiKey: 'bedrock-api-key', region: 'us-east-1', accessKeyId: 'AKIAEXAMPLE' },
    { apiKey: 'bedrock-api-key', region: 'us-east-1', secretAccessKey: 'secret' },
    {
      apiKey: 'bedrock-api-key',
      region: 'us-east-1',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'secret',
    },
    { accessKeyId: 'AKIAEXAMPLE', region: 'us-east-1' },
  ])('rejects incomplete, invalid, or mixed credentials: %j', credentials => {
    expect(BedrockCredentialsSchema.safeParse(credentials).success).toBe(false);
  });
});

describe('inference provider ids', () => {
  test('direct BYOK provider ids do not overlap with OpenRouter provider ids', () => {
    const overlappingProviderIds = DirectUserByokInferenceProviderIdSchema.options.filter(
      providerId => OpenRouterInferenceProviderIdSchema.safeParse(providerId).success
    );

    expect(overlappingProviderIds).toEqual([]);
  });

  test('direct BYOK provider ids do not overlap with known Vercel provider ids', () => {
    const overlappingProviderIds = DirectUserByokInferenceProviderIdSchema.options.filter(
      providerId => VercelInferenceProviderIdSchema.safeParse(providerId).success
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
