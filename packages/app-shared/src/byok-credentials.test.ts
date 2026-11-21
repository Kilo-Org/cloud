import { describe, expect, it } from 'vitest';

import {
  checkStructuredCredential,
  getStructuredCredentialKind,
  validateStructuredCredential,
} from './byok-credentials';

describe('structured credentials', () => {
  it.each([
    ['azure', 'azure'],
    ['bedrock', 'bedrock'],
    ['bedrock-byok', 'bedrock'],
    ['vertex', 'vertex'],
    ['vertex-byok', 'vertex'],
  ] as const)('maps %s to %s JSON credentials', (providerId, kind) => {
    expect(getStructuredCredentialKind(providerId)).toBe(kind);
  });

  it.each(['anthropic', 'cohere', 'openai', 'codestral', ''])(
    'uses a single API key for %j',
    providerId => {
      expect(getStructuredCredentialKind(providerId)).toBeNull();
    }
  );

  it('accepts a single API key for any non-structured provider', () => {
    expect(validateStructuredCredential('anthropic', 'sk-test')).toBeNull();
    expect(validateStructuredCredential('anthropic', { apiKey: '' })).toBeNull();
  });
});

describe('validateStructuredCredential', () => {
  it('accepts an Azure key with its resource name', () => {
    expect(validateStructuredCredential('azure', { apiKey: 'k', resourceName: 'r' })).toBeNull();
  });

  it('accepts Azure model mappings, and names a broken one', () => {
    expect(
      validateStructuredCredential('azure', {
        apiKey: 'k',
        resourceName: 'r',
        modelMappings: [{ gatewayModelSlug: 'anthropic/claude', customModelId: 'deployment' }],
      })
    ).toBeNull();
    expect(
      validateStructuredCredential('azure', {
        apiKey: 'k',
        resourceName: 'r',
        modelMappings: [{ gatewayModelSlug: 'anthropic/claude' }],
      })
    ).toEqual({ code: 'invalid-model-mapping' });
  });

  it.each([
    ['apiKey', { resourceName: 'r' }],
    ['resourceName', { apiKey: 'k' }],
    ['apiKey', { apiKey: '   ', resourceName: 'r' }],
  ] as const)('names the Azure field %s is missing from', (field, credential) => {
    expect(validateStructuredCredential('azure', credential)).toEqual({
      code: 'missing-field',
      field,
    });
  });

  it('accepts either Bedrock authentication method', () => {
    expect(
      validateStructuredCredential('bedrock', { apiKey: 'k', region: 'us-east-1' })
    ).toBeNull();
    expect(
      validateStructuredCredential('bedrock', {
        accessKeyId: 'id',
        secretAccessKey: 'secret',
        region: 'us-east-1',
      })
    ).toBeNull();
  });

  it.each([
    ['both methods', { apiKey: 'k', region: 'us-east-1', accessKeyId: 'id', secretAccessKey: 's' }],
    ['neither method', { region: 'us-east-1' }],
    ['no region', { apiKey: 'k' }],
  ])('refuses Bedrock with %s', (_case, credential) => {
    expect(validateStructuredCredential('bedrock', credential)).toEqual({ code: 'invalid-auth' });
  });

  it('applies the same Bedrock rule to the direct provider id', () => {
    expect(
      validateStructuredCredential('bedrock-byok', { apiKey: 'k', region: 'us-east-1' })
    ).toBeNull();
    expect(validateStructuredCredential('bedrock-byok', { region: 'us-east-1' })).toEqual({
      code: 'invalid-auth',
    });
  });

  it('accepts a Vertex service account and names the missing part', () => {
    expect(
      validateStructuredCredential('vertex', {
        project: 'p',
        location: 'global',
        googleCredentials: { clientEmail: 'a@b', privateKey: 'pem' },
      })
    ).toBeNull();
    expect(
      validateStructuredCredential('vertex', {
        project: 'p',
        location: 'global',
        googleCredentials: { clientEmail: 'a@b' },
      })
    ).toEqual({ code: 'missing-field', field: 'googleCredentials.privateKey' });
  });

  it('reports a credential that is not an object as its own shape problem', () => {
    expect(checkStructuredCredential('azure', 'sk-test')).toMatchObject({
      ok: false,
      problem: { code: 'not-an-object' },
    });
  });
});
