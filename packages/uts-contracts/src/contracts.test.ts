import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  SignJWT,
} from 'jose';
import { describe, expect, it } from 'vitest';
import {
  UTS_ENDPOINTS,
  UTS_JWKS_MAX_AGE_SECONDS,
  UTS_JWKS_OLDEST_AGE_HEADER,
  UTS_JWKS_STALE_IF_ERROR_SECONDS,
} from './environment';
import {
  feedKid,
  feedOfFeedKid,
  signerOfTokenKid,
  tokenKid,
  UTS_FEED_KID_PREFIX,
  UTS_TOKEN_KID_PREFIX,
  UtsJwksSchema,
  UtsTokenKidSchema,
  type UtsPublicJwk,
} from './jwks';
import { AuthorizationServerMetadataSchema } from './metadata';
import {
  decodeBase64Url,
  encodeBase64Url,
  FEED_HEAD_TYPE,
  FeedHeadPayloadSchema,
  feedListHash,
  feedReaderSources,
  httpsFeedSources,
  RevocationListWireSchema,
  UTS_BOOTSTRAP_PATH,
  UTS_FEED_HEAD_PATH,
  UTS_FEED_LIST_PATH_PREFIX,
  UTS_FEED_READER_ENTRYPOINT,
  UTS_FEED_READS_ENTRYPOINT,
  type FeedReaderBinding,
  type RevocationListWire,
} from './revocation';
import {
  SignerKeysAnswerSchema,
  SignerKeysReadSchema,
  UTS_SIGNER_KEYS_ENTRYPOINT,
  UTS_SIGNER_KEYS_HOLD_MS,
  type FeedKeysEntry,
  type SignerKeysEntry,
} from './signer-keys';

const THUMBPRINT = 'A'.repeat(43);

function jwk(signer: number, x = THUMBPRINT): UtsPublicJwk {
  return { kty: 'OKP', crv: 'Ed25519', x, kid: tokenKid(signer, x), alg: 'EdDSA', use: 'sig' };
}

describe('UTS endpoints', () => {
  it('fixes the issuer and key set URL of each environment', () => {
    expect(UTS_ENDPOINTS).toEqual({
      production: {
        issuer: 'https://uts.kiloapps.io',
        feedOrigin: 'https://uts-feed.kiloapps.io',
        jwksUri: 'https://uts-feed.kiloapps.io/.well-known/jwks.json',
      },
      staging: {
        issuer: 'https://uts-staging.kiloapps.io',
        feedOrigin: 'https://uts-feed-staging.kiloapps.io',
        jwksUri: 'https://uts-feed-staging.kiloapps.io/.well-known/jwks.json',
      },
      development: {
        issuer: 'http://localhost:8800',
        feedOrigin: 'http://localhost:8801',
        jwksUri: 'http://localhost:8801/.well-known/jwks.json',
      },
    });
  });

  it('fixes the key-set cache limits and the oldest-age header name', () => {
    expect(UTS_JWKS_MAX_AGE_SECONDS).toBe(300);
    expect(UTS_JWKS_STALE_IF_ERROR_SECONDS).toBe(86400);
    expect(UTS_JWKS_OLDEST_AGE_HEADER).toBe('Kilo-Key-Set-Oldest-Age');
  });
});

describe('token kids', () => {
  it('name the signer and the key thumbprint', () => {
    const kid = tokenKid(7, THUMBPRINT);
    expect(kid).toBe(`uts-token-07-${THUMBPRINT}`);
    expect(signerOfTokenKid(kid)).toBe(7);
    expect(UtsTokenKidSchema.safeParse(kid).success).toBe(true);
  });

  it('reject signers outside the 16 and values that are not token kids', () => {
    expect(() => tokenKid(16, THUMBPRINT)).toThrow();
    expect(() => tokenKid(0, 'short')).toThrow();
    expect(signerOfTokenKid(`uts-token-16-${THUMBPRINT}`)).toBeNull();
    expect(signerOfTokenKid(`uts-feed-00-${THUMBPRINT}`)).toBeNull();
    expect(UtsTokenKidSchema.safeParse(`uts-token-16-${THUMBPRINT}`).success).toBe(false);
  });
});

