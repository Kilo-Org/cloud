import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import {
  encodeBase64Url,
  feedListHash,
  UTS_FEED_HTTPS_WORKLOADS,
  type FeedReadsBinding,
} from '@kilocode/uts-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readConfig, type Env } from '../../src/env';
import { handleRequest } from '../../src/http';
import { FEED_HTTPS_OFF_RETRY_SECONDS, resetFeedVerifier } from '../../src/https-auth';
import { resetIsolate } from '../../src/jwks';
import { feedCacheKey, resetFeedFailures } from '../../src/revocation';
import { TEST_STS_ISSUER, serveStsKeySet, stsToken } from './sts';

/** The HTTPS feed's switch, its STS issuer, the caller check and the conditional answers. */

const LIST =
  '{"revoked_before":{},"revoked_sids":["g-1"],"revoked_kids":[],"revoked_pat_ids":[],"blocked_accounts":[]}';
const VERSION = { id: 'test-version-0002', tag: '', timestamp: '' };
const PATHS = ['/revocation/head', '/revocation/list/', '/revocation/bootstrap'] as const;
let listHash: string;
let issuedAt: number;
let head: string;

/** Feed objects that answer one head and its list, counting each call. */
function feedReads() {
  const calls: string[] = [];
  const binding: FeedReadsBinding = {
    head: async feed => {
      calls.push(`head ${feed}`);
      return { status: 'ok', head, listHash, issuedAt };
    },
    list: async (feed, hash) => {
      calls.push(`list ${feed}`);
      return hash === listHash ? { status: 'ok', list: LIST } : { status: 'not_found' };
    },
  };
  return { binding, calls };
}

const KID = `uts-token-00-${'A'.repeat(43)}`;
const KEYS = [
  { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43), kid: KID, alg: 'EdDSA', use: 'sig' },
];

/** The mint Worker's signer-keys answer: signer 0 keyed, read now; every other one unavailable. */
function signerAnswer() {
  return {
    status: 'answered',
    answer: {
      signers: Array.from({ length: 16 }, (_, signer) =>
        signer === 0
          ? { signer, status: 'ok', readAt: Date.now(), keys: KEYS }
          : { signer, status: 'unavailable' }
      ),
      feeds: [0, 1].map(feed => ({ feed, status: 'unavailable' })),
    },
  };
}

function envOf(vars: Partial<Env>, reads: FeedReadsBinding): Env {
  return {
    UTS_ENVIRONMENT: 'development',
    UTS_MINT: { signerKeys: async () => signerAnswer() },
    UTS_FEED_READS: reads,
    CF_VERSION_METADATA: VERSION,
    FEED_HTTPS_ENABLED: 'true',
    STS_URL: TEST_STS_ISSUER,
    ...vars,
  };
}

