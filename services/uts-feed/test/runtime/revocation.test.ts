import { createExecutionContext, env as poolEnv, waitOnExecutionContext } from 'cloudflare:test';
import {
  decodeBase64Url,
  encodeBase64Url,
  feedListHash,
  FeedReaderBootstrapSchema,
  FeedReaderHeadSchema,
  FeedReaderJwksSchema,
  UtsBootstrapWireSchema,
  type FeedReaderBinding,
  type FeedReadsBinding,
  type SignerKeysBinding,
} from '@kilocode/uts-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readConfig, type Env } from '../../src/env';
import { handleRequest } from '../../src/http';
import { resetIsolate } from '../../src/jwks';
import { readerJwks } from '../../src/reader';
import {
  FEED_FAILED_OBJECT_MS,
  FEED_HEAD_MAX_SERVED_AGE_MS,
  feedCacheKey,
  resetFeedFailures,
  serveHead,
  serveList,
} from '../../src/revocation';

// The pool's env carries the two FeedReader bindings `wrangler.test.jsonc` declares.
const readers = poolEnv as unknown as {
  READER: FeedReaderBinding;
  PROPLESS_READER: FeedReaderBinding;
};

const LIST =
  '{"revoked_before":{},"revoked_sids":["g-1"],"revoked_kids":[],"revoked_pat_ids":[],"blocked_accounts":[]}';
let listHash: string;

type Answer = () => Promise<unknown>;

