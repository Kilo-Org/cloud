import type { UtsEnvironment } from '@kilocode/uts-contracts';
import { describe, expect, it } from 'vitest';
import { clientReturnOrigin } from '../../src/signin/form-action';

/**
 * The client origin a sign-in page's `form-action` names: only the registered callback origin of
 * the web client's authorization request in `returnTo`, checked the way `/authorize` checks it.
 */

const CALLBACKS: Record<UtsEnvironment, string> = {
  production: 'https://app.kilo.ai/api/auth/uts/callback',
  staging: 'https://staging-app.kilo.ai/api/auth/uts/callback',
  development: 'http://localhost:3000/api/auth/uts/callback',
};

function authorizePath(params: readonly (readonly [string, string])[]): string {
  const search = new URLSearchParams();
  for (const [name, value] of params) search.append(name, value);
  return `/authorize?${search.toString()}`;
}

function webRequest(redirectUri: string, extra: readonly (readonly [string, string])[] = []) {
  return authorizePath([
    ['client_id', 'kilo-web'],
    ['redirect_uri', redirectUri],
    ['response_type', 'code'],
    ['state', 's-1'],
    ...extra,
  ]);
}

describe('clientReturnOrigin', () => {
  it.each([
    ['production', 'https://app.kilo.ai'],
    ['staging', 'https://staging-app.kilo.ai'],
    ['development', 'http://localhost:3000'],
  ] as const)(
    'gives the registered callback origin of a %s web client request',
    (environment, origin) => {
      expect(clientReturnOrigin(webRequest(CALLBACKS[environment]), environment)).toBe(origin);
    }
  );

  it.each([
    ['another origin', 'https://evil.example/api/auth/uts/callback'],
    ['another path on the registered origin', 'https://app.kilo.ai/api/auth/uts/other'],
    ['a trailing slash', 'https://app.kilo.ai/api/auth/uts/callback/'],
    ['a query', 'https://app.kilo.ai/api/auth/uts/callback?next=https://evil.example'],
    ['another environment callback', CALLBACKS.staging],
    ['the development callback', CALLBACKS.development],
  ])('gives null for a redirect URI that is not registered: %s', (_name, redirectUri) => {
    expect(clientReturnOrigin(webRequest(redirectUri), 'production')).toBeNull();
  });

  it('gives null for a staging or development request whose callback is not registered there', () => {
    expect(clientReturnOrigin(webRequest(CALLBACKS.production), 'staging')).toBeNull();
    expect(clientReturnOrigin(webRequest(CALLBACKS.production), 'development')).toBeNull();
  });

  it('gives null when client_id or redirect_uri is missing or repeated', () => {
    const callback = CALLBACKS.production;
    for (const params of [
      [['redirect_uri', callback]],
      [['client_id', 'kilo-web']],
      [
        ['client_id', 'kilo-web'],
        ['client_id', 'kilo-web'],
        ['redirect_uri', callback],
      ],
      [
        ['client_id', 'kilo-web'],
        ['redirect_uri', callback],
        ['redirect_uri', 'https://evil.example/api/auth/uts/callback'],
      ],
    ] as const) {
      expect(clientReturnOrigin(authorizePath(params), 'production')).toBeNull();
    }
  });

  it('gives null for every client but the web client', () => {
    // A native client always shows the confirm page, and a third-party client the consent page.
    for (const [clientId, redirectUri] of [
      ['kilo-cli', 'http://127.0.0.1:4100/callback'],
      ['kilo-mobile', 'com.kilocode.kiloapp:/oauth/callback'],
      ['https://client.example.com/metadata', 'https://client.example.com/callback'],
      ['unknown-client', CALLBACKS.production],
    ] as const) {
      const returnTo = authorizePath([
        ['client_id', clientId],
        ['redirect_uri', redirectUri],
      ]);
      expect(clientReturnOrigin(returnTo, 'production')).toBeNull();
      expect(clientReturnOrigin(returnTo, 'development')).toBeNull();
    }
  });

  it('gives null without an authorization request', () => {
    const query = new URLSearchParams([
      ['client_id', 'kilo-web'],
      ['redirect_uri', CALLBACKS.production],
    ]).toString();
    for (const returnTo of [
      null,
      '/signin/done',
      `/device?${query}`,
      `/authorize/other?${query}`,
      `//evil.example/authorize?${query}`,
      `https://evil.example/authorize?${query}`,
    ]) {
      expect(clientReturnOrigin(returnTo, 'production')).toBeNull();
    }
  });
});
