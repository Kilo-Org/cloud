import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import { unstable_startWorker } from 'wrangler';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import { createPatString, hashPat } from '../src/index';

// Runs the verifier in local workerd, where each fetch is its own request with its own context.
// A promise created for one request and settled or awaited in another stalls there and makes
// workerd log "different request context"; plain Node cannot show that, so only this test proves
// that the key-set, feed and PAT caches share plain data across requests, never a promise.

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
  pat: z.number(),
});

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

async function verify(
  issuer: 'sts' | 'uts',
  credential: string
): Promise<z.infer<typeof ReplySchema>> {
  const reply = await worker.fetch(`http://runtime.test/verify?issuer=${issuer}`, {
    headers: { authorization: `Bearer ${credential}` },
  });
  return ReplySchema.parse(await reply.json());
}

async function calls(): Promise<z.infer<typeof CallsSchema>> {
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
  expect(await calls()).toEqual({ stsJwks: 1, utsJwks: 0, feed: 0, pat: 0 });
  expect(crossRequestWarnings()).toEqual([]);
}, 30_000);

it('answers a later STS request from the cache the first request filled', async () => {
  const { token, jwk } = await stsToken();
  await setup({ stsJwks: { keys: [jwk] } });
  expect(await verify('sts', token)).toEqual({ ok: true, caller: 'service' });
  expect(await verify('sts', token)).toEqual({ ok: true, caller: 'service' });
  expect(await calls()).toEqual({ stsJwks: 1, utsJwks: 0, feed: 0, pat: 0 });
  expect(crossRequestWarnings()).toEqual([]);
}, 30_000);

it('serves two concurrent UTS requests on a cold key set and a cold feed from one fetch each', async () => {
  const { token, jwk } = await utsToken();
  await setup({ utsJwks: { keys: [jwk] } });

  const replies = await Promise.all([verify('uts', token), verify('uts', token)]);

  expect(replies).toEqual([
    { ok: true, caller: 'user' },
    { ok: true, caller: 'user' },
  ]);
  expect(await calls()).toEqual({ stsJwks: 0, utsJwks: 1, feed: 1, pat: 0 });
  expect(crossRequestWarnings()).toEqual([]);
}, 30_000);

it('merges two concurrent lookups of one cold PAT into one lookup', async () => {
  const pat = createPatString();
  await setup({ pat: await knownPat(pat) });

  const replies = await Promise.all([verify('uts', pat), verify('uts', pat)]);

  expect(replies).toEqual([
    { ok: true, caller: 'pat' },
    { ok: true, caller: 'pat' },
  ]);
  expect(await calls()).toEqual({ stsJwks: 0, utsJwks: 0, feed: 1, pat: 1 });
  expect(crossRequestWarnings()).toEqual([]);
}, 30_000);

// In each race the first request is cancelled while the hung call is in flight: that call never
// answers. The second request must notice the call was abandoned and make its own, well before
// the 5 s call timeout, instead of waiting on (or failing with) the cancelled request's call.

const RaceSchema = z.strictObject({
  first: z.union([z.literal('cancelled'), z.number()]),
  second: z.union([ReplySchema, z.literal('timed_out')]),
  secondMs: z.number(),
});

/** Under the 5 s call timeout: the 1 s abandonment window plus the second request's own calls. */
const PROMPT_MS = 2_500;

async function race(
  issuer: 'sts' | 'uts',
  credential: string
): Promise<z.infer<typeof RaceSchema>> {
  const reply = await worker.fetch(`http://runtime.test/race?issuer=${issuer}`, {
    headers: { authorization: `Bearer ${credential}` },
  });
  return RaceSchema.parse(await reply.json());
}

it.each<[string, 'sts' | 'uts', 'stsJwks' | 'utsJwks' | 'feed' | 'pat', Record<string, number>]>([
  ['the STS key set', 'sts', 'stsJwks', { stsJwks: 2, utsJwks: 0, feed: 0, pat: 0 }],
  ['the UTS key set', 'uts', 'utsJwks', { stsJwks: 0, utsJwks: 2, feed: 1, pat: 0 }],
  ['the revocation feed', 'uts', 'feed', { stsJwks: 0, utsJwks: 1, feed: 2, pat: 0 }],
  ['a PAT lookup', 'uts', 'pat', { stsJwks: 0, utsJwks: 0, feed: 1, pat: 2 }],
])(
  'serves a request that arrives while a cancelled request was loading %s',
  async (_name, issuer, dependency, expectedCalls) => {
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

    const result = await race(issuer, credential);

    expect(result.first).toBe('cancelled');
    expect(result.second).toEqual({
      ok: true,
      caller: issuer === 'sts' ? 'service' : dependency === 'pat' ? 'pat' : 'user',
    });
    expect(result.secondMs).toBeLessThan(PROMPT_MS);
    expect(await calls()).toEqual(expectedCalls);
    expect(crossRequestWarnings()).toEqual([]);
  },
  30_000
);
