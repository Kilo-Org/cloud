import { describe, expect, it } from 'vitest';

import { getByokUrl } from './integration-urls';

describe('getByokUrl', () => {
  it('builds personal and organization BYOK settings URLs', () => {
    expect(getByokUrl('https://app.kilo.ai')).toBe('https://app.kilo.ai/byok');
    expect(getByokUrl('https://app.kilo.ai/', 'org_123')).toBe(
      'https://app.kilo.ai/organizations/org_123/byok'
    );
  });
});
