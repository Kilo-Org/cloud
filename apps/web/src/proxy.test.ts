import { resolve } from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';
import { beforeAll, afterEach, describe, expect, it } from '@jest/globals';
import type { NextRequestWithAuth } from 'next-auth/middleware';
import { NextRequest, type NextFetchEvent } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { getPageStaticInfo } from 'next/dist/build/analysis/get-page-static-info';
import { loadBindings } from 'next/dist/build/swc';
import type { PAGE_TYPES } from 'next/dist/lib/page-types';
import { getMiddlewareRouteMatcher } from 'next/dist/shared/lib/router/utils/middleware-route-matcher';
import { constructRequest } from 'next/dist/experimental/testing/server/utils';
import { config, proxy } from './proxy';

const cases: [string, boolean, boolean?][] = [
  ['/api/internal/usage/record', false, true],
  ['/api/internal/usage/record/', false, true],
  ['/api/internal/usage/record?source=editor&x=1', false, true],
  ['/api/internal/usage/record/?source=editor', false, true],
  ['/api/internal/usage/recording', true],
  ['/api/internal/usage/record-extra', true],
  ['/api/internal/usage/record.json', true],
  ['/api/internal/usage/record/child', true],
  ['/api/internal/usage/records', true],
  ['/api/internal/usage/Record', true],
  ['/api/internal/usage/record%2F', true],
  ['/api/internal/usage', true],
  ['/api/internal/db/replication-lag', true],
  ['/api/user', true],
  ['/admin/api/organizations', true],
  ['/admin/api/users/add-credit', true],
  ['/admin/api/users', true],
  ['/admin', true],
  ['/', true],
  ['/profile?source=editor', true],
  ['/auth/verify-magic-link', true],
  ['/_next/static/chunk.js', false],
  ['/_next/image?url=test', false],
  ['/favicon.ico', false],
  ['/logo.svg', false],
];

describe('web proxy matcher', () => {
  let buildMatches: (url: string, headers?: IncomingHttpHeaders) => boolean;

  beforeAll(async () => {
    // Use Next's production build analysis, including static config extraction and validation.
    await loadBindings();
    const info = await getPageStaticInfo({
      pageFilePath: resolve(__dirname, 'proxy.ts'),
      nextConfig: {},
      isDev: false,
      page: '/proxy',
      pageType: 'pages' as PAGE_TYPES.PAGES,
    });
    expect(info.hadUnsupportedValue).toBe(false);
    const matchers = info.middleware?.matchers;
    expect(matchers).toHaveLength(2);
    if (!matchers) throw new Error('Next build did not extract the proxy matcher');
    const match = getMiddlewareRouteMatcher(matchers);
    buildMatches = (url, headers) => {
      const parsed = new URL(url);
      return match(
        parsed.pathname,
        constructRequest({ url, headers: { ...headers } }),
        Object.fromEntries(parsed.searchParams)
      );
    };
  });

  describe.each([
    ['https://staging-app.kilo.ai', true],
    ['https://app.kilo.ai', false],
    ['https://global-app.kilo.ai', false],
    ['https://preview-example.vercel.app', false],
    ['http://localhost:3000', false],
    ['http://127.0.0.1:3000', false],
    ['https://staging-app.kilo.ai.example.test', false],
    ['https://staging-appXkiloXai', false],
  ])('host %s', (origin, staging) => {
    it.each(cases)('matches %s', (path, stagingExpected, originalExpected = stagingExpected) => {
      const url = `${origin}${path}`;
      const expected = staging ? stagingExpected : originalExpected;
      // The installed Next release exposes the testing helper under its legacy middleware name.
      expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(expected);
      expect(buildMatches(url)).toBe(expected);
    });
  });

  it.each([
    ['app.kilo.ai', 'staging-app.kilo.ai', true],
    ['global-app.kilo.ai', 'staging-app.kilo.ai', true],
    ['preview-example.vercel.app', 'staging-app.kilo.ai', true],
    ['localhost:3000', 'staging-app.kilo.ai', true],
    ['staging-app.kilo.ai', 'app.kilo.ai', false],
    ['STAGING-APP.KILO.AI:443', 'app.kilo.ai', false],
  ])('uses Host %s independently of forwarded host %s', (host, forwardedHost, expected) => {
    const url = 'https://example.test/api/internal/usage/record?source=editor';
    const headers = {
      host,
      'x-forwarded-host': forwardedHost,
      'x-original-host': forwardedHost,
      forwarded: `host=${forwardedHost}`,
    };
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url, headers })).toBe(expected);
    expect(buildMatches(url, headers)).toBe(expected);
  });
});

describe('unrelated proxy behavior', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps anonymous admin API requests behind admin authentication', async () => {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      NEXTAUTH_SECRET: 'synthetic-proxy-secret',
      NEXTAUTH_URL: 'https://example.test',
    });
    const response = await proxy(
      new NextRequest('https://example.test/admin/api/organizations') as NextRequestWithAuth,
      {} as NextFetchEvent
    );
    expect(response?.status).toBe(307);
    expect(response?.headers.get('location')).toContain('/api/auth/signin');
    expect(response?.headers.get('x-middleware-next')).toBeNull();
  });

  it('keeps browser path/query headers, CSP and the editor-source cookie', async () => {
    jest.replaceProperty(process, 'env', { ...process.env, CSP_MODE: 'report-only' });
    const response = await proxy(
      new NextRequest('https://example.test/profile?source=editor') as NextRequestWithAuth,
      {} as NextFetchEvent
    );
    expect(response?.headers.get('x-middleware-next')).toBe('1');
    expect(response?.headers.get('x-middleware-request-x-pathname')).toBe('/profile');
    expect(response?.headers.get('x-middleware-request-x-search')).toBe('?source=editor');
    expect(response?.headers.get('content-security-policy-report-only')).toContain(
      "default-src 'self'"
    );
    expect(response?.headers.get('set-cookie')).toContain('kilo-editor-source=editor');
  });
});