describe('UtsJwksSchema', () => {
  it('accepts Ed25519 public keys and rejects private parts, other key types and duplicate kids', () => {
    expect(UtsJwksSchema.parse({ keys: [jwk(0), jwk(1)] }).keys).toHaveLength(2);
    expect(UtsJwksSchema.safeParse({ keys: [{ ...jwk(0), d: THUMBPRINT }] }).success).toBe(false);
    expect(UtsJwksSchema.safeParse({ keys: [{ ...jwk(0), crv: 'X25519' }] }).success).toBe(false);
    expect(UtsJwksSchema.safeParse({ keys: [jwk(0), jwk(0)] }).success).toBe(false);
    expect(UtsJwksSchema.safeParse({ keys: [] }).success).toBe(false);
  });

  it('is a key set jose verifies an EdDSA at+jwt against', async () => {
    const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const exported = await exportJWK(pair.publicKey);
    const x = String(exported.x);
    const kid = tokenKid(4, await calculateJwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x }));
    const jwks = UtsJwksSchema.parse({ keys: [{ ...jwk(4, x), kid }] });
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      iss: 'https://uts.kiloapps.io',
      aud: 'gateway',
      scope: 'gateway:models.read',
      iat: now,
      exp: now + 600,
    })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid })
      .sign(pair.privateKey);
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), {
      issuer: 'https://uts.kiloapps.io',
      audience: 'gateway',
      typ: 'at+jwt',
      algorithms: ['EdDSA'],
    });
    expect(payload.scope).toBe('gateway:models.read');
  });
});

describe('feed kids', () => {
  it('name the feed object and the key thumbprint, and never parse as a token kid', () => {
    const kid = feedKid(1, THUMBPRINT);
    expect(kid).toBe(`uts-feed-1-${THUMBPRINT}`);
    expect(kid.startsWith(UTS_FEED_KID_PREFIX)).toBe(true);
    expect(feedOfFeedKid(kid)).toBe(1);
    expect(signerOfTokenKid(kid)).toBeNull();
    expect(feedOfFeedKid(tokenKid(1, THUMBPRINT))).toBeNull();
    expect(tokenKid(1, THUMBPRINT).startsWith(UTS_TOKEN_KID_PREFIX)).toBe(true);
  });

  it('reject feed objects outside the two', () => {
    expect(() => feedKid(2, THUMBPRINT)).toThrow();
    expect(feedOfFeedKid(`uts-feed-2-${THUMBPRINT}`)).toBeNull();
  });
});

