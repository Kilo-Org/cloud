import { describe, expect, it } from '@jest/globals';
import { approximateLocation } from '@/lib/auth/sign-in-method-change-request';

describe('approximateLocation', () => {
  it('reads the Vercel geolocation headers', () => {
    const headers = new Headers({
      'x-vercel-ip-city': 'San%20Francisco',
      'x-vercel-ip-country': 'US',
    });

    expect(approximateLocation(headers)).toBe('San Francisco, US');
  });

  it('ignores the Cloudflare geolocation headers, which the client can send', () => {
    const headers = new Headers({ 'cf-ipcity': 'Springfield', 'cf-ipcountry': 'ZZ' });

    expect(approximateLocation(headers)).toBeNull();
  });
});
