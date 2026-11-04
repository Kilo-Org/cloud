import { SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';

import { app } from '../../src/app';
import { grant, personal, testEnv } from '../helpers';

it('limits exchange by IP before credential verification with a retry deadline', async () => {
  const ip = `192.0.2.${Math.floor(Math.random() * 200) + 1}`;
  let response: Response | undefined;
  for (let index = 0; index <= 120; index++) {
    response = await SELF.fetch('https://session-sync.test/v1/auth/exchange', {
      method: 'POST', headers: { 'CF-Connecting-IP': ip },
    });
    if (response.status === 429) break;
    expect(response.status).toBe(401);
  }
  expect(response!.status).toBe(429);
  expect(response!.headers.get('Retry-After')).toBe('60');
  expect(await response!.json()).toMatchObject({ error: { code: 'rate_limited', retryAt: expect.any(Number) } });
});

it('limits authenticated data requests before dispatching to the session object', async () => {
  const response = await app.request('https://session-sync.test/v1/sessions/ses_limited', {
    headers: { authorization: `Bearer ${await grant(personal('limited-user'))}` },
  }, { ...testEnv, USER_REQUEST_LIMITER: { limit: async () => ({ success: false }) } });
  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBe('60');
});