describe('SignerKeysAnswerSchema', () => {
  const READ_AT = 1_800_000_000_000;
  const signers = (): SignerKeysEntry[] =>
    Array.from({ length: 16 }, (_, signer) => ({
      signer,
      status: 'ok',
      keys: [jwk(signer)],
      readAt: READ_AT,
    }));
  const feedJwk = (feed: number, x = THUMBPRINT): UtsPublicJwk => ({
    ...jwk(0, x),
    kid: feedKid(feed, x),
  });
  const feeds = (): FeedKeysEntry[] =>
    [0, 1].map(feed => ({ feed, status: 'ok', keys: [feedJwk(feed)], readAt: READ_AT }));

  it('accepts every signer and feed object exactly once, each with its keys and read time or a failure', () => {
    const answer = signers();
    answer[3] = { signer: 3, status: 'misconfigured' };
    answer[7] = { signer: 7, status: 'unavailable' };
    const feedEntries = feeds();
    feedEntries[1] = { feed: 1, status: 'unavailable' };
    const parsed = SignerKeysAnswerSchema.parse({ signers: answer, feeds: feedEntries });
    expect(parsed.signers[7]).toEqual({ signer: 7, status: 'unavailable' });
    expect(parsed.feeds?.[1]).toEqual({ feed: 1, status: 'unavailable' });
    const failing = Array.from({ length: 16 }, (_, signer) => ({ signer, status: 'unavailable' }));
    expect(SignerKeysAnswerSchema.safeParse({ signers: failing, feeds: feeds() }).success).toBe(
      true
    );
    const withoutReadTime = Array.from({ length: 16 }, (_, signer) => ({
      signer,
      status: 'ok',
      keys: [jwk(signer)],
    }));
    expect(
      SignerKeysAnswerSchema.safeParse({ signers: withoutReadTime, feeds: feeds() }).success
    ).toBe(false);
    // An answer from a mint Worker of the previous release has no `feeds`; it is accepted for one
    // release.
    expect(SignerKeysAnswerSchema.safeParse({ signers: signers() }).success).toBe(true);
  });

  it('names the signer-keys entrypoint, holds keys 24 hours, and reads an answer, a refusal or a misconfigured shard', () => {
    expect(UTS_SIGNER_KEYS_ENTRYPOINT).toBe('SignerKeys');
    expect(UTS_SIGNER_KEYS_HOLD_MS).toBe(24 * 60 * 60 * 1000);
    const answer = { signers: signers(), feeds: feeds() };
    expect(SignerKeysReadSchema.parse({ status: 'answered', answer })).toEqual({
      status: 'answered',
      answer,
    });
    expect(SignerKeysReadSchema.parse({ status: 'refused' })).toEqual({ status: 'refused' });
    expect(SignerKeysReadSchema.parse({ status: 'misconfigured' })).toEqual({
      status: 'misconfigured',
    });
    expect(SignerKeysReadSchema.safeParse({ status: 'answered' }).success).toBe(false);
    expect(
      SignerKeysReadSchema.safeParse({ status: 'answered', answer: { signers: [], feeds: [] } })
        .success
    ).toBe(false);
  });

  it('rejects a missing or repeated signer or feed object, a kid of another object, and a kid twice', () => {
    const parse = (signerEntries: unknown[], feedEntries: unknown[] = feeds()) =>
      SignerKeysAnswerSchema.safeParse({ signers: signerEntries, feeds: feedEntries }).success;
    expect(parse(signers().slice(1))).toBe(false);
    const repeated = signers();
    repeated[1] = { signer: 0, status: 'unavailable' };
    expect(parse(repeated)).toBe(false);
    const foreignKid = signers();
    foreignKid[2] = { signer: 2, status: 'ok', keys: [jwk(3)], readAt: READ_AT };
    expect(parse(foreignKid)).toBe(false);
    const twice = signers();
    twice[5] = { signer: 5, status: 'ok', keys: [jwk(5), jwk(5)], readAt: READ_AT };
    expect(parse(twice)).toBe(false);
    expect(parse(signers(), feeds().slice(1))).toBe(false);
    expect(parse(signers(), [feeds()[0], feeds()[0]])).toBe(false);
    expect(
      parse(signers(), [{ feed: 0, status: 'ok', keys: [feedJwk(1)], readAt: READ_AT }, feeds()[1]])
    ).toBe(false);
    const tokenKeyAsFeedKey = { feed: 0, status: 'ok', keys: [jwk(0)], readAt: READ_AT };
    expect(parse(signers(), [tokenKeyAsFeedKey, feeds()[1]])).toBe(false);
  });
});

