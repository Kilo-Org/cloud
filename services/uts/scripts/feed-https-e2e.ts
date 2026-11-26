/**
 * Local end-to-end run of the authenticated HTTPS feed (design 5.6) against
 * `wrangler dev -c wrangler.dev.jsonc` (mint Worker), `wrangler dev --env local` (feed Worker, run
 * with `--var STS_URL:<the stand-in STS>`) and the local identity store. A stand-in STS
 * (`scripts/fake-sts.ts`) serves a synthetic key set and signs service tokens; the feed Worker
 * checks them with `@kilocode/verify`. It checks:
 *
 * - refused callers: no token (401 with a Bearer challenge), a workload the environment does not
 *   admit (403), another audience or scope (403), another environment, an expired token or a key
 *   the STS key set does not hold (401);
 * - admitted callers (`web`, `kilo-gateway`): the head verifies under a feed key of the published
 *   key set, the list matches its hash, the bootstrap carries the key set, its ages and the head age;
 * - a 304 for an unchanged head and for a list the caller holds, also through `httpsFeedSources`;
 * - the verification library itself, as a Vercel verifier would run it, over this transport: one
 *   bootstrap per cold start, then the head and list calls it makes in one minute of steady
 *   checks, while a revocation changes the list hash once; the revoked subject is refused;
 * - with `UTS_E2E_FEED_OFF_URL`, a feed Worker without the switch answers 503 with `Retry-After`.
 *
 * It prints each check with its counts and sizes, never a token. Synthetic data only.
 *
 *   UTS_E2E_FEED_URL      the feed Worker, such as http://127.0.0.1:9402
 *   UTS_E2E_FEED_OFF_URL  optional: a feed Worker run with `--var FEED_HTTPS_ENABLED:false`
 *   UTS_E2E_ADMIN_URL     admin login to the identity-store database (loopback only)
 *   UTS_E2E_STS_PORT      loopback port of the stand-in STS; the feed Worker's `STS_URL` names it
 */
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  FEED_HEAD_TYPE,
  FeedHeadPayloadSchema,
  KILO_API_AUDIENCE,
  RevocationListWireSchema,
  UTS_ENDPOINTS,
  UTS_FEED_AUDIENCE,
  UTS_FEED_KID_PREFIX,
  UTS_FEED_READ_SCOPE,
  UtsBootstrapWireSchema,
  UtsJwksSchema,
  decodeBase64Url,
  httpsFeedSources,
  utsScopeEntry,
  type FeedFetch,
} from '@kilocode/uts-contracts';
import { createVerifier, httpJwksSource } from '@kilocode/verify';
import { compactVerify, decodeProtectedHeader, importJWK } from 'jose';
import pg from 'pg';
import { z } from 'zod';
import { isLoopbackHost } from './connection';
import { startFakeSts } from './fake-sts';

const feedUrl = z.url().parse(process.env.UTS_E2E_FEED_URL);
const feedOffUrl = z.url().optional().parse(process.env.UTS_E2E_FEED_OFF_URL);
const adminUrl = z.url().parse(process.env.UTS_E2E_ADMIN_URL);
if (!isLoopbackHost(new URL(adminUrl))) throw new Error('the end-to-end run uses a local database');
const sts = await startFakeSts(z.coerce.number().int().parse(process.env.UTS_E2E_STS_PORT));

/** The steady window the library runs in, and the pause between its record checks. */
const WINDOW_MS = 65_000;
const CHECK_EVERY_MS = 500;
let failed = 0;

