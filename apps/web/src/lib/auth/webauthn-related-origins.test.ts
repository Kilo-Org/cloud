import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import type * as RouteModule from '@/app/.well-known/webauthn/route';
import { type RelatedOriginsInput, webAuthnRelatedOrigins } from './webauthn-related-origins';

jest.mock('@kilocode/web-shared/lib/constants', () => ({ APP_URL: 'https://app.kilo.ai' }));

// This repo's transform does not hoist `jest.mock` above the static imports, so the route, which
// reads the mocked `APP_URL`, is required here.
const { GET } = jest.requireActual<typeof RouteModule>('@/app/.well-known/webauthn/route');

// The production UTS relying-party configuration (`services/uts/wrangler.jsonc`): its
// `WEBAUTHN_RP_ID` is the app host, and its `WEBAUTHN_ORIGINS` is the issuer origin. Staging UTS
// uses its own relying party, so the staging app serves no list.
const UTS_PRODUCTION = { rpId: 'app.kilo.ai', origin: 'https://uts.kiloapps.io' };

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
  test('production lists exactly its own UTS origin', () => {
    expect(webAuthnRelatedOrigins(production)).toEqual({ origins: [UTS_PRODUCTION.origin] });
    expect(production.requestHost).toBe(UTS_PRODUCTION.rpId);
  });

  test('the production document is a well-formed related-origins list', () => {
    const document = webAuthnRelatedOrigins(production);
    if (!document) throw new Error('expected a document');

    expect(Object.keys(document)).toEqual(['origins']);
    expect(document.origins).toHaveLength(1);
    for (const origin of document.origins) {
      const url = new URL(origin);
      expect(url.protocol).toBe('https:');
      expect(url.origin).toBe(origin);
      expect(url.host).not.toBe(production.requestHost);
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
    ['its own deployment', {}],
    [
      'production on the staging app origin',
      { vercelEnv: 'production', vercelTargetEnv: 'production' },
    ],
    ['a staging build promoted to production', { vercelEnv: 'production' }],
    ['a preview', { vercelTargetEnv: 'preview' }],
    ['a development server', { vercelEnv: undefined, vercelTargetEnv: undefined }],
    ['the production app origin', { appUrl: 'https://app.kilo.ai' }],
    [
      'the production app origin and host',
      { appUrl: 'https://app.kilo.ai', requestHost: 'app.kilo.ai' },
    ],
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

  test.each([
    ['a preview deployment', 'preview', 'preview', 'app.kilo.ai'],
    ['a staging deployment', 'preview', 'staging', 'app.kilo.ai'],
    ['a staging deployment on the staging host', 'preview', 'staging', 'staging-app.kilo.ai'],
  ])('answers 404 with no body and no caching on %s', async (_name, env, target, host) => {
    process.env.VERCEL_ENV = env;
    process.env.VERCEL_TARGET_ENV = target;

    const response = GET(wellKnownRequest(host));

    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('');
  });
});
