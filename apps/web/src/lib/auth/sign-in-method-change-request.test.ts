import { describe, expect, it, jest } from '@jest/globals';

jest.mock('next/headers', () => ({ headers: jest.fn() }));

import { headers } from 'next/headers';
import {
  approximateLocation,
  currentSignInMethodChangeAuditRequest,
} from '@/lib/auth/sign-in-method-change-request';

const mockedHeaders = jest.mocked(headers);

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

describe('currentSignInMethodChangeAuditRequest', () => {
  it('reads the route that the proxy forwards', async () => {
    mockedHeaders.mockResolvedValue(
      new Headers({ 'x-pathname': '/api/auth/callback/github' }) as never
    );

    await expect(currentSignInMethodChangeAuditRequest()).resolves.toMatchObject({
      route: '/api/auth/callback/github',
    });
  });

  it('has no route outside a request scope', async () => {
    mockedHeaders.mockRejectedValue(new Error('outside a request scope'));

    await expect(currentSignInMethodChangeAuditRequest()).resolves.toEqual({ ip: null });
  });
});
