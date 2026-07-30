import { getTrustedClientIp } from './client-ip';

describe('getTrustedClientIp', () => {
  it('uses the first IP supplied by the trusted Vercel header', () => {
    const headers = new Headers({
      'x-vercel-forwarded-for': '203.0.113.10, 10.0.0.1',
    });

    expect(getTrustedClientIp(headers)).toBe('203.0.113.10');
  });

  it('does not trust a generic forwarded header', () => {
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.10' });

    expect(getTrustedClientIp(headers)).toBeNull();
  });
});
