/**
 * Local end-to-end run of the revocation feed against `wrangler dev --env local` (mint and feed
 * Workers) and the local identity store, plus the verifier Worker of
 * `services/uts-feed/test/fixtures/e2e` for the service-binding path. It checks that a revoke
 * reaches the feed within the bound, that the backfill adds an entry no publish carried, that the
 * feed keeps serving while feed object 0 is stopped, that the head age stays bounded, and that
 * every head verifies under a feed key of the published key set. Synthetic data only; it prints
 * grant ids and kids, never a token.
 *
 *   UTS_E2E_BASE_URL    the mint Worker, such as http://127.0.0.1:8940
 *   UTS_E2E_FEED_URL    the feed Worker, such as http://127.0.0.1:8941
 *   UTS_E2E_READER_URL  the verifier Worker, such as http://127.0.0.1:8942
 *   UTS_E2E_ADMIN_URL   admin login to the identity-store database (loopback only)
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  FEED_HEAD_TYPE,
  FeedHeadPayloadSchema,
  RevocationListWireSchema,
  UTS_ENDPOINTS,
  UTS_FEED_KID_PREFIX,
  UtsBootstrapWireSchema,
  UtsJwksSchema,
  decodeBase64Url,
  httpsFeedSources,
  type RevocationListWire,
} from '@kilocode/uts-contracts';
import {
  SignJWT,
  calculateJwkThumbprint,
  compactVerify,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  importJWK,
} from 'jose';
import pg from 'pg';
import { z } from 'zod';
import { isLoopbackHost } from './connection';

const base = z.url().parse(process.env.UTS_E2E_BASE_URL);
const feedUrl = z.url().parse(process.env.UTS_E2E_FEED_URL);
const readerUrl = z.url().parse(process.env.UTS_E2E_READER_URL);
const adminUrl = z.url().parse(process.env.UTS_E2E_ADMIN_URL);
if (!isLoopbackHost(new URL(adminUrl))) throw new Error('the end-to-end run uses a local database');

const issuer = UTS_ENDPOINTS.development.issuer;
const ACCOUNT = 'dev:uts-local';
const CALLBACK = 'http://127.0.0.1:4100/callback';
/**
 * The feed Worker serves no head over 20 s old: its `iat` is the object's last good backfill (every
 * 5 s, given up after 10 s) and the data center's cache adds 5 s.
 */
const HEAD_AGE_BOUND_S = 20;
const sources = httpsFeedSources(feedUrl);
let failed = 0;