async function get(
  path: string,
  env: Env,
  headers: Record<string, string> = {}
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await handleRequest(
    new Request(`http://localhost:8801${path}`, { headers }),
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return response;
}

const bearer = async (options: Parameters<typeof stsToken>[0] = {}) => ({
  Authorization: `Bearer ${await stsToken(options)}`,
});
const pathOf = (path: (typeof PATHS)[number]) =>
  path === '/revocation/list/' ? `${path}${listHash}` : path;

beforeEach(async () => {
  listHash = await feedListHash(new Uint8Array(new TextEncoder().encode(LIST)));
  issuedAt = Math.floor(Date.now() / 1000) - 3;
  head = [
    encodeBase64Url(new TextEncoder().encode('{"alg":"EdDSA"}')),
    encodeBase64Url(
      new TextEncoder().encode(JSON.stringify({ iat: issuedAt, list_hash: listHash }))
    ),
    'signature',
  ].join('.');
  resetFeedFailures();
  resetFeedVerifier();
  resetIsolate();
  for (const environment of ['development', 'staging', 'production'] as const) {
    const config = readConfig(envOf({ UTS_ENVIRONMENT: environment }, feedReads().binding));
    await caches.default.delete(feedCacheKey(config, 'head'));
    await caches.default.delete(feedCacheKey(config, `list/${listHash}`));
  }
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the HTTPS feed switch', () => {
  it.each(['production', 'staging'])(
    'answers 503 with Retry-After in %s as deployed (switch unset), before any token check or read',
    async environment => {
      const { fetched } = await serveStsKeySet();
      const reads = feedReads();
      const env = envOf(
        { UTS_ENVIRONMENT: environment, FEED_HTTPS_ENABLED: undefined, STS_URL: undefined },
        reads.binding
      );
      for (const path of PATHS) {
        const response = await get(pathOf(path), env, await bearer());
        expect(response.status).toBe(503);
        expect(response.headers.get('Retry-After')).toBe(String(FEED_HTTPS_OFF_RETRY_SECONDS));
        expect(await response.json()).toEqual({ error: 'temporarily_unavailable' });
      }
      expect(reads.calls).toEqual([]);
      expect(fetched).toEqual([]);
    }
  );

  it('stays off for any value but exactly true', async () => {
    const reads = feedReads();
    for (const value of ['TRUE', '1', 'yes', ' true', '']) {
      const response = await get(
        '/revocation/head',
        envOf({ FEED_HTTPS_ENABLED: value }, reads.binding),
        await bearer()
      );
      expect(response.status).toBe(503);
    }
    expect(reads.calls).toEqual([]);
  });

  it('answers 503, never 500, while on without an STS issuer of its environment', async () => {
    const { fetched } = await serveStsKeySet();
    const reads = feedReads();
    const cases: Array<[string, string | undefined]> = [
      ['development', undefined],
      ['development', 'https://sts.example.com'],
      ['development', `${TEST_STS_ISSUER}/`],
      ['development', `${TEST_STS_ISSUER}/path`],
      ['development', 'not a url'],
      ['staging', TEST_STS_ISSUER],
      ['staging', 'https://sts.kiloapps.io'],
      ['production', 'https://sts-staging.kiloapps.io'],
      ['production', TEST_STS_ISSUER],
    ];
    for (const [environment, stsUrl] of cases) {
      const response = await get(
        '/revocation/head',
        envOf({ UTS_ENVIRONMENT: environment, STS_URL: stsUrl }, reads.binding),
        await bearer()
      );
      expect(response.status, `${environment} ${String(stsUrl)}`).toBe(503);
      expect(response.headers.get('Retry-After')).toBe(String(FEED_HTTPS_OFF_RETRY_SECONDS));
    }
    expect(reads.calls).toEqual([]);
    expect(fetched).toEqual([]);
  });

  it('keeps the key set public whatever the switch says', async () => {
    const env = envOf(
      { UTS_ENVIRONMENT: 'production', FEED_HTTPS_ENABLED: undefined },
      feedReads().binding
    );
    const response = await get('/.well-known/jwks.json', env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ keys: KEYS });
  });
});

describe('the caller check', () => {
  it('answers 401 with a Bearer challenge without a token, and reads nothing', async () => {
    await serveStsKeySet();
    const reads = feedReads();
    for (const path of PATHS) {
      const response = await get(pathOf(path), envOf({}, reads.binding));
      expect(response.status).toBe(401);
      expect(response.headers.get('WWW-Authenticate')).toMatch(/^Bearer resource_metadata="/);
    }
    expect(reads.calls).toEqual([]);
  });

  it.each([
    ['a token of another audience', { audience: 'uts' }, 403],
    ['a token of another scope', { scope: 'uts-feed:revocation.write' }, 403],
    ['a token of another environment', { environment: 'staging' }, 401],
    ['a token of another issuer', { issuer: 'http://127.0.0.1:9408' }, 401],
    ['an expired token', { expired: true }, 401],
    ['a token under a key the STS key set does not hold', { foreignKey: true }, 401],
  ] as const)('refuses %s and reads nothing', async (_name, options, status) => {
    await serveStsKeySet();
    const reads = feedReads();
    const response = await get('/revocation/head', envOf({}, reads.binding), await bearer(options));
    expect(response.status).toBe(status);
    expect(reads.calls).toEqual([]);
  });

  it('refuses a valid token of a workload this environment does not admit with 403', async () => {
    await serveStsKeySet();
    const reads = feedReads();
    const response = await get(
      '/revocation/head',
      envOf({}, reads.binding),
      await bearer({ workload: 'o11y' })
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'access_denied' });
    expect(reads.calls).toEqual([]);
  });

  it('admits web and ai-gateway in development and staging, and no workload in production', () => {
    expect(UTS_FEED_HTTPS_WORKLOADS).toEqual({
      production: [],
      staging: ['web', 'ai-gateway'],
      development: ['web', 'ai-gateway'],
    });
    expect(readConfig(envOf({}, feedReads().binding)).https).toEqual({
      status: 'on',
      stsIssuer: TEST_STS_ISSUER,
      workloads: ['web', 'ai-gateway'],
    });
    expect(
      readConfig(
        envOf(
          { UTS_ENVIRONMENT: 'production', STS_URL: 'https://sts.kiloapps.io' },
          feedReads().binding
        )
      ).https
    ).toEqual({ status: 'on', stsIssuer: 'https://sts.kiloapps.io', workloads: [] });
  });

  it('answers 503 with Retry-After when the STS key set cannot be fetched', async () => {
    await serveStsKeySet({ available: false });
    const reads = feedReads();
    const response = await get('/revocation/head', envOf({}, reads.binding), await bearer());
    expect(response.status).toBe(503);
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(reads.calls).toEqual([]);
  });

  it.each(['web', 'ai-gateway'])(
    'serves %s the head, the list and the bootstrap, fetching the STS key set once',
    async workload => {
      const { fetched } = await serveStsKeySet();
      const env = envOf({}, feedReads().binding);
      const headers = await bearer({ workload });
      const headResponse = await get('/revocation/head', env, headers);
      expect(headResponse.status).toBe(200);
      expect(await headResponse.text()).toBe(head);
      const listResponse = await get(`/revocation/list/${listHash}`, env, headers);
      expect(listResponse.status).toBe(200);
      expect(await listResponse.text()).toBe(LIST);
      const bootstrap = await get('/revocation/bootstrap', env, headers);
      expect(bootstrap.status).toBe(200);
      expect(bootstrap.headers.get('Cache-Control')).toBe('no-store');
      expect(Number(bootstrap.headers.get('Kilo-Feed-Head-Age'))).toBeGreaterThanOrEqual(3);
      expect(await bootstrap.json()).toMatchObject({ head, jwks: { keys: KEYS } });
      expect(fetched).toEqual([`${TEST_STS_ISSUER}/.well-known/jwks.json`]);
    }
  );
});

