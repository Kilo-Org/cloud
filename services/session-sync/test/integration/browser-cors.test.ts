import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { app } from '../../src/app';
import { testEnv } from '../helpers';

describe('native browser transport CORS', () => {
  it.each(['https://app.kilo.ai', 'https://kilo.ai', 'http://localhost:3000'])(
    'accepts bearer preflights from %s without credentials',
    async origin => {
      const response = await SELF.fetch('https://session-sync.test/v1/auth/exchange', {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Authorization,Content-Type',
        },
      });
      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
        'Content-Type,Authorization'
      );
      expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    }
  );
  it('rejects the local web origin outside development', async () => {
    const response = await app.request(
      'https://session-sync.test/v1/auth/exchange',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:3000',
          'Access-Control-Request-Method': 'POST',
        },
      },
      { ...testEnv, ENVIRONMENT: 'production' }
    );
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
  it('does not authorize requests or expose them to arbitrary origins', async () => {
    const response = await SELF.fetch('https://session-sync.test/v1/sessions', {
      headers: { Origin: 'https://untrusted.test' },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
  it('keeps browser authentication errors readable and retry headers exposed', async () => {
    const response = await SELF.fetch('https://session-sync.test/v1/sessions', {
      headers: { Origin: 'https://app.kilo.ai' },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.kilo.ai');
    expect(response.headers.get('Access-Control-Expose-Headers')).toBe('Retry-After');
  });
});