function log(step: string, detail: unknown, ok = true) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step.padEnd(58)} ${JSON.stringify(detail)}`);
}

const url = (path: string) => new URL(path.replace(/^\//, ''), feedUrl).toString();

async function get(path: string, headers: Record<string, string> = {}) {
  const started = performance.now();
  const response = await fetch(url(path), { headers });
  const body = new Uint8Array(await response.arrayBuffer());
  return { response, body, ms: Math.round(performance.now() - started) };
}

const bearer = async (options: Parameters<typeof sts.token>[0] = {}) => ({
  authorization: `Bearer ${await sts.token(options)}`,
});

/** Verifies a head under the feed key of the published key set; answers its claims. */
async function openHead(head: string) {
  const header = z
    .object({ alg: z.literal('EdDSA'), typ: z.literal(FEED_HEAD_TYPE), kid: z.string() })
    .parse(decodeProtectedHeader(head));
  if (!header.kid.startsWith(UTS_FEED_KID_PREFIX)) throw new Error(`not a feed kid ${header.kid}`);
  const jwks = UtsJwksSchema.parse(await (await fetch(url('/.well-known/jwks.json'))).json());
  const jwk = jwks.keys.find(key => key.kid === header.kid);
  if (jwk === undefined) throw new Error(`kid ${header.kid} is not in the key set`);
  const { payload } = await compactVerify(head, await importJWK(jwk, 'EdDSA'));
  return {
    kid: header.kid,
    ...FeedHeadPayloadSchema.parse(JSON.parse(new TextDecoder().decode(payload))),
  };
}

/** Counts each feed request by path and status, with its body size, around a token fetcher. */
function countingFetcher(inner: FeedFetch) {
  const calls: Array<{ path: string; status: number; bytes: number }> = [];
  const fetcher: FeedFetch = async (target, init) => {
    const response = await inner(target, init);
    const bytes = (await response.clone().arrayBuffer()).byteLength;
    const { pathname } = new URL(target);
    calls.push({
      path: pathname.startsWith('/revocation/list/') ? '/revocation/list' : pathname,
      status: response.status,
      bytes,
    });
    return response;
  };
  const count = (path: string, status?: number) =>
    calls.filter(call => call.path === path && (status === undefined || call.status === status))
      .length;
  return { fetcher, calls, count };
}

async function refusals() {
  const missing = await get('/revocation/head');
  log(
    'no token: 401 with a Bearer challenge',
    { status: missing.response.status },
    missing.response.status === 401 &&
      (missing.response.headers.get('www-authenticate') ?? '').startsWith('Bearer ')
  );
  const cases = [
    ['a workload the environment does not admit (o11y)', { workload: 'o11y' }, 403],
    ['another audience (uts)', { audience: 'uts' }, 403],
    ['another scope', { scope: 'uts-feed:revocation.write' }, 403],
    ['another environment (staging)', { environment: 'staging' }, 401],
    ['an expired token', { expired: true }, 401],
    ['a key the STS key set does not hold', { foreignKey: true }, 401],
  ] as const;
  for (const [name, options, status] of cases) {
    for (const path of ['/revocation/head', '/revocation/bootstrap']) {
      const answer = await get(path, await bearer(options));
      log(
        `refused ${path}: ${name}`,
        { status: answer.response.status },
        answer.response.status === status
      );
    }
  }
}

async function admitted() {
  for (const workload of ['web', 'kilo-gateway']) {
    const headers = await bearer({ workload });
    const head = await get('/revocation/head', headers);
    const text = new TextDecoder().decode(head.body);
    const opened = await openHead(text);
    const age = Number(head.response.headers.get('kilo-feed-head-age'));
    log(
      `${workload}: head 200, verifies under a feed key`,
      { kid: opened.kid, bytes: head.body.byteLength, headAge: age, ms: head.ms },
      head.response.status === 200 && age <= 20
    );
    const list = await get(`/revocation/list/${opened.list_hash}`, headers);
    const hash = createHash('sha256').update(list.body).digest('base64url');
    RevocationListWireSchema.parse(JSON.parse(new TextDecoder().decode(list.body)));
    log(
      `${workload}: list 200 matches the head's hash`,
      {
        bytes: list.body.byteLength,
        cache: list.response.headers.get('cache-control'),
        ms: list.ms,
      },
      list.response.status === 200 && hash === opened.list_hash
    );
    const boot = await get('/revocation/bootstrap', headers);
    const body = UtsBootstrapWireSchema.parse(JSON.parse(new TextDecoder().decode(boot.body)));
    const bootHead = await openHead(body.head);
    const bootHash = createHash('sha256').update(decodeBase64Url(body.list)).digest('base64url');
    log(
      `${workload}: bootstrap carries key set, ages, head and list`,
      {
        keys: UtsJwksSchema.parse(body.jwks).keys.length,
        keyAges: body.key_ages,
        headAge: Number(boot.response.headers.get('kilo-feed-head-age')),
        bytes: boot.body.byteLength,
        ms: boot.ms,
      },
      boot.response.status === 200 &&
        bootHash === bootHead.list_hash &&
        boot.response.headers.get('age') === String(body.key_ages.newest)
    );
  }
}

