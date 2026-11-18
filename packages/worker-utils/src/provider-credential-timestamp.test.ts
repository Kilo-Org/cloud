import { describe, expect, it } from 'vitest';

import { ProviderCredentialTimestampSchema } from './provider-credential-timestamp';

describe('ProviderCredentialTimestampSchema', () => {
  it.each([
    '2026-04-29T01:16:12.945Z',
    '2026-04-29T01:16:12+02:00',
    '2026-04-29 01:16:12.945+00',
    '2026-04-29 01:16:12+00:00',
    '2026-04-29 01:16:12+0530',
    '2026-04-29 01:16:12-07',
  ])('accepts %s', value => {
    expect(ProviderCredentialTimestampSchema.safeParse(value).success).toBe(true);
  });

  it.each(['2026-04-29', '2026-04-29 01:16:12', '2026-04-29T01:16:12', '', 'not a timestamp'])(
    'rejects %s',
    value => {
      expect(ProviderCredentialTimestampSchema.safeParse(value).success).toBe(false);
    }
  );

  it('reports the shared message for a rejected timestamp', () => {
    const result = ProviderCredentialTimestampSchema.safeParse('not a timestamp');

    expect(result.error?.issues.map(issue => issue.message)).toEqual([
      'Invalid credential timestamp',
    ]);
  });
});
