import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleOAuthTokenProvider } from './google-oauth-token-provider';

function createProvider() {
  return new GoogleOAuthTokenProvider({
    getApiKey: () => 'api-key',
    getGatewayToken: () => 'gateway-token',
    getSandboxId: () => 'dXNlci0x',
    getCheckinUrl: () => 'https://claw.example.com/api/controller/checkin',
    refreshSkewSeconds: 60,
  });
}

describe('GoogleOAuthTokenProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns cached tokens without refetching while token is fresh', async () => {
    const provider = createProvider();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          accessToken: 'ya29.cached',
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          accountEmail: 'user@example.com',
          scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const first = await provider.getToken(['calendar_read']);
    const second = await provider.getToken(['calendar_read']);

    expect(first.accessToken).toBe('ya29.cached');
    expect(second.accessToken).toBe('ya29.cached');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent refreshes with single-flight behavior', async () => {
    const provider = createProvider();

    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchPromise = new Promise<Response>(resolve => {
      resolveFetch = resolve as (response: Response) => void;
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockReturnValue(fetchPromise);

    const firstPromise = provider.getToken(['calendar_read']);
    const secondPromise = provider.getToken(['calendar_read']);

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const resolve = resolveFetch;
    if (!resolve) {
      throw new Error('Expected fetch resolver to be initialized');
    }

    resolve(
      new Response(
        JSON.stringify({
          accessToken: 'ya29.concurrent',
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          accountEmail: 'user@example.com',
          scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.accessToken).toBe('ya29.concurrent');
    expect(second.accessToken).toBe('ya29.concurrent');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