describe('revocation feed shapes', () => {
  const list: RevocationListWire = {
    revoked_before: { 'user-a': 1_800_000_000 },
    revoked_sids: ['grant-1'],
    revoked_kids: [],
    revoked_pat_ids: [],
    blocked_accounts: [],
  };

  it('fix the head type, paths and entrypoint names', () => {
    expect(FEED_HEAD_TYPE).toBe('kilo-feed-head+jwt');
    expect(UTS_FEED_HEAD_PATH).toBe('/revocation/head');
    expect(UTS_FEED_LIST_PATH_PREFIX).toBe('/revocation/list/');
    expect(UTS_BOOTSTRAP_PATH).toBe('/revocation/bootstrap');
    expect(UTS_FEED_READER_ENTRYPOINT).toBe('FeedReader');
    expect(UTS_FEED_READS_ENTRYPOINT).toBe('FeedReads');
  });

  it('accept the head payload and list UTS publishes and nothing more', () => {
    expect(FeedHeadPayloadSchema.parse({ iat: 1, list_hash: THUMBPRINT })).toEqual({
      iat: 1,
      list_hash: THUMBPRINT,
    });
    expect(FeedHeadPayloadSchema.safeParse({ iat: 1, list_hash: 'x' }).success).toBe(false);
    expect(RevocationListWireSchema.parse(list)).toEqual(list);
    expect(RevocationListWireSchema.safeParse({ ...list, revoked_sids: [''] }).success).toBe(false);
  });

  it('hash and encode list bytes as base64url without padding', async () => {
    // RFC 6234 test vector: SHA-256 of "abc".
    expect(await feedListHash(new TextEncoder().encode('abc'))).toBe(
      'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0'
    );
    const bytes = Uint8Array.from([0xfb, 0xff, 0xbf, 0x01]);
    expect(encodeBase64Url(bytes)).toBe('-_-_AQ');
    expect(decodeBase64Url('-_-_AQ')).toEqual(bytes);
    const text = new TextEncoder().encode(JSON.stringify(list));
    expect(decodeBase64Url(encodeBase64Url(text))).toEqual(text);
    expect(decodeBase64Url('')).toEqual(new Uint8Array());
  });

  it('read the feed over a FeedReader binding, validating and disposing each result', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(list));
    const disposed: string[] = [];
    const withDisposer = <T extends object>(value: T, name: string): T =>
      Object.defineProperty(value, Symbol.dispose, { value: () => disposed.push(name) });
    const binding: FeedReaderBinding = {
      head: async () => withDisposer({ status: 'ok', head: 'a.b.c' }, 'head'),
      list: async hash =>
        withDisposer(
          hash === 'known' ? { status: 'ok', list: bytes } : { status: 'not_found' },
          'list'
        ),
      bootstrap: async () =>
        withDisposer(
          {
            status: 'ok',
            jwks: { keys: [] },
            keyAges: { newest: 3, oldest: 7200 },
            head: 'a.b.c',
            list: bytes,
          },
          'boot'
        ),
      jwks: async () =>
        withDisposer(
          { status: 'ok', jwks: { keys: [] }, keyAges: { newest: 2, oldest: 60 } },
          'jwks'
        ),
    };
    const sources = feedReaderSources(binding);
    const signal = new AbortController().signal;
    expect(await sources.feed.head(signal)).toBe('a.b.c');
    expect(await sources.feed.list('known', signal)).toEqual(bytes);
    await expect(sources.feed.list('other', signal)).rejects.toThrow('not_found');
    expect(await sources.bootstrap(signal)).toEqual({
      jwks: { keys: [] },
      keyAges: { newest: 3, oldest: 7200 },
      head: 'a.b.c',
      list: bytes,
    });
    expect(await sources.jwks(signal)).toEqual({ body: { keys: [] }, age: 2, oldestAge: 60 });
    expect(disposed).toEqual(['head', 'list', 'list', 'boot', 'jwks']);

    const refusing: FeedReaderBinding = {
      head: async () => ({ status: 'refused' }),
      list: async () => ({ status: 'unavailable', retryAfterSeconds: 5 }),
      // A bootstrap without key ages, or with the newest older than the oldest, is refused.
      bootstrap: async () => ({
        status: 'ok',
        jwks: { keys: [] },
        keyAges: { newest: 9, oldest: 3 },
        head: 'a.b.c',
        list: new Uint8Array(),
      }),
      jwks: async () => ({ status: 'unavailable', retryAfterSeconds: 10 }),
    };
    const refused = feedReaderSources(refusing);
    await expect(refused.feed.head(signal)).rejects.toThrow('refused');
    await expect(refused.feed.list('known', signal)).rejects.toThrow('unavailable');
    await expect(refused.bootstrap(signal)).rejects.toThrow();
    await expect(refused.jwks(signal)).rejects.toThrow('unavailable');
    await expect(
      feedReaderSources({ ...refusing, jwks: async () => ({ status: 'refused' }) }).jwks(signal)
    ).rejects.toThrow('refused');
    // An ok arm without its ages, or with the newest older than the oldest, is refused.
    for (const bad of [
      { status: 'ok', jwks: { keys: [] } },
      { status: 'ok', jwks: { keys: [] }, keyAges: { newest: 61, oldest: 60 } },
      { status: 'ok', jwks: [], keyAges: { newest: 0, oldest: 0 } },
    ]) {
      await expect(
        feedReaderSources({ ...refusing, jwks: async () => bad }).jwks(signal)
      ).rejects.toThrow();
    }
  });

  it('rejects a binding call once its signal aborts', async () => {
    const hanging: FeedReaderBinding = {
      head: () => new Promise(() => undefined),
      list: () => new Promise(() => undefined),
      bootstrap: () => new Promise(() => undefined),
      jwks: () => new Promise(() => undefined),
    };
    const controller = new AbortController();
    const pending = feedReaderSources(hanging).feed.head(controller.signal);
    controller.abort(new Error('timed out'));
    await expect(pending).rejects.toThrow('timed out');
    await expect(
      feedReaderSources(hanging).feed.head(AbortSignal.abort(new Error('already')))
    ).rejects.toThrow('already');
  });

  it('read the feed over HTTPS and refuse a non-200 answer', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(list));
    const requested: string[] = [];
    const fetcher = async (url: string) => {
      requested.push(url);
      if (url.endsWith('/revocation/head')) return new Response('a.b.c');
      if (url.endsWith(`/revocation/list/${THUMBPRINT}`)) return new Response(bytes);
      if (url.endsWith('/revocation/bootstrap')) {
        return Response.json({
          jwks: { keys: [] },
          key_ages: { newest: 0, oldest: 42 },
          head: 'a.b.c',
          list: encodeBase64Url(bytes),
        });
      }
      return new Response('no', { status: 503 });
    };
    const sources = httpsFeedSources('https://feed.example/', fetcher);
    const signal = new AbortController().signal;
    expect(await sources.feed.head(signal)).toBe('a.b.c');
    expect(await sources.feed.list(THUMBPRINT, signal)).toEqual(bytes);
    expect(await sources.bootstrap(signal)).toEqual({
      jwks: { keys: [] },
      keyAges: { newest: 0, oldest: 42 },
      head: 'a.b.c',
      list: bytes,
    });
    await expect(sources.feed.list('not-a-hash', signal)).rejects.toThrow();
    expect(requested).toEqual([
      'https://feed.example/revocation/head',
      `https://feed.example/revocation/list/${THUMBPRINT}`,
      'https://feed.example/revocation/bootstrap',
    ]);
    const failing = httpsFeedSources(
      'https://feed.example',
      async () => new Response('', { status: 503 })
    );
    await expect(failing.feed.head(signal)).rejects.toThrow('HTTP 503');
  });
});

describe('AuthorizationServerMetadataSchema', () => {
  it('requires the issuer, key set, and flow lists, and keeps members it does not model', () => {
    const document = {
      issuer: 'https://uts.kiloapps.io',
      jwks_uri: 'https://uts-feed.kiloapps.io/.well-known/jwks.json',
      response_types_supported: [],
      grant_types_supported: [],
      token_endpoint: 'https://uts.kiloapps.io/token',
    };
    expect(AuthorizationServerMetadataSchema.parse(document)).toEqual(document);
    expect(
      AuthorizationServerMetadataSchema.safeParse({ ...document, jwks_uri: undefined }).success
    ).toBe(false);
    expect(
      AuthorizationServerMetadataSchema.safeParse({ ...document, grant_types_supported: undefined })
        .success
    ).toBe(false);
  });
});