async function conditional() {
  const headers = await bearer({ workload: 'kilo-gateway' });
  // The head changes at each backfill (every 5 s); a few tries find two reads of one head.
  let head304: { status: number; bytes: number } | null = null;
  for (let attempt = 0; attempt < 5 && head304?.status !== 304; attempt += 1) {
    const first = await get('/revocation/head', headers);
    const etag = first.response.headers.get('etag') ?? '';
    const again = await get('/revocation/head', { ...headers, 'if-none-match': etag });
    head304 = { status: again.response.status, bytes: again.body.byteLength };
  }
  log(
    'head: 304 with no body for the ETag the caller holds',
    head304,
    head304?.status === 304 && head304.bytes === 0
  );

  const opened = await openHead(
    new TextDecoder().decode((await get('/revocation/head', headers)).body)
  );
  const list304 = await get(`/revocation/list/${opened.list_hash}`, {
    ...headers,
    'if-none-match': `"${opened.list_hash}"`,
  });
  log(
    'list: 304 for the hash the caller holds',
    { status: list304.response.status, bytes: list304.body.byteLength },
    list304.response.status === 304
  );

  const counted = countingFetcher(sts.fetcher('web'));
  const sources = httpsFeedSources(feedUrl, counted.fetcher);
  let same = false;
  for (let attempt = 0; attempt < 5 && !same; attempt += 1) {
    const a = await sources.feed.head(AbortSignal.timeout(5000));
    const b = await sources.feed.head(AbortSignal.timeout(5000));
    same = a === b && counted.calls.at(-1)?.status === 304;
  }
  log(
    'httpsFeedSources: an unchanged head comes back as a 304',
    { calls: counted.calls.map(call => call.status) },
    same
  );
}

/**
 * The library as a Vercel verifier runs it: cold, then one record check every 500 ms for 65 s,
 * with one subject revocation inserted after 20 s. Counts every call the transport makes.
 */
async function library(admin: pg.Client) {
  const counted = countingFetcher(sts.fetcher('web'));
  const sources = httpsFeedSources(feedUrl, counted.fetcher);
  const verifier = createVerifier({
    audience: KILO_API_AUDIENCE,
    environment: 'development',
    resourceMetadataUrl: `${feedUrl}.well-known/oauth-protected-resource`,
    uts: {
      issuer: UTS_ENDPOINTS.development.issuer,
      jwks: httpJwksSource(new URL(feedUrl).origin),
      scopeRegistry: (audience, scope) => {
        const entry = utsScopeEntry(scope);
        return entry === null || entry.audience !== audience ? null : entry;
      },
      revocation: sources.feed,
      bootstrap: sources.bootstrap,
    },
  });
  const pending: Array<Promise<unknown>> = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => void pending.push(promise) };
  const subject = `https-e2e-${randomUUID()}`;
  const record = { sub: subject, sid: randomUUID(), issuedAt: Math.floor(Date.now() / 1000) - 60 };

  const cold = await verifier.checkBrowserSession(record, ctx);
  log(
    'library cold start: one bootstrap, then the record passes',
    { bootstraps: counted.count('/revocation/bootstrap'), ok: cold.ok },
    cold.ok && counted.count('/revocation/bootstrap') === 1
  );

  const started = Date.now();
  let revokedAt: number | null = null;
  let refusedAfter: number | null = null;
  while (Date.now() - started < WINDOW_MS) {
    if (revokedAt === null && Date.now() - started > 20_000) {
      await admin.query(
        `INSERT INTO uts.revocations (kind, subject_id, revoked_before, feed_expires_at)
         VALUES ('subject', $1, now(), now() + interval '20 minutes')`,
        [subject]
      );
      revokedAt = Date.now();
    }
    const result = await verifier.checkBrowserSession(record, ctx);
    if (!result.ok && result.status === 401 && revokedAt !== null && refusedAfter === null) {
      refusedAfter = (Date.now() - revokedAt) / 1000;
    }
    await Promise.allSettled(pending.splice(0));
    await sleep(CHECK_EVERY_MS);
  }
  const minutes = WINDOW_MS / 60_000;
  const heads = counted.count('/revocation/head');
  const lists = counted.count('/revocation/list');
  const listBytes = counted.calls
    .filter(call => call.path === '/revocation/list')
    .map(call => call.bytes);
  log(
    'library steady window: head and list calls (per minute)',
    {
      windowSeconds: WINDOW_MS / 1000,
      headCalls: heads,
      headCallsPerMinute: Math.round((heads / minutes) * 10) / 10,
      head304: counted.count('/revocation/head', 304),
      listFetches: lists,
      listBytes,
      bootstraps: counted.count('/revocation/bootstrap'),
    },
    heads > 0 && heads / minutes <= 7 && counted.count('/revocation/bootstrap') === 1
  );
  log(
    'library: one list fetch per list change; the revoked subject is refused',
    { listFetchesAfterColdStart: lists, refusedSecondsAfterRevoke: refusedAfter },
    lists >= 1 && lists <= 3 && refusedAfter !== null && refusedAfter <= 45
  );
  log(
    'stand-in STS key set fetched by the feed Worker',
    { fetches: sts.keySetFetches() },
    sts.keySetFetches() >= 1 && sts.keySetFetches() <= 3
  );
}