function log(step: string, detail: unknown, ok = true) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step.padEnd(44)} ${JSON.stringify(detail)}`);
}

type Opened = { kid: string; iat: number; list: RevocationListWire };

/** Verifies a head under the feed key of the published key set, then its list by hash. */
async function open(head: string, listOf: (hash: string) => Promise<Uint8Array>): Promise<Opened> {
  const header = z
    .object({ alg: z.literal('EdDSA'), typ: z.literal(FEED_HEAD_TYPE), kid: z.string() })
    .parse(decodeProtectedHeader(head));
  if (!header.kid.startsWith(UTS_FEED_KID_PREFIX)) throw new Error(`not a feed kid ${header.kid}`);
  const jwks = UtsJwksSchema.parse(
    await (await fetch(new URL('.well-known/jwks.json', feedUrl))).json()
  );
  const jwk = jwks.keys.find(key => key.kid === header.kid);
  if (jwk === undefined) throw new Error(`kid ${header.kid} is not in the key set`);
  const { payload } = await compactVerify(head, await importJWK(jwk, 'EdDSA'));
  const claims = FeedHeadPayloadSchema.parse(JSON.parse(new TextDecoder().decode(payload)));
  const bytes = await listOf(claims.list_hash);
  const hash = createHash('sha256').update(bytes).digest('base64url');
  if (hash !== claims.list_hash) throw new Error('list does not match the head hash');
  const list = RevocationListWireSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  return { kid: header.kid, iat: claims.iat, list };
}

const signal = () => AbortSignal.timeout(5000);
const readFeed = async () =>
  await open(await sources.feed.head(signal()), hash => sources.feed.list(hash, signal()));

/** Polls the feed until `found` holds; answers the seconds it took, or null after `limitS`. */
async function until(found: (opened: Opened) => boolean, limitS: number): Promise<number | null> {
  const started = Date.now();
  while (Date.now() - started < limitS * 1000) {
    try {
      if (found(await readFeed())) return (Date.now() - started) / 1000;
    } catch {
      // An unavailable read counts as not yet.
    }
    await sleep(250);
  }
  return null;
}

async function dpop() {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const jwk = await exportJWK(publicKey);
  return {
    jkt: await calculateJwkThumbprint(jwk, 'sha256'),
    proof: (path: string) =>
      new SignJWT({
        jti: randomUUID(),
        htm: 'POST',
        htu: `${issuer}${path}`,
        iat: Math.floor(Date.now() / 1000),
      })
        .setProtectedHeader({ alg: 'EdDSA', typ: 'dpop+jwt', jwk })
        .sign(privateKey),
  };
}

/** A first-party grant through the development sign-in; answers its refresh token and grant id. */
async function firstPartyGrant(): Promise<{ refreshToken: string; grantId: string }> {
  const device = await dpop();
  const verifier = randomBytes(32).toString('base64url');
  const authorize = new URL('authorize', base);
  for (const [name, value] of Object.entries({
    response_type: 'code',
    client_id: 'kilo-cli',
    redirect_uri: CALLBACK,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    scope: 'gateway:models.read',
    state: 'feed-e2e',
    dpop_jkt: device.jkt,
  })) {
    authorize.searchParams.set(name, value);
  }
  const redirect = await fetch(authorize, { redirect: 'manual' });
  const code = new URL(redirect.headers.get('Location') ?? 'about:blank').searchParams.get('code');
  if (code === null) throw new Error(`authorize answered ${redirect.status}`);
  const response = await fetch(new URL('token', base), {
    method: 'POST',
    headers: { DPoP: await device.proof('/token') },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK,
      client_id: 'kilo-cli',
      code_verifier: verifier,
    }),
  });
  const refreshToken = z
    .object({ refresh_token: z.string() })
    .parse(await response.json()).refresh_token;
  const grantId = Buffer.from(refreshToken.slice(8, 30), 'base64url').toString('hex');
  const uuid = `${grantId.slice(0, 8)}-${grantId.slice(8, 12)}-${grantId.slice(12, 16)}-${grantId.slice(16, 20)}-${grantId.slice(20)}`;
  return { refreshToken, grantId: uuid };
}

async function revoke(refreshToken: string): Promise<number> {
  const response = await fetch(new URL('revoke', base), {
    method: 'POST',
    body: new URLSearchParams({ token: refreshToken, client_id: 'kilo-cli' }),
  });
  return response.status;
}

async function stopFeed(feed: number, seconds: number): Promise<number> {
  const response = await fetch(new URL('__dev/feed/stop', base), {
    method: 'POST',
    body: JSON.stringify({ feed, seconds }),
  });
  return z.object({ until: z.number() }).parse(await response.json()).until;
}

/** Reads the feed for `seconds`, answering the oldest head age seen, the kids, and failed reads. */
async function watch(seconds: number) {
  let maxAge = 0;
  let failures = 0;
  const kids = new Set<string>();
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    try {
      const opened = await readFeed();
      kids.add(opened.kid.slice(0, UTS_FEED_KID_PREFIX.length + 1));
      maxAge = Math.max(maxAge, Math.floor(Date.now() / 1000) - opened.iat);
    } catch {
      failures += 1;
    }
    await sleep(500);
  }
  return { maxAge, failures, kids: [...kids].sort() };
}

async function main() {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query('SET ROLE uts_owner');
  await admin.query(
    `INSERT INTO uts.accounts (id, primary_email) VALUES ($1, 'feed-e2e@example.com') ON CONFLICT DO NOTHING`,
    [ACCOUNT]
  );

  const ready = await until(() => true, 60);
  log('feed serves a signed head', { seconds: ready }, ready !== null);
  const first = await readFeed();
  log('head verifies under a published feed key', { kid: first.kid, iat: first.iat });

  const grant = await firstPartyGrant();
  const revokedAt = Date.now();
  const status = await revoke(grant.refreshToken);
  const seen = await until(opened => opened.list.revoked_sids.includes(grant.grantId), 30);
  log(
    'revoke reaches the feed within 11 s',
    {
      grantId: grant.grantId,
      status,
      seconds: seen,
      sinceRevokeCall: (Date.now() - revokedAt) / 1000,
    },
    status === 200 && seen !== null && seen <= HEAD_AGE_BOUND_S
  );

  const subject = `e2e-subject-${randomUUID()}`;
  await admin.query(
    `INSERT INTO uts.revocations (kind, subject_id, revoked_before, feed_expires_at)
     VALUES ('subject', $1, now(), now() + interval '20 minutes')`,
    [subject]
  );
  const backfilled = await until(opened => subject in opened.list.revoked_before, 40);
  log(
    'backfill adds an entry no publish carried within 16 s',
    { subject, seconds: backfilled },
    backfilled !== null && backfilled <= 16
  );

  const stopUntil = await stopFeed(0, 90);
  const during = await firstPartyGrant();
  const duringStatus = await revoke(during.refreshToken);
  const duringSeen = await until(opened => opened.list.revoked_sids.includes(during.grantId), 30);
  log(
    'feed object 0 stopped: a revoke still reaches the feed',
    {
      grantId: during.grantId,
      status: duringStatus,
      seconds: duringSeen,
    },
    duringStatus === 200 && duringSeen !== null && duringSeen <= HEAD_AGE_BOUND_S
  );
  const stopped = await watch(Math.max(5, (stopUntil - Date.now()) / 1000 - 5));
  log(
    'feed object 0 stopped: the feed serves from object 1',
    stopped,
    stopped.kids.join() === 'uts-feed-1' && stopped.maxAge <= HEAD_AGE_BOUND_S
  );

  const reader = await fetch(new URL('head', readerUrl));
  const readerHead = await reader.text();
  const viaBinding = await open(readerHead, async hash => {
    const response = await fetch(new URL(`list/${hash}`, readerUrl));
    return new Uint8Array(await response.arrayBuffer());
  });
  log(
    'service binding: head and list verify',
    { status: reader.status, kid: viaBinding.kid },
    viaBinding.list.revoked_sids.includes(during.grantId)
  );
  const boot = UtsBootstrapWireSchema.parse(
    await (await fetch(new URL('bootstrap', readerUrl))).json()
  );
  const bootList = RevocationListWireSchema.parse(
    JSON.parse(new TextDecoder().decode(decodeBase64Url(boot.list)))
  );
  log(
    'service binding: bootstrap carries key set, head and list',
    {
      keys: UtsJwksSchema.parse(boot.jwks).keys.length,
      entries: bootList.revoked_sids.length,
    },
    bootList.revoked_sids.includes(grant.grantId)
  );

  await sleep(Math.max(0, stopUntil - Date.now()) + 35_000);
  const after = await watch(20);
  log(
    'after the stop: object 0 serves again, head age bounded',
    after,
    after.kids.includes('uts-feed-0') && after.maxAge <= HEAD_AGE_BOUND_S && after.failures === 0
  );

  await admin.end();
  console.log(`${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

await main();
