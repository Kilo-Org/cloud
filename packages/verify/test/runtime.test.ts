import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import { unstable_startWorker } from 'wrangler';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import { createPatString, hashPat } from '../src/index';

// Runs the verifier in local workerd, where each fetch is its own request with its own context.
// A promise created for one request and settled or awaited in another stalls there and makes
// workerd log "different request context"; plain Node cannot show that, so only this test proves
// that the key-set, feed, bootstrap and PAT caches share plain data across requests, never a
// promise, and that `warm` keeps its fetches alive under the request's waitUntil.

/** The part of wrangler's local Worker handle this test uses. */
type LocalWorker = {
  ready: Promise<void>;
  fetch(
    url: string,
    init?: { method?: string; body?: string; headers?: Record<string, string> }
  ): Promise<{ json(): Promise<unknown>; text(): Promise<string> }>;
  dispose(): Promise<void>;
};

const ReplySchema = z.union([
  z.strictObject({ ok: z.literal(true), caller: z.string() }),
  z.strictObject({ ok: z.literal(false), status: z.number(), reason: z.string() }),
]);
const CallsSchema = z.strictObject({
  stsJwks: z.number(),
  utsJwks: z.number(),
  feed: z.number(),
  bootstrap: z.number(),
  pat: z.number(),
});
type Calls = z.infer<typeof CallsSchema>;
const NO_CALLS: Calls = { stsJwks: 0, utsJwks: 0, feed: 0, bootstrap: 0, pat: 0 };

/** workerd's warning when a promise is settled after the request that created it ended. */
const CROSS_REQUEST_WARNING = /different request context/;

/** Every dependency stand-in answers after this long, so concurrent requests overlap on it. */
const DELAY_MS = 500;

let worker: LocalWorker;
let workerdLogs: string[];

beforeEach(async () => {
  workerdLogs = [];
  worker = await unstable_startWorker({
    config: decodeURIComponent(
      new URL('./fixtures/runtime/wrangler.jsonc', import.meta.url).pathname
    ),
    dev: {
      server: { port: 0 },
      inspector: false,
      watch: false,
      logLevel: 'error',
      structuredLogsHandler: (log: { message: string }) => workerdLogs.push(log.message),
    },
  });
  await worker.ready;
}, 60_000);

afterEach(async () => {
  await worker.dispose();
});

type Signer = { token: string; jwk: Record<string, unknown> };

async function signedToken(claims: Record<string, unknown>, kidPrefix: string): Promise<Signer> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { extractable: true });
  const exported = await exportJWK(publicKey);
  const kid = `${kidPrefix}${await calculateJwkThumbprint(exported)}`;
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    scope: 'session-ingest:events.write',
    env: 'development',
    ...claims,
  })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid })
    .setAudience('session-ingest')
    .setJti(crypto.randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);
  return { token, jwk: { ...exported, kid } };
}

const stsToken = () =>
  signedToken(
    {
      iss: 'https://sts.runtime.test',
      sub: 'service:cloud-agent-next',
      client_id: 'cloud-agent-next',
      req: 'cloud-agent-next',
    },
    ''
  );

const utsToken = () =>
  signedToken(
    { iss: 'https://uts.runtime.test', sub: 'user-1', client_id: 'kilo-cli', sid: 'grant-1' },
    'uts-token-00-'
  );

async function setup(body: Record<string, unknown>): Promise<void> {
  await worker.fetch('http://runtime.test/setup', {
    method: 'POST',
    body: JSON.stringify({
      stsJwks: { keys: [] },
      utsJwks: { keys: [] },
      delayMs: DELAY_MS,
      pat: null,
      hang: null,
      ...body,
    }),
  });
}

/** The fixture setup for one PAT the stand-in lookup knows. */
async function knownPat(pat: string): Promise<Record<string, unknown>> {
  return {
    hash: await hashPat(pat),
    record: {
      patId: 'pat-1',
      subject: 'user-1',
      audience: 'session-ingest',
      scope: 'session-ingest:events.write',
      org: null,
      expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    },
  };
}