/**
 * The CPU the feed Worker spends on its caller check, measured in this process as a proxy: the
 * same `@kilocode/verify` STS check, warm key set, over 2,000 tokens. Workers bill CPU time; the
 * Workers runtime hides fine timers, so the proxy runs here.
 */
async function verifyCost() {
  const verifier = createVerifier({
    audience: UTS_FEED_AUDIENCE,
    environment: 'development',
    resourceMetadataUrl: `${feedUrl}.well-known/oauth-protected-resource`,
    sts: {
      issuer: sts.issuer,
      jwks: httpJwksSource(sts.issuer),
      scopeRegistry: { [UTS_FEED_AUDIENCE]: { scopes: [UTS_FEED_READ_SCOPE] } },
    },
  });
  const ctx = { waitUntil: (promise: Promise<unknown>) => void promise };
  const route = { issuer: 'sts', scope: UTS_FEED_READ_SCOPE } as const;
  const warm = await verifier.verify(`Bearer ${await sts.token()}`, route, ctx);
  const tokens = await Promise.all(Array.from({ length: 2000 }, () => sts.token()));
  const started = process.cpuUsage();
  let admitted = 0;
  for (const token of tokens) {
    if ((await verifier.verify(`Bearer ${token}`, route, ctx)).ok) admitted += 1;
  }
  const used = process.cpuUsage(started);
  const microseconds = Math.round((used.user + used.system) / tokens.length);
  log(
    'caller check CPU per request (verify, warm key set)',
    { tokens: tokens.length, admitted, cpuMicrosecondsPerCheck: microseconds },
    warm.ok && admitted === tokens.length
  );
}

async function switchedOff(offUrl: string) {
  for (const path of ['revocation/head', 'revocation/bootstrap']) {
    const response = await fetch(new URL(path, offUrl), { headers: await bearer() });
    await response.body?.cancel();
    log(
      `switch off: ${path} answers 503 with Retry-After`,
      { status: response.status, retryAfter: response.headers.get('retry-after') },
      response.status === 503 && response.headers.get('retry-after') === '60'
    );
  }
}

async function main() {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query('SET ROLE uts_owner');
  const web = await bearer();
  let ready = false;
  for (let attempt = 0; attempt < 120 && !ready; attempt += 1) {
    const answer = await fetch(url('/revocation/head'), { headers: web });
    await answer.body?.cancel();
    ready = answer.status === 200;
    if (!ready) await sleep(500);
  }
  log('feed serves a head to an admitted workload', { ready }, ready);
  if (ready) {
    await refusals();
    await admitted();
    await conditional();
    await library(admin);
    await verifyCost();
  }
  if (feedOffUrl !== undefined) await switchedOff(feedOffUrl);
  await admin.end();
  await sts.close();
  console.log(`${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

await main();
