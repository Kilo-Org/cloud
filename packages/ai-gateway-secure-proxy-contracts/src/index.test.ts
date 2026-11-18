import { describe, expect, it } from 'vitest';
import { SECURE_PROXY_BODY_KEY, SecureProxyRequestBodySchema } from './index';

describe('SecureProxyRequestBodySchema', () => {
  it('keeps the request body next to the forward config', () => {
    const parsed = SecureProxyRequestBodySchema.parse({
      model: 'm',
      [SECURE_PROXY_BODY_KEY]: { url: 'https://llm.example.com/v1', headers: { a: 'b' } },
    });

    expect(parsed).toEqual({
      model: 'm',
      kilo_secure_proxy: { url: 'https://llm.example.com/v1', headers: { a: 'b' } },
    });
  });

  it.each([
    ['a missing config', { model: 'm' }],
    ['a non-HTTPS URL', { kilo_secure_proxy: { url: 'http://llm.example.com', headers: {} } }],
    ['missing headers', { kilo_secure_proxy: { url: 'https://llm.example.com' } }],
    [
      'non-string header values',
      { kilo_secure_proxy: { url: 'https://llm.example.com', headers: { a: 1 } } },
    ],
  ])('rejects %s', (_description, body) => {
    expect(SecureProxyRequestBodySchema.safeParse(body).success).toBe(false);
  });
});