/** A FeedReads binding whose objects answer as `heads` and `lists` say, counting each call. */
function feedReads(heads: Answer[], lists: Array<(hash: string) => Promise<unknown>> = []) {
  const calls: string[] = [];
  const binding: FeedReadsBinding = {
    head: async feed => {
      calls.push(`head ${feed}`);
      const answer = heads[feed];
      if (answer === undefined) throw new Error(`no feed ${feed}`);
      return await answer();
    },
    list: async (feed, hash) => {
      calls.push(`list ${feed}`);
      const answer = lists[feed];
      if (answer === undefined) throw new Error(`no feed ${feed}`);
      return await answer(hash);
    },
  };
  return { binding, calls };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
/** A compact JWS shape whose payload states `iat` and the list hash; `name` is its last part. */
const jws = (name: string, issuedAt: number) =>
  [
    encodeBase64Url(new TextEncoder().encode('{"alg":"EdDSA"}')),
    encodeBase64Url(
      new TextEncoder().encode(JSON.stringify({ iat: issuedAt, list_hash: listHash }))
    ),
    name,
  ].join('.');
/** Matches a head built by `jws` with this last part. */
const named = (name: string) => expect.stringMatching(new RegExp(`\\.${name}$`));
const okHead =
  (name = 'headoffeed', issuedAt = nowSeconds()): Answer =>
  async () => ({
    status: 'ok',
    head: jws(name, issuedAt),
    listHash,
    issuedAt,
  });
const failing: Answer = async () => {
  throw new Error('Durable Object overloaded');
};
const unavailable: Answer = async () => ({ status: 'unavailable' });
const misconfigured: Answer = async () => ({ status: 'misconfigured' });
const okList = async (hash: string) =>
  hash === listHash ? { status: 'ok', list: LIST } : { status: 'not_found' };

const VERSION = { id: 'test-version-0001', tag: '', timestamp: '' };
const config = readConfig({
  UTS_ENVIRONMENT: 'development',
  UTS_MINT: { signerKeys: async () => null },
  UTS_FEED_READS: feedReads([]).binding,
  CF_VERSION_METADATA: VERSION,
});

async function head(reads: FeedReadsBinding) {
  const ctx = createExecutionContext();
  const read = await serveHead(reads, config, ctx);
  await waitOnExecutionContext(ctx);
  return read;
}

async function list(reads: FeedReadsBinding, hash: string) {
  const ctx = createExecutionContext();
  const read = await serveList(reads, config, hash, ctx);
  await waitOnExecutionContext(ctx);
  return read;
}

beforeEach(async () => {
  listHash = await feedListHash(new Uint8Array(new TextEncoder().encode(LIST)));
  resetFeedFailures();
  resetIsolate();
  await caches.default.delete(feedCacheKey(config, 'head'));
  await caches.default.delete(feedCacheKey(config, `list/${listHash}`));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('head', () => {
  it('reads feed 0 and serves the cached head without another read', async () => {
    const reads = feedReads([okHead('head-0'), okHead('head-1')]);
    expect(await head(reads.binding)).toMatchObject({
      status: 'ok',
      head: named('head-0'),
      listHash,
    });
    expect(await head(reads.binding)).toMatchObject({ status: 'ok', head: named('head-0') });
    expect(reads.calls).toEqual(['head 0']);
  });

  it('reads feed 1 when feed 0 fails, is unavailable, or answers a stale head', async () => {
    const stale = okHead('stale', nowSeconds() - FEED_HEAD_MAX_SERVED_AGE_MS / 1000 - 2);
    for (const first of [failing, unavailable, stale]) {
      resetFeedFailures();
      await caches.default.delete(feedCacheKey(config, 'head'));
      const reads = feedReads([first, okHead('head-1')]);
      expect(await head(reads.binding)).toMatchObject({ status: 'ok', head: named('head-1') });
      expect(reads.calls).toEqual(['head 0', 'head 1']);
    }
  });

  it('gives feed 0 one second, then reads feed 1', async () => {
    const reads = feedReads([() => new Promise(() => undefined), okHead('head-1')]);
    const started = Date.now();
    expect(await head(reads.binding)).toMatchObject({ status: 'ok', head: named('head-1') });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('skips a failed object for 30 seconds, unless every object failed', async () => {
    const t0 = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(t0);
    const reads = feedReads([failing, okHead('head-1', Math.floor(t0 / 1000))]);
    await head(reads.binding);
    await caches.default.delete(feedCacheKey(config, 'head'));
    clock.mockReturnValue(t0 + FEED_FAILED_OBJECT_MS - 1);
    const again = feedReads([
      failing,
      okHead('head-1', Math.floor((t0 + FEED_FAILED_OBJECT_MS - 1) / 1000)),
    ]);
    await head(again.binding);
    expect(reads.calls).toEqual(['head 0', 'head 1']);
    expect(again.calls).toEqual(['head 1']);
    await caches.default.delete(feedCacheKey(config, 'head'));
    clock.mockReturnValue(t0 + FEED_FAILED_OBJECT_MS);
    const retried = feedReads([okHead('head-0', Math.floor((t0 + FEED_FAILED_OBJECT_MS) / 1000))]);
    expect(await head(retried.binding)).toMatchObject({ head: named('head-0') });
    expect(retried.calls).toEqual(['head 0']);
  });

  it('answers unavailable when both objects fail and misconfigured when both refuse', async () => {
    expect(await head(feedReads([failing, unavailable]).binding)).toEqual({
      status: 'unavailable',
    });
    resetFeedFailures();
    expect(await head(feedReads([misconfigured, misconfigured]).binding)).toEqual({
      status: 'misconfigured',
    });
  });

  it('reads the objects again when the cached head is past its age', async () => {
    await caches.default.put(
      feedCacheKey(config, 'head'),
      new Response(jws('old', nowSeconds() - 60), { headers: { 'Cache-Control': 'max-age=5' } })
    );
    const reads = feedReads([okHead('fresh')]);
    expect(await head(reads.binding)).toMatchObject({ head: named('fresh') });
  });
});

describe('list', () => {
  it('serves the bytes that match the hash and keeps them in the cache', async () => {
    const reads = feedReads([], [okList, okList]);
    const first = await list(reads.binding, listHash);
    if (first.status !== 'ok') throw new Error(first.status);
    expect(new TextDecoder().decode(first.bytes)).toBe(LIST);
    expect(await list(reads.binding, listHash)).toMatchObject({ status: 'ok' });
    expect(reads.calls).toEqual(['list 0']);
  });

  it('refuses bytes that do not match the hash and reads the other object', async () => {
    const wrong = async () => ({ status: 'ok', list: '{"other":true}' });
    const reads = feedReads([], [wrong, okList]);
    expect(await list(reads.binding, listHash)).toMatchObject({ status: 'ok' });
    expect(reads.calls).toEqual(['list 0', 'list 1']);
  });

  it('answers not_found only when both objects hold no such list, and nothing for a bad hash', async () => {
    const reads = feedReads([], [okList, okList]);
    expect(await list(reads.binding, 'B'.repeat(43))).toEqual({ status: 'not_found' });
    expect(await list(reads.binding, 'not-a-hash')).toEqual({ status: 'not_found' });
    const broken = feedReads([], [failing, okList]);
    expect(await list(broken.binding, 'B'.repeat(43))).toEqual({ status: 'unavailable' });
  });

  it('reads a skipped object before it answers not_found, since the list it holds can differ', async () => {
    const t0 = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(t0);
    // Feed 0 failed a head read, so this isolate skips it for 30 seconds.
    await head(feedReads([failing, okHead('head-1', Math.floor(t0 / 1000))]).binding);
    clock.mockReturnValue(t0 + 1000);
    const notOnFeed1 = async () => ({ status: 'not_found' });
    const reads = feedReads([], [okList, notOnFeed1]);
    expect(await list(reads.binding, listHash)).toMatchObject({ status: 'ok' });
    expect(reads.calls).toEqual(['list 1', 'list 0']);
  });
});

describe('routes', () => {
  const signerKeys: SignerKeysBinding = { signerKeys: async () => null };

  async function get(path: string, reads: FeedReadsBinding, environment = 'development') {
    const env: Env = {
      UTS_ENVIRONMENT: environment,
      UTS_MINT: signerKeys,
      UTS_FEED_READS: reads,
      CF_VERSION_METADATA: VERSION,
    };
    const ctx = createExecutionContext();
    const response = await handleRequest(new Request(`http://localhost:8801${path}`), env, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }

  it('serve the head and the list over HTTPS in development', async () => {
    const reads = feedReads([okHead('abc')], [okList]).binding;
    const headResponse = await get('/revocation/head', reads);
    expect(headResponse.status).toBe(200);
    expect(headResponse.headers.get('Content-Type')).toBe('application/jwt');
    expect(await headResponse.text()).toEqual(named('abc'));
    const listResponse = await get(`/revocation/list/${listHash}`, reads);
    expect(listResponse.status).toBe(200);
    expect(await listResponse.text()).toBe(LIST);
    expect((await get('/revocation/list/x', reads)).status).toBe(404);
  });

  it('answer 503 with a 5-second wait when no object answers', async () => {
    const response = await get('/revocation/head', feedReads([failing, failing]).binding);
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
  });

  it('answer 404 in staging and production until the caller check exists', async () => {
    const reads = feedReads([okHead()], [okList]).binding;
    for (const environment of ['staging', 'production']) {
      for (const path of [
        '/revocation/head',
        `/revocation/list/${listHash}`,
        '/revocation/bootstrap',
      ]) {
        expect((await get(path, reads, environment)).status).toBe(404);
      }
    }
  });

  it('answer the bootstrap with the key set, the head and the list it covers', async () => {
    const signer = { signer: 0, status: 'ok', readAt: Date.now() };
    const kid = `uts-token-00-${'A'.repeat(43)}`;
    const keys = [{ kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43), kid, alg: 'EdDSA', use: 'sig' }];
    const answer = {
      status: 'answered',
      answer: {
        signers: Array.from({ length: 16 }, (_, index) =>
          index === 0 ? { ...signer, keys } : { signer: index, status: 'unavailable' }
        ),
        feeds: [0, 1].map(feed => ({ feed, status: 'unavailable' })),
      },
    };
    const env: Env = {
      UTS_ENVIRONMENT: 'development',
      UTS_MINT: { signerKeys: async () => answer },
      UTS_FEED_READS: feedReads([okHead('abc')], [okList]).binding,
      CF_VERSION_METADATA: VERSION,
    };
    const ctx = createExecutionContext();
    const response = await handleRequest(
      new Request('http://localhost:8801/revocation/bootstrap'),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const body = UtsBootstrapWireSchema.parse(await response.json());
    expect(body.head).toEqual(named('abc'));
    expect(body.jwks).toEqual({ keys });
    // Signer 0 was read now and no other signer has keys: both ages are 0, and the headers agree.
    expect(body.key_ages).toEqual({ newest: 0, oldest: 0 });
    expect(response.headers.get('Age')).toBe('0');
    expect(response.headers.get('Kilo-Key-Set-Oldest-Age')).toBe('0');
    expect(await feedListHash(decodeBase64Url(body.list))).toBe(listHash);
  });

  it("keeps a held signer's oldest age in a bootstrap during that signer's outage", async () => {
    const now = Date.now();
    const keysOf = (signer: number) => {
      const x = `${String(signer).padStart(2, '0')}${'C'.repeat(41)}`;
      const kid = `uts-token-${String(signer).padStart(2, '0')}-${x}`;
      return [{ kty: 'OKP', crv: 'Ed25519', x, kid, alg: 'EdDSA', use: 'sig' }];
    };
    // Signer 3's object stopped answering an hour ago; its last good keys stand in.
    const answer = {
      status: 'answered',
      answer: {
        signers: Array.from({ length: 16 }, (_, signer) => ({
          signer,
          status: 'ok',
          keys: keysOf(signer),
          readAt: signer === 3 ? now - 3_600_000 : now,
        })),
      },
    };
    const env: Env = {
      UTS_ENVIRONMENT: 'development',
      UTS_MINT: { signerKeys: async () => answer },
      UTS_FEED_READS: feedReads([okHead('abc')], [okList]).binding,
      CF_VERSION_METADATA: VERSION,
    };
    const ctx = createExecutionContext();
    const response = await handleRequest(
      new Request('http://localhost:8801/revocation/bootstrap'),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    const body = UtsBootstrapWireSchema.parse(await response.json());
    expect(body.key_ages.newest).toBeLessThanOrEqual(1);
    expect(body.key_ages.oldest).toBeGreaterThanOrEqual(3600);
    expect(body.key_ages.oldest).toBeLessThanOrEqual(3601);
    expect(response.headers.get('Kilo-Key-Set-Oldest-Age')).toBe(String(body.key_ages.oldest));
  });
});

describe('FeedReader entrypoint', () => {
  it('refuses a binding without a caller', async () => {
    expect(await readers.PROPLESS_READER.head()).toEqual({ status: 'refused' });
    expect(await readers.PROPLESS_READER.bootstrap()).toEqual({ status: 'refused' });
    expect(await readers.PROPLESS_READER.jwks()).toEqual({ status: 'refused' });
  });

  it('answers a named caller, and unavailable with the 5-second wait when the feed cannot be read', async () => {
    expect(FeedReaderHeadSchema.parse(await readers.READER.head())).toEqual({
      status: 'unavailable',
      retryAfterSeconds: 5,
    });
    expect(FeedReaderBootstrapSchema.parse(await readers.READER.bootstrap())).toMatchObject({
      status: 'unavailable',
    });
    // The pool's feed Worker holds no signer keys, so its key set answers unavailable.
    expect(FeedReaderJwksSchema.parse(await readers.READER.jwks())).toEqual({
      status: 'unavailable',
      retryAfterSeconds: 10,
    });
  });

  it('answers jwks() with the held key set and its ages, and reads no feed object', async () => {
    const now = Date.now();
    const x = 'D'.repeat(43);
    const keys = [
      { kty: 'OKP', crv: 'Ed25519', x, kid: `uts-token-00-${x}`, alg: 'EdDSA', use: 'sig' },
    ];
    const answer = {
      status: 'answered',
      answer: {
        signers: Array.from({ length: 16 }, (_, signer) =>
          signer === 0
            ? { signer, status: 'ok', keys, readAt: now - 120_000 }
            : { signer, status: 'unavailable' }
        ),
      },
    };
    const objects = feedReads([], []);
    const env: Env = {
      UTS_ENVIRONMENT: 'development',
      UTS_MINT: { signerKeys: async () => answer },
      UTS_FEED_READS: objects.binding,
      CF_VERSION_METADATA: VERSION,
    };
    const ctx = createExecutionContext();
    const read = FeedReaderJwksSchema.parse(await readerJwks(env, ctx));
    await waitOnExecutionContext(ctx);
    expect(read).toEqual({ status: 'ok', jwks: { keys }, keyAges: { newest: 120, oldest: 120 } });
    expect(objects.calls).toEqual([]);
  });

  it('answers jwks() unavailable, not a feed-keys-only set, when no signer key is held', async () => {
    const answer = {
      status: 'answered',
      answer: {
        signers: Array.from({ length: 16 }, (_, signer) => ({ signer, status: 'unavailable' })),
      },
    };
    const env: Env = {
      UTS_ENVIRONMENT: 'development',
      UTS_MINT: { signerKeys: async () => answer },
      UTS_FEED_READS: feedReads([], []).binding,
      CF_VERSION_METADATA: VERSION,
    };
    const ctx = createExecutionContext();
    expect(await readerJwks(env, ctx)).toEqual({ status: 'unavailable', retryAfterSeconds: 10 });
    await waitOnExecutionContext(ctx);
  });
});