type Cold = 'bootstrap' | 'separate';

async function verify(
  issuer: 'sts' | 'uts',
  credential: string,
  cold: Cold = 'bootstrap'
): Promise<z.infer<typeof ReplySchema>> {
  const reply = await worker.fetch(`http://runtime.test/verify?issuer=${issuer}&cold=${cold}`, {
    headers: { authorization: `Bearer ${credential}` },
  });
  return ReplySchema.parse(await reply.json());
}

async function calls(): Promise<Calls> {
  return CallsSchema.parse(await (await worker.fetch('http://runtime.test/calls')).json());
}

const crossRequestWarnings = () =>
  workerdLogs.filter(message => CROSS_REQUEST_WARNING.test(message));

it('captures the warning workerd logs for a promise settled across requests (control)', async () => {
  // Shows the warning checks below can fail: this settles a promise its creator left behind.
  expect(await (await worker.fetch('http://runtime.test/strand')).text()).toBe('stranded');
  expect(await (await worker.fetch('http://runtime.test/settle')).text()).toBe('settled');
  await expect.poll(() => crossRequestWarnings().length > 0).toBe(true);
}, 30_000);

it('serves two concurrent STS requests on a cold key-set cache from one fetch', async () => {
  const { token, jwk } = await stsToken();
  await setup({ stsJwks: { keys: [jwk] } });

  const replies = await Promise.all([verify('sts', token), verify('sts', token)]);

  expect(replies).toEqual([
    { ok: true, caller: 'service' },
    { ok: true, caller: 'service' },
  ]);
  expect(await calls()).toEqual({ ...NO_CALLS, stsJwks: 1 });
  expect(crossRequestWarnings()).toEqual([]);
}, 30_000);

it('answers a later STS request from the cache the first request filled', async () => {
  const { token, jwk } = await stsToken();
  await setup({ stsJwks: { keys: [jwk] } });
  expect(await verify('sts', token)).toEqual({ ok: true, caller: 'service' });
  expect(await verify('sts', token)).toEqual({ ok: true, caller: 'service' });
  expect(await calls()).toEqual({ ...NO_CALLS, stsJwks: 1 });
  expect(crossRequestWarnings()).toEqual([]);
}, 30_000);

it.each<[Cold, Partial<Calls>]>([
  ['bootstrap', { bootstrap: 1 }],
  ['separate', { utsJwks: 1, feed: 1 }],
])(
  'serves two concurrent UTS requests on a cold UTS state (%s) from one call per source',
  async (cold, expected) => {
    const { token, jwk } = await utsToken();
    await setup({ utsJwks: { keys: [jwk] } });

    const replies = await Promise.all([verify('uts', token, cold), verify('uts', token, cold)]);

    expect(replies).toEqual([
      { ok: true, caller: 'user' },
      { ok: true, caller: 'user' },
    ]);
    expect(await calls()).toEqual({ ...NO_CALLS, ...expected });
    expect(crossRequestWarnings()).toEqual([]);
  },
  30_000
);

it('merges two concurrent lookups of one cold PAT into one lookup', async () => {
  const pat = createPatString();
  await setup({ pat: await knownPat(pat) });

  const replies = await Promise.all([verify('uts', pat), verify('uts', pat)]);

  expect(replies).toEqual([
    { ok: true, caller: 'pat' },
    { ok: true, caller: 'pat' },
  ]);
  expect(await calls()).toEqual({ ...NO_CALLS, bootstrap: 1, pat: 1 });
  expect(crossRequestWarnings()).toEqual([]);
}, 30_000);

