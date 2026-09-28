import { describe, expect, it } from 'vitest';
import { DIRECT_BYOK_PROVIDER_IDS, isDirectByokModelId } from './direct-byok-model';

describe('isDirectByokModelId', () => {
  it('matches every listed provider id', () => {
    for (const providerId of DIRECT_BYOK_PROVIDER_IDS) {
      expect(isDirectByokModelId(`${providerId}/some-model`)).toBe(true);
      expect(isDirectByokModelId(`${providerId.toUpperCase()}/Some-Model`)).toBe(true);
    }
  });

  it('rejects non-BYOK and managed model ids', () => {
    expect(isDirectByokModelId('anthropic/claude-sonnet-4.6')).toBe(false);
    expect(isDirectByokModelId('google/gemma-4-26b-a4b-it')).toBe(false);
    expect(isDirectByokModelId('kilo-auto/small')).toBe(false);
    expect(isDirectByokModelId(undefined)).toBe(false);
    expect(isDirectByokModelId(null)).toBe(false);
    expect(isDirectByokModelId('')).toBe(false);
  });

  it('matches on the provider prefix only', () => {
    // A bare provider id matches — routing only inspects the prefix.
    expect(isDirectByokModelId('synthetic')).toBe(true);
    expect(isDirectByokModelId('synthetic/hf:zai-org/GLM-5.1')).toBe(true);
    expect(isDirectByokModelId('synthetic-new/whatever')).toBe(false);
  });
});
