import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import type * as RouteModule from '@/app/.well-known/webauthn/route';
import { type RelatedOriginsInput, webAuthnRelatedOrigins } from './webauthn-related-origins';

jest.mock('@kilocode/web-shared/lib/constants', () => ({ APP_URL: 'https://app.kilo.ai' }));

// This repo's transform does not hoist `jest.mock` above the static imports, so the route, which
// reads the mocked `APP_URL`, is required here.
const { GET } = jest.requireActual<typeof RouteModule>('@/app/.well-known/webauthn/route');

// The UTS relying-party configuration (`services/uts/wrangler.jsonc`): each environment's
// `WEBAUTHN_RP_ID` is the app host, and its `WEBAUTHN_ORIGINS` is the issuer origin.
const UTS_PRODUCTION = { rpId: 'app.kilo.ai', origin: 'https://uts.kiloapps.io' };
const UTS_STAGING = { rpId: 'staging-app.kilo.ai', origin: 'https://uts-staging.kiloapps.io' };

const production: RelatedOriginsInput = {
  appUrl: 'https://app.kilo.ai',
  vercelEnv: 'production',
  vercelTargetEnv: 'production',
  requestHost: 'app.kilo.ai',
};

const staging: RelatedOriginsInput = {
  appUrl: 'https://staging-app.kilo.ai',
  vercelEnv: 'preview',
  vercelTargetEnv: 'staging',
  requestHost: 'staging-app.kilo.ai',
};

describe('webAuthnRelatedOrigins', () => {
  test.each([
    ['production', production, UTS_PRODUCTION],
    ['staging', staging, UTS_STAGING],
  ])('%s lists exactly its own UTS origin', (_name, input, uts) => {
    const document = webAuthnRelatedOrigins(input);

    expect(document).toEqual({ origins: [uts.origin] });
    expect(input.requestHost).toBe(uts.rpId);
  });

  test.each([
    ['production', production],
    ['staging', staging],
  ])('the %s document is a well-formed related-origins list', (_name, input) => {
    const document = webAuthnRelatedOrigins(input);
    if (!document) throw new Error('expected a document');

    expect(Object.keys(document)).toEqual(['origins']);
    expect(document.origins).toHaveLength(1);
    for (const origin of document.origins) {
      const url = new URL(origin);
      expect(url.protocol).toBe('https:');
      expect(url.origin).toBe(origin);
      expect(url.host).not.toBe(input.requestHost);
    }
    expect(JSON.parse(JSON.stringify(document))).toEqual(document);
  });

  test.each<[string, Partial<RelatedOriginsInput>]>([
    ['a preview of the production app', { vercelEnv: 'preview', vercelTargetEnv: 'preview' }],
    ['a development server', { vercelEnv: undefined, vercelTargetEnv: undefined }],
    ['Vercel development', { vercelEnv: 'development', vercelTargetEnv: 'development' }],
    ['a production build without the production target', { vercelTargetEnv: 'preview' }],
    [
      'a staging target on the production app origin',
      { vercelEnv: 'preview', vercelTargetEnv: 'staging' },
    ],
    ['production on the staging app origin', { appUrl: 'https://staging-app.kilo.ai' }],
    ['plain HTTP', { appUrl: 'http://app.kilo.ai' }],
    ['a trailing slash', { appUrl: 'https://app.kilo.ai/' }],
    ['another port', { appUrl: 'https://app.kilo.ai:8443' }],
    ['a lookalike host', { appUrl: 'https://app.kilo.ai.example' }],
    ['a local app URL', { appUrl: 'http://localhost:3000' }],
  ])('production refuses %s', (_name, override) => {
    expect(webAuthnRelatedOrigins({ ...production, ...override })).toBeNull();
  });

  test.each<[string, Partial<RelatedOriginsInput>]>([
    [
      'production on the staging app origin',
      { vercelEnv: 'production', vercelTargetEnv: 'production' },
    ],
    ['a staging build promoted to production', { vercelEnv: 'production' }],
    ['a preview', { vercelTargetEnv: 'preview' }],
    ['a development server', { vercelEnv: undefined, vercelTargetEnv: undefined }],
    ['the production app origin', { appUrl: 'https://app.kilo.ai' }],
  ])('staging refuses %s', (_name, override) => {
    expect(webAuthnRelatedOrigins({ ...staging, ...override })).toBeNull();
  });

  test.each<[string | null]>([
    [null],
    [''],
    ['staging-app.kilo.ai'],
    ['api.kilo.ai'],
    ['kilo.ai'],
    ['evil.app.kilo.ai'],
    ['app.kilo.ai.example'],
    ['app.kilo.ai:443'],
    ['APP.KILO.AI'],
    ['kilocode-app.vercel.app'],
    ['localhost:3000'],
  ])('production refuses request host %p', requestHost => {
    expect(webAuthnRelatedOrigins({ ...production, requestHost })).toBeNull();
  });

  test.each<[string | null]>([[null], ['app.kilo.ai'], ['staging-app.kilo.ai:443']])(
    'staging refuses request host %p',
    requestHost => {
      expect(webAuthnRelatedOrigins({ ...staging, requestHost })).toBeNull();
    }
  );
});

describe('GET /.well-known/webauthn', () => {
  const saved = {
    VERCEL_ENV: process.env.VERCEL_ENV,
    VERCEL_TARGET_ENV: process.env.VERCEL_TARGET_ENV,
  };

  beforeEach(() => {
    process.env.VERCEL_ENV = 'production';
    process.env.VERCEL_TARGET_ENV = 'production';
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  function wellKnownRequest(host: string): NextRequest {
    return new NextRequest(`https://${host}/.well-known/webauthn`, { headers: { host } });
  }

  test('serves the production list as application/json', async () => {
    const response = GET(wellKnownRequest('app.kilo.ai'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')?.split(';')[0]).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(await response.text()).toBe('{"origins":["https://uts.kiloapps.io"]}');
  });

  test('answers 404 with no body and no caching for another host', async () => {
    const response = GET(wellKnownRequest('kilocode-app.vercel.app'));

    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('');
  });

  test('answers 404 outside a production deployment', async () => {
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_TARGET_ENV = 'preview';

    const response = GET(wellKnownRequest('app.kilo.ai'));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
  });
});
