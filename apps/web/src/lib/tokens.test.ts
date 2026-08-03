import { describe, test, expect } from '@jest/globals';
import { TOKEN_EXPIRY } from './tokens';

describe('TOKEN_EXPIRY', () => {
  test('default is five years in seconds', () => {
    const FIVE_YEARS_IN_SECONDS = 5 * 365 * 24 * 60 * 60;
    expect(TOKEN_EXPIRY.default).toBe(FIVE_YEARS_IN_SECONDS);
  });
});
