import { resolve } from 'node:path';
import { beforeAll, afterEach, describe, expect, it } from '@jest/globals';
import type { NextRequestWithAuth } from 'next-auth/middleware';
import { NextRequest, type NextFetchEvent } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { getPageStaticInfo } from 'next/dist/build/analysis/get-page-static-info';
import { loadBindings } from 'next/dist/build/swc';
import type { PAGE_TYPES } from 'next/dist/lib/page-types';
import { config, proxy } from './proxy';

const cases: [string, boolean][] = [
  ['/api/internal/usage/record', false],
  ['/api/internal/usage/record/', false],
  ['/api/internal/usage/record?source=editor&x=1', false],
  ['/api/internal/usage/record/?source=editor', false],
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
  let buildMatches: (pathname: string) => boolean;

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
    expect(matchers).toHaveLength(1);
    if (!matchers) throw new Error('Next build did not extract the proxy matcher');
    buildMatches = pathname => matchers.some(matcher => new RegExp(matcher.regexp).test(pathname));
  });

  it.each(cases)('matches %s: %s', (url, expected) => {
    // The installed Next release exposes the testing helper under its legacy middleware name.
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(expected);
    expect(buildMatches(new URL(url, 'https://example.test').pathname)).toBe(expected);
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
