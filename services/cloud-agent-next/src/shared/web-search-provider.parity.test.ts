import { describe, expect, it } from 'vitest';
import { webSearchPreferenceSchema as profilePreferenceSchema } from '@kilocode/cloud-agent-profile';
import { webSearchPreferenceSchema, webSearchProviderSchema } from './web-search-provider.js';

describe('web search preference parity', () => {
  it('accepts and rejects the same values on both sides', () => {
    const cases: unknown[] = [
      'default',
      'off',
      ...webSearchProviderSchema.options,
      'retired-provider',
      'Exa',
      '',
      undefined,
      null,
    ];
    for (const value of cases) {
      const profile = profilePreferenceSchema.safeParse(value);
      const runtime = webSearchPreferenceSchema.safeParse(value);
      expect(profile.success).toBe(runtime.success);
      if (profile.success && runtime.success) expect(profile.data).toBe(runtime.data);
    }
  });
});