describe('conditional answers', () => {
  it('sends the head with a weak ETag, its age and a private no-cache policy, and 304 on a match', async () => {
    await serveStsKeySet();
    const env = envOf({}, feedReads().binding);
    const headers = await bearer();
    const first = await get('/revocation/head', env, headers);
    const etag = `W/"${issuedAt}-${listHash}"`;
    expect(first.headers.get('ETag')).toBe(etag);
    expect(first.headers.get('Cache-Control')).toBe('private, no-cache');
    expect(first.headers.get('Content-Type')).toBe('application/jwt');
    expect(Number(first.headers.get('Kilo-Feed-Head-Age'))).toBeGreaterThanOrEqual(3);
    for (const condition of [etag, `"${issuedAt}-${listHash}"`, `"other", ${etag}`, '*']) {
      const again = await get('/revocation/head', env, { ...headers, 'If-None-Match': condition });
      expect(again.status, condition).toBe(304);
      expect(await again.text()).toBe('');
      expect(again.headers.get('ETag')).toBe(etag);
    }
    const changed = await get('/revocation/head', env, {
      ...headers,
      'If-None-Match': `W/"${issuedAt - 5}-${listHash}"`,
    });
    expect(changed.status).toBe(200);
    expect(await changed.text()).toBe(head);
  });

  it('sends the list as immutable under its hash, and 304 on a match without a feed read', async () => {
    await serveStsKeySet();
    const reads = feedReads();
    const env = envOf({}, reads.binding);
    const headers = await bearer();
    const first = await get(`/revocation/list/${listHash}`, env, headers);
    expect(first.headers.get('ETag')).toBe(`"${listHash}"`);
    expect(first.headers.get('Cache-Control')).toBe('private, max-age=600, immutable');
    const reads304 = reads.calls.length;
    const again = await get(`/revocation/list/${listHash}`, env, {
      ...headers,
      'If-None-Match': `"${listHash}"`,
    });
    expect(again.status).toBe(304);
    expect(reads.calls.length).toBe(reads304);
    // A malformed hash never gets a 304, so a bad name still answers 404.
    const bad = await get('/revocation/list/x', env, { ...headers, 'If-None-Match': '"x"' });
    expect(bad.status).toBe(404);
  });

  it('answers 304 only to an admitted caller', async () => {
    await serveStsKeySet();
    const env = envOf({}, feedReads().binding);
    const response = await get('/revocation/head', env, {
      'If-None-Match': `W/"${issuedAt}-${listHash}"`,
    });
    expect(response.status).toBe(401);
  });
});
