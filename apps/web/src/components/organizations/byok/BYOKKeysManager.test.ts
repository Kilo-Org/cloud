import { describe, expect, it } from '@jest/globals';
import { getStructuredCredentialKind, VERCEL_BYOK_PROVIDER_NAMES } from './BYOKKeysManager';

// The personal BYOK page renders the "Sign in with ChatGPT" connection card
// above this key list, and the Add Key dialog offers these entries. The pasted
// OpenAI key therefore names the credential it holds; nothing here may read as
// the same 'OpenAI' as the ChatGPT connection card.
describe('BYOKKeysManager provider names', () => {
  it('names the pasted OpenAI entry for the credential it holds', () => {
    expect(VERCEL_BYOK_PROVIDER_NAMES.openai).toBe('OpenAI API key');
  });

  it('leaves no entry named exactly "OpenAI"', () => {
    expect(Object.values(VERCEL_BYOK_PROVIDER_NAMES)).not.toContain('OpenAI');
  });
});

describe('getStructuredCredentialKind', () => {
  it.each([
    ['azure', 'azure'],
    ['bedrock', 'bedrock'],
    ['vertex', 'vertex'],
  ] as const)('maps %s to %s JSON credentials', (providerId, kind) => {
    expect(getStructuredCredentialKind(providerId)).toBe(kind);
  });

  it.each(['anthropic', 'openai', 'codestral', ''])('uses a single API key for %j', providerId => {
    expect(getStructuredCredentialKind(providerId)).toBeNull();
  });
});
