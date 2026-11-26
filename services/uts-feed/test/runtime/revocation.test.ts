import { createExecutionContext, env as poolEnv, waitOnExecutionContext } from 'cloudflare:test';
import {
  decodeBase64Url,
  feedListHash,
  FeedReaderBootstrapSchema,
  FeedReaderHeadSchema,
  UtsBootstrapWireSchema,
  type FeedReaderBinding,
  type FeedReadsBinding,
  type SignerKeysBinding,
} from '@kilocode/uts-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readConfig, type Env } from '../../src/env';
import { handleRequest } from '../../src/http';
import { resetIsolate } from '../../src/jwks';
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
const okHead =
  (head = 'head.of.feed', issuedAt = nowSeconds()): Answer =>
  async () => ({
    status: 'ok',
    head,
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

const config = readConfig({
  UTS_ENVIRONMENT: 'development',
  UTS_MINT: { signerKeys: async () => null },
  UTS_FEED_READS: feedReads([]).binding,
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
    expect(await head(reads.binding)).toMatchObject({ status: 'ok', head: 'head-0', listHash });
    expect(await head(reads.binding)).toMatchObject({ status: 'ok', head: 'head-0' });
    expect(reads.calls).toEqual(['head 0']);
  });

  it('reads feed 1 when feed 0 fails, is unavailable, or answers a stale head', async () => {
    const stale = okHead('stale', nowSeconds() - FEED_HEAD_MAX_SERVED_AGE_MS / 1000 - 2);
    for (const first of [failing, unavailable, stale]) {
      resetFeedFailures();
      await caches.default.delete(feedCacheKey(config, 'head'));
      const reads = feedReads([first, okHead('head-1')]);
      expect(await head(reads.binding)).toMatchObject({ status: 'ok', head: 'head-1' });
      expect(reads.calls).toEqual(['head 0', 'head 1']);
    }
  });

  it('gives feed 0 one second, then reads feed 1', async () => {
    const reads = feedReads([() => new Promise(() => undefined), okHead('head-1')]);
    const started = Date.now();
    expect(await head(reads.binding)).toMatchObject({ status: 'ok', head: 'head-1' });
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
    await head(reads.binding);
    expect(reads.calls).toEqual(['head 0', 'head 1', 'head 1']);
    await caches.default.delete(feedCacheKey(config, 'head'));
    clock.mockReturnValue(t0 + FEED_FAILED_OBJECT_MS);
    const retried = feedReads([okHead('head-0', Math.floor((t0 + FEED_FAILED_OBJECT_MS) / 1000))]);
    expect(await head(retried.binding)).toMatchObject({ head: 'head-0' });
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
      Response.json(
        { head: 'old', listHash, issuedAt: nowSeconds() - 60 },
        { headers: { 'Cache-Control': 'max-age=5' } }
      )
    );
    const reads = feedReads([okHead('fresh')]);
    expect(await head(reads.binding)).toMatchObject({ head: 'fresh' });
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
});

describe('routes', () => {
  const signerKeys: SignerKeysBinding = { signerKeys: async () => null };

  async function get(path: string, reads: FeedReadsBinding, environment = 'development') {
    const env: Env = { UTS_ENVIRONMENT: environment, UTS_MINT: signerKeys, UTS_FEED_READS: reads };
    const ctx = createExecutionContext();
    const response = await handleRequest(new Request(`http://localhost:8801${path}`), env, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }

  it('serve the head and the list over HTTPS in development', async () => {
    const reads = feedReads([okHead('a.b.c')], [okList]).binding;
    const headResponse = await get('/revocation/head', reads);
    expect(headResponse.status).toBe(200);
    expect(headResponse.headers.get('Content-Type')).toBe('application/jwt');
    expect(await headResponse.text()).toBe('a.b.c');
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
      UTS_FEED_READS: feedReads([okHead('a.b.c')], [okList]).binding,
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
    expect(body.head).toBe('a.b.c');
    expect(body.jwks).toEqual({ keys });
    expect(await feedListHash(decodeBase64Url(body.list))).toBe(listHash);
  });
});

describe('FeedReader entrypoint', () => {
  it('refuses a binding without a caller', async () => {
    expect(await readers.PROPLESS_READER.head()).toEqual({ status: 'refused' });
    expect(await readers.PROPLESS_READER.bootstrap()).toEqual({ status: 'refused' });
  });

  it('answers a named caller, and unavailable with the 5-second wait when the feed cannot be read', async () => {
    expect(FeedReaderHeadSchema.parse(await readers.READER.head())).toEqual({
      status: 'unavailable',
      retryAfterSeconds: 5,
    });
    expect(FeedReaderBootstrapSchema.parse(await readers.READER.bootstrap())).toMatchObject({
      status: 'unavailable',
    });
  });
});
