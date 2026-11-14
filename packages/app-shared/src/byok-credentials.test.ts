import { describe, expect, it } from 'vitest';

import { getStructuredCredentialKind, isStructuredCredentialProvider } from './byok-credentials';

describe('structured credentials', () => {
  it.each([
    ['azure', 'azure'],
    ['bedrock', 'bedrock'],
    ['bedrock-byok', 'bedrock'],
    ['vertex', 'vertex'],
    ['vertex-byok', 'vertex'],
  ] as const)('maps %s to %s JSON credentials', (providerId, kind) => {
    expect(getStructuredCredentialKind(providerId)).toBe(kind);
    expect(isStructuredCredentialProvider(providerId)).toBe(true);
  });

  it.each(['anthropic', 'cohere', 'openai', 'codestral', ''])(
    'uses a single API key for %j',
    providerId => {
      expect(getStructuredCredentialKind(providerId)).toBeNull();
      expect(isStructuredCredentialProvider(providerId)).toBe(false);
    }
  );
});
