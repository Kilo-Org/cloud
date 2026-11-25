import { afterEach, describe, expect, it } from 'vitest';
import { VERCEL_OIDC_TOKEN_HEADER, vercelIdentityToken } from '../src/vercel-identity-token';

const originalToken = process.env.VERCEL_OIDC_TOKEN;

afterEach(() => {
  if (originalToken === undefined) delete process.env.VERCEL_OIDC_TOKEN;
  else process.env.VERCEL_OIDC_TOKEN = originalToken;
});

describe('vercelIdentityToken', () => {
  it('reads the token Vercel attaches to the request', () => {
    delete process.env.VERCEL_OIDC_TOKEN;
    const request = new Request('https://app.kilo.ai/api/probe', {
      headers: { [VERCEL_OIDC_TOKEN_HEADER]: ' header-token ' },
    });

    expect(VERCEL_OIDC_TOKEN_HEADER).toBe('x-vercel-oidc-token');
    expect(vercelIdentityToken(request)).toBe('header-token');
  });

  it('falls back to the local development token', () => {
    process.env.VERCEL_OIDC_TOKEN = 'env-token';
    expect(vercelIdentityToken(new Request('http://localhost:3000/api/probe'))).toBe('env-token');
  });

  it('prefers the request header over the local token', () => {
    process.env.VERCEL_OIDC_TOKEN = 'env-token';
    const request = new Request('http://localhost:3000/api/probe', {
      headers: { [VERCEL_OIDC_TOKEN_HEADER]: 'header-token' },
    });

    expect(vercelIdentityToken(request)).toBe('header-token');
  });

  it('returns undefined when neither source carries a token', () => {
    delete process.env.VERCEL_OIDC_TOKEN;
    expect(vercelIdentityToken(new Request('http://localhost:3000/api/probe'))).toBeUndefined();
  });
});
