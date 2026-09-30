import { NextResponse } from 'next/server';
import type { NextFetchEvent } from 'next/server';
import type { NextRequestWithAuth } from 'next-auth/middleware';
import { withBlockedClients } from '@/middleware/withBlockedClients';

function request(path: string, userAgent: string) {
  const url = new URL(`http://localhost:3000${path}`);
  return {
    nextUrl: url,
    headers: new Headers({ 'user-agent': userAgent }),
  } as unknown as NextRequestWithAuth;
}

describe('withBlockedClients', () => {
  const next = jest.fn(() => NextResponse.next());
  const middleware = withBlockedClients(next);
  const event = {} as NextFetchEvent;

  beforeEach(() => next.mockClear());

  it.each(['/api/fim/completions', '/api/v1/fim/completions'])(
    'blocks buggy clients on %s',
    async path => {
      const response = await middleware(request(path, 'kilo/7.1.0'), event);

      expect(response?.status).toBe(426);
      expect(next).not.toHaveBeenCalled();
    }
  );

  it('lets current clients through', async () => {
    await middleware(request('/api/v1/fim/completions', 'kilo/7.2.0'), event);

    expect(next).toHaveBeenCalled();
  });

  it('lets buggy clients reach other routes', async () => {
    await middleware(request('/api/v1/chat/completions', 'kilo/7.1.0'), event);

    expect(next).toHaveBeenCalled();
  });
});
