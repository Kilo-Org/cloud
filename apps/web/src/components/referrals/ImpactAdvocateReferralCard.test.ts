import { describe, expect, it } from '@jest/globals';

import { buildImpactAdvocateTokenUrl } from './ImpactAdvocateReferralCard.utils';

describe('buildImpactAdvocateTokenUrl', () => {
  it('defaults to the KiloClaw Advocate token endpoint for existing callers', () => {
    expect(buildImpactAdvocateTokenUrl()).toBe('/api/impact-advocate/token');
  });

  it('requests the Kilo Pass Advocate token without falling back to KiloClaw config', () => {
    expect(buildImpactAdvocateTokenUrl('kilo_pass')).toBe(
      '/api/impact-advocate/token?product=kilo_pass'
    );
  });
});
