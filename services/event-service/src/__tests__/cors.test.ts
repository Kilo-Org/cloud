import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { app } from '../index';

describe('event-service CORS', () => {
  it('allows local web clients to preflight and call auth check', async () => {
    const origin = 'http://localhost:3000';

    const options = await app.request(
      '/auth/check',
      {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization',
        },
      },
      env
    );
    expect(options.headers.get('access-control-allow-origin')).toBe(origin);

    const get = await app.request('/auth/check', { headers: { origin } }, env);
    expect(get.status).toBe(401);
    expect(get.headers.get('access-control-allow-origin')).toBe(origin);
  });
});
