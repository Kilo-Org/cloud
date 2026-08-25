import { describe, expect, it } from 'vitest';

import { formatKiloPassTierDescription } from './subscription-page-copy';

describe('Kilo Pass subscription page copy', () => {
  it('describes guaranteed paid credits added monthly for each tier card', () => {
    expect(formatKiloPassTierDescription(19)).toBe(
      '$19 paid credits added monthly for Kilo App usage.'
    );
  });
});