it('keeps the fetches warm starts alive under its waitUntil for later requests', async () => {
  const sts = await stsToken();
  const uts = await utsToken();
  await setup({ stsJwks: { keys: [sts.jwk] }, utsJwks: { keys: [uts.jwk] } });

  expect(await (await worker.fetch('http://runtime.test/warm')).text()).toBe('warming');
  const replies = await Promise.all([verify('uts', uts.token), verify('sts', sts.token)]);

  expect(replies).toEqual([
    { ok: true, caller: 'user' },
    { ok: true, caller: 'service' },
  ]);
  expect(await calls()).toEqual({ ...NO_CALLS, stsJwks: 1, bootstrap: 1 });
  expect(crossRequestWarnings()).toEqual([]);
}, 30_000);

// In each race the first request is cancelled while the hung call is in flight: that call never
// answers. The second request must notice the call was abandoned well before the call timeout,
// instead of waiting on it. A key-set, feed or bootstrap call that was abandoned counts as a failed
// one (so cancelling requests cannot make the isolate fetch more often): the second request gets
// a prompt 503. An abandoned PAT lookup lets the second request make its own.

const RaceSchema = z.strictObject({
  first: z.union([z.literal('cancelled'), z.number()]),
  second: z.union([ReplySchema, z.literal('timed_out')]),
  secondMs: z.number(),
});

/** Under the 5 s call timeout: the 1 s abandonment window plus the second request's own calls. */
const PROMPT_MS = 2_500;

async function race(
  issuer: 'sts' | 'uts',
  credential: string,
  cold: Cold
): Promise<z.infer<typeof RaceSchema>> {
  const reply = await worker.fetch(`http://runtime.test/race?issuer=${issuer}&cold=${cold}`, {
    headers: { authorization: `Bearer ${credential}` },
  });
  return RaceSchema.parse(await reply.json());
}

type RaceCase = [
  name: string,
  issuer: 'sts' | 'uts',
  cold: Cold,
  hang: keyof Calls,
  second: z.infer<typeof ReplySchema>,
  calls: Partial<Calls>,
];

it.each<RaceCase>([
  [
    'the STS key set',
    'sts',
    'bootstrap',
    'stsJwks',
    { ok: false, status: 503, reason: 'jwks_unavailable' },
    { stsJwks: 1 },
  ],
  [
    'the UTS key set',
    'uts',
    'separate',
    'utsJwks',
    { ok: false, status: 503, reason: 'jwks_unavailable' },
    { utsJwks: 1 },
  ],
  [
    'the revocation feed',
    'uts',
    'separate',
    'feed',
    { ok: false, status: 503, reason: 'feed_unavailable' },
    { utsJwks: 1, feed: 1 },
  ],
  [
    'the UTS bootstrap',
    'uts',
    'bootstrap',
    'bootstrap',
    { ok: false, status: 503, reason: 'bootstrap_unavailable' },
    { bootstrap: 1 },
  ],
  [
    'a PAT lookup',
    'uts',
    'bootstrap',
    'pat',
    { ok: true, caller: 'pat' },
    { bootstrap: 1, pat: 2 },
  ],
])(
  'answers promptly a request that arrives while a cancelled request was loading %s',
  async (_name, issuer, cold, dependency, second, expectedCalls) => {
    const sts = await stsToken();
    const uts = await utsToken();
    const pat = createPatString();
    // Short delays, so the first request reaches the hung call inside its 100 ms.
    await setup({
      stsJwks: { keys: [sts.jwk] },
      utsJwks: { keys: [uts.jwk] },
      pat: await knownPat(pat),
      delayMs: 10,
      hang: { dependency, call: 1 },
    });
    const credential = issuer === 'sts' ? sts.token : dependency === 'pat' ? pat : uts.token;

    const result = await race(issuer, credential, cold);

    expect(result.first).toBe('cancelled');
    expect(result.second).toEqual(second);
    expect(result.secondMs).toBeLessThan(PROMPT_MS);
    expect(await calls()).toEqual({ ...NO_CALLS, ...expectedCalls });
    expect(crossRequestWarnings()).toEqual([]);
  },
  30_000
);
