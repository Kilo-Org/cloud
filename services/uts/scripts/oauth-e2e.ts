/**
 * Local end-to-end run of the OAuth endpoints against `wrangler dev --env local` and the local
 * identity store (README, "Local development"): code, token, refresh, a replayed DPoP proof, a
 * proof of one device key replayed at another grant of that key, a code exchange whose signing
 * fails and its retry, two concurrent exchanges of one code, a second use of a code, third-party
 * rotation, reuse (the family is revoked), a blocked third-party client, a streamed oversized
 * body, revoke and introspect, then the audit rows from the database and a timing of the mint
 * path. Synthetic data only; it prints token ids (`jti`), never a token.
 *
 *   UTS_E2E_BASE_URL   the mint Worker, such as http://127.0.0.1:8800
 *   UTS_E2E_ADMIN_URL  admin login to the identity-store database (loopback only), for the seed
 *                      and the audit read
 *   UTS_E2E_APP_URL    app login to the same database, for the statement timing
 *   UTS_E2E_TIMING     mint calls to time (default 200)
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { UTS_ENDPOINTS } from '@kilocode/uts-contracts';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import pg from 'pg';
import { z } from 'zod';
import { isLoopbackHost } from './connection';

const base = z.url().parse(process.env.UTS_E2E_BASE_URL);
const adminUrl = z.url().parse(process.env.UTS_E2E_ADMIN_URL);
const appUrl = z.url().parse(process.env.UTS_E2E_APP_URL);
const timingRuns = z.coerce
  .number()
  .int()
  .positive()
  .parse(process.env.UTS_E2E_TIMING ?? '200');
for (const url of [adminUrl, appUrl]) {
  if (!isLoopbackHost(new URL(url))) {
    throw new Error('the end-to-end run uses a local database only');
  }
}

const issuer = UTS_ENDPOINTS.development.issuer;
const ACCOUNT = 'dev:uts-local';
const THIRD_PARTY = `https://client.example.com/${randomUUID()}`;
const CALLBACK = 'http://127.0.0.1:4100/callback';
const TokenSchema = z.looseObject({
  access_token: z.string(),
  issued_tokens: z.array(
    z.object({ access_token: z.string(), audience: z.string(), scope: z.string() })
  ),
  refresh_token: z.string().optional(),
});
const secrets: string[] = [];
const sha256 = (value: string) => createHash('sha256').update(value).digest();

function log(step: string, detail: unknown) {
  console.log(`${step.padEnd(34)} ${JSON.stringify(detail)}`);
}

function jtiOf(token: string): string {
  secrets.push(token);
  const payload: unknown = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  return z.object({ jti: z.string() }).parse(payload).jti;
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

async function post(
  path: string,
  fields: Record<string, string>,
  proof?: string,
  headers: Record<string, string> = {}
) {
  const response = await fetch(`${base}${path.slice(1)}`, {
    method: 'POST',
    body: new URLSearchParams(fields),
    headers: proof === undefined ? headers : { ...headers, DPoP: proof },
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
}

async function authorize(params: Record<string, string>): Promise<string> {
  const url = new URL('authorize', base);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const response = await fetch(url, { redirect: 'manual' });
  const location = new URL(response.headers.get('Location') ?? 'about:blank');
  const code = location.searchParams.get('code');
  if (response.status !== 302 || code === null) {
    throw new Error(`authorize answered ${response.status} ${location.searchParams.get('error')}`);
  }
  log('authorize', {
    status: 302,
    state: location.searchParams.get('state'),
    iss: location.searchParams.get('iss'),
  });
  return code;
}

/**
 * POSTs `count` copies of `chunk` with chunked transfer encoding, so the request carries no
 * `Content-Length`, on a connection of its own.
 */
function postChunked(
  path: string,
  chunk: string,
  count: number
): Promise<{ status: number; body: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
  let answered = false;
  const outgoing = request(
    `${base}${path.slice(1)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Connection: 'close' },
    },
    incoming => {
      answered = true;
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (part: string) => {
        body += part;
      });
      incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, body }));
    }
  );
  // The Worker may answer and close before every chunk is sent; only an error before the answer
  // fails the call.
  outgoing.on('error', error => {
    if (!answered) reject(error);
  });
  for (let sent = 0; sent < count; sent += 1) outgoing.write(chunk);
  outgoing.end();
  return promise;
}

async function seed(admin: pg.Client): Promise<string> {
  await admin.query('SET ROLE uts_owner');
  await admin.query(
    `INSERT INTO uts.accounts (id, primary_email) VALUES ($1, 'e2e@example.com') ON CONFLICT DO NOTHING`,
    [ACCOUNT]
  );
  await admin.query(
    `INSERT INTO uts.third_party_clients (client_id, client_name, redirect_uris, document, fetched_at, cache_expires_at)
     VALUES ($1, 'E2E client', '{https://client.example.com/callback}', '{}', now(), now() + interval '1 hour')`,
    [THIRD_PARTY]
  );
  const session = await admin.query<{ id: string }>(
    `INSERT INTO uts.browser_sessions (account_id, token_hash, auth_time, amr, idle_expires_at, expires_at)
     VALUES ($1, $2, now(), '{passkey}', now() + interval '14 days', now() + interval '30 days') RETURNING id`,
    [ACCOUNT, randomBytes(32)]
  );
  const pass = await admin.query<{ id: string }>(
    `INSERT INTO uts.gate_passes (account_id, browser_session_id, tier, action, satisfied_by, expires_at)
     VALUES ($1, $2, 'b', 'third_party_approve', '{recent_sign_in}', now() + interval '10 minutes') RETURNING id`,
    [ACCOUNT, session.rows[0].id]
  );
  const consent = await admin.query<{ id: string }>(
    `INSERT INTO uts.third_party_consents (account_id, client_id, scopes, gate_pass_id)
     VALUES ($1, $2, '{mcp:tools.read}', $3) RETURNING id`,
    [ACCOUNT, THIRD_PARTY, pass.rows[0].id]
  );
  return consent.rows[0].id;
}

function percentile(samples: number[], fraction: number): string {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)].toFixed(1);
}

async function main() {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const consentId = await seed(admin);
  const startId = (
    await admin.query<{ id: string }>('SELECT coalesce(max(id), 0) AS id FROM uts.audit_events')
  ).rows[0].id;

  // First party: code with PKCE and a DPoP key, token, refresh.
  const device = await dpop();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = sha256(verifier).toString('base64url');
  const code = await authorize({
    response_type: 'code',
    client_id: 'kilo-cli',
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'gateway:models.read kilo-chat:messages.read',
    state: 'e2e',
    dpop_jkt: device.jkt,
  });
  secrets.push(code);
  const exchanged = await post(
    '/token',
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK,
      client_id: 'kilo-cli',
      code_verifier: verifier,
    },
    await device.proof('/token')
  );
  const first = TokenSchema.parse(exchanged.body);
  const grant = z.string().parse(first.refresh_token);
  secrets.push(grant);
  log('token (authorization_code)', {
    status: exchanged.status,
    jtis: first.issued_tokens.map(token => jtiOf(token.access_token)),
  });

  const refreshed = await post(
    '/token',
    {
      grant_type: 'refresh_token',
      refresh_token: grant,
      client_id: 'kilo-cli',
      scope: 'gateway:models.read',
    },
    await device.proof('/token')
  );
  log('refresh (first party, DPoP)', {
    status: refreshed.status,
    jtis: TokenSchema.parse(refreshed.body).issued_tokens.map(token => jtiOf(token.access_token)),
  });
  const otherKey = await dpop();
  const stolen = await post(
    '/token',
    { grant_type: 'refresh_token', refresh_token: grant, client_id: 'kilo-cli' },
    await otherKey.proof('/token')
  );
  log('refresh with another device key', { status: stolen.status, body: stolen.body });

  // A replayed DPoP proof: the grant statement finds its jti recorded.
  const once = await device.proof('/token');
  const refreshOnce = {
    grant_type: 'refresh_token',
    refresh_token: grant,
    client_id: 'kilo-cli',
    scope: 'gateway:models.read',
  };
  const firstUse = await post('/token', refreshOnce, once);
  const replayed = await post('/token', refreshOnce, once);
  log('refresh, then the same proof again', {
    first: firstUse.status,
    replayed: replayed.status,
    body: replayed.body,
  });

  // The signing fails after the code exchange committed; the retry gets the same grant.
  const retryCode = await authorize({
    response_type: 'code',
    client_id: 'kilo-cli',
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'gateway:models.read',
    state: 'e2e-retry',
    dpop_jkt: device.jkt,
  });
  secrets.push(retryCode);
  const exchange = {
    grant_type: 'authorization_code',
    code: retryCode,
    redirect_uri: CALLBACK,
    client_id: 'kilo-cli',
    code_verifier: verifier,
  };
  const unsigned = await post('/token', exchange, await device.proof('/token'), {
    'Kilo-Dev-Signing': 'unavailable',
  });
  const retried = await post('/token', exchange, await device.proof('/token'));
  const retriedGrant = z.string().parse(TokenSchema.parse(retried.body).refresh_token);
  secrets.push(retriedGrant);
  const grantOfCode = (
    await admin.query<{ grant_id: string; status: string; grants: number }>(
      `SELECT code.grant_id, grant_row.status,
              (SELECT count(*)::int FROM uts.refresh_grants AS other WHERE other.id = code.grant_id) AS grants
       FROM uts.authorization_codes AS code
       JOIN uts.refresh_grants AS grant_row ON grant_row.id = code.grant_id
       WHERE code.code_hash = $1`,
      [sha256(retryCode)]
    )
  ).rows[0];
  const namedGrant = Buffer.from(retriedGrant.slice(8, 30), 'base64url').toString('hex');
  log('code exchange, signer unavailable', { status: unsigned.status, body: unsigned.body });
  log('the same exchange again', {
    status: retried.status,
    sameGrant: namedGrant === grantOfCode.grant_id.replaceAll('-', ''),
    grantStatus: grantOfCode.status,
    grantsForCode: grantOfCode.grants,
  });

  // Two exchanges of one code at once (a client that retried while the first answer was still
  // on its way): both answers carry the one refresh token the grant holds.
  const raceCode = await authorize({
    response_type: 'code',
    client_id: 'kilo-cli',
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'gateway:models.read',
    state: 'e2e-race',
    dpop_jkt: device.jkt,
  });
  secrets.push(raceCode);
  const raceExchange = { ...exchange, code: raceCode };
  const [raceA, raceB] = await Promise.all([
    device.proof('/token').then(proof => post('/token', raceExchange, proof)),
    device.proof('/token').then(proof => post('/token', raceExchange, proof)),
  ]);
  const raceTokens = [raceA, raceB].map(answer =>
    z.string().parse(TokenSchema.parse(answer.body).refresh_token)
  );
  secrets.push(...raceTokens);
  const raceRefresh = await post(
    '/token',
    { grant_type: 'refresh_token', refresh_token: raceTokens[0], client_id: 'kilo-cli' },
    await device.proof('/token')
  );
  log('two exchanges of one code at once', {
    statuses: [raceA.status, raceB.status],
    sameRefreshToken: raceTokens[0] === raceTokens[1],
    refreshAfterwards: raceRefresh.status,
  });

  // One device key holds both grants: a proof accepted for one is refused at the other.
  const sharedProof = await device.proof('/token');
  const atFirstGrant = await post('/token', { ...refreshOnce, refresh_token: grant }, sharedProof);
  const atOtherGrant = await post(
    '/token',
    { ...refreshOnce, refresh_token: retriedGrant },
    sharedProof
  );
  log('one proof at two grants of a key', {
    first: atFirstGrant.status,
    other: atOtherGrant.status,
    body: atOtherGrant.body,
  });

  // A second use of that code with another verifier still revokes the grant.
  const reused = await post(
    '/token',
    { ...exchange, code_verifier: randomBytes(32).toString('base64url') },
    await device.proof('/token')
  );
  const afterCodeReuse = await post(
    '/token',
    { grant_type: 'refresh_token', refresh_token: retriedGrant, client_id: 'kilo-cli' },
    await device.proof('/token')
  );
  log('the code with another verifier', { status: reused.status, body: reused.body });
  log('refresh of that grant afterwards', {
    status: afterCodeReuse.status,
    body: afterCodeReuse.body,
  });

  // Third party: code, token, rotation, and reuse of the replaced token at once (no grace).
  const thirdCode = await authorize({
    response_type: 'code',
    client_id: THIRD_PARTY,
    redirect_uri: 'https://client.example.com/callback',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'mcp:tools.read',
    state: 'e2e-3p',
    dev_consent_id: consentId,
  });
  secrets.push(thirdCode);
  const thirdToken = TokenSchema.parse(
    (
      await post('/token', {
        grant_type: 'authorization_code',
        code: thirdCode,
        redirect_uri: 'https://client.example.com/callback',
        client_id: THIRD_PARTY,
        code_verifier: verifier,
      })
    ).body
  );
  const t1 = z.string().parse(thirdToken.refresh_token);
  secrets.push(t1);
  log('token (third party)', {
    jtis: thirdToken.issued_tokens.map(token => jtiOf(token.access_token)),
  });
  const rotated = await post('/token', {
    grant_type: 'refresh_token',
    refresh_token: t1,
    client_id: THIRD_PARTY,
  });
  const t2 = z.string().parse(TokenSchema.parse(rotated.body).refresh_token);
  secrets.push(t2);
  log('rotate (third party)', { status: rotated.status, rotated: t2 !== t1 });
  const introspected = await post('/introspect', { token: t2, client_id: THIRD_PARTY });
  log('introspect rotated token', introspected.body);
  const reuse = await post('/token', {
    grant_type: 'refresh_token',
    refresh_token: t1,
    client_id: THIRD_PARTY,
  });
  log('reuse of the replaced token', { status: reuse.status, body: reuse.body });
  const afterReuse = await post('/token', {
    grant_type: 'refresh_token',
    refresh_token: t2,
    client_id: THIRD_PARTY,
  });
  log('current token after reuse', { status: afterReuse.status, body: afterReuse.body });
  log(
    'introspect after reuse',
    (await post('/introspect', { token: t2, client_id: THIRD_PARTY })).body
  );

  // The client authorizes again (its consent stands), and then it is blocked.
  const againCode = await authorize({
    response_type: 'code',
    client_id: THIRD_PARTY,
    redirect_uri: 'https://client.example.com/callback',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'mcp:tools.read',
    state: 'e2e-3p-again',
    dev_consent_id: consentId,
  });
  secrets.push(againCode);
  const again = await post('/token', {
    grant_type: 'authorization_code',
    code: againCode,
    redirect_uri: 'https://client.example.com/callback',
    client_id: THIRD_PARTY,
    code_verifier: verifier,
  });
  const t3 = z.string().parse(TokenSchema.parse(again.body).refresh_token);
  secrets.push(t3);
  await admin.query(`UPDATE uts.third_party_clients SET status = 'blocked' WHERE client_id = $1`, [
    THIRD_PARTY,
  ]);
  const blockedRefresh = await post('/token', {
    grant_type: 'refresh_token',
    refresh_token: t3,
    client_id: THIRD_PARTY,
  });
  const familyOfT3 = async () =>
    (
      await admin.query<{ status: string; revoke_reason: string | null; feed: number }>(
        `SELECT family.status, family.revoke_reason,
                (SELECT count(*)::int FROM uts.revocations AS entry
                 WHERE entry.kind = 'third_party_family' AND entry.subject_id = family.id::text) AS feed
         FROM uts.authorization_codes AS code
         JOIN uts.third_party_grant_families AS family ON family.id = code.grant_id
         WHERE code.code_hash = $1`,
        [sha256(againCode)]
      )
    ).rows[0];
  log('refresh after the client is blocked', {
    status: blockedRefresh.status,
    body: blockedRefresh.body,
    family: await familyOfT3(),
  });
  log(
    'introspect after the block',
    (await post('/introspect', { token: t3, client_id: THIRD_PARTY })).body
  );
  // The row-maintenance cron ends the blocked client's families in batches.
  const maintained = await admin.query<{ kind: string; deleted: number }>(
    'SELECT kind, deleted FROM uts.maintain_oauth_rows()'
  );
  log('maintenance after the block', {
    blockedClientFamilies: maintained.rows.find(row => row.kind === 'blocked_client_families')
      ?.deleted,
    family: await familyOfT3(),
  });

  // Timing of the first-party mint path, before the grant is revoked.
  const http: number[] = [];
  for (let run = 0; run < timingRuns; run += 1) {
    const proof = await device.proof('/token');
    const started = performance.now();
    const response = await post(
      '/token',
      {
        grant_type: 'refresh_token',
        refresh_token: grant,
        client_id: 'kilo-cli',
        scope: 'gateway:models.read',
      },
      proof
    );
    http.push(performance.now() - started);
    if (response.status !== 200) throw new Error(`timed refresh answered ${response.status}`);
  }
  const app = new pg.Client({ connectionString: appUrl });
  await app.connect();
  const statement: number[] = [];
  const grantId = (
    await admin.query<{ id: string }>('SELECT id FROM uts.refresh_grants WHERE token_hash = $1', [
      sha256(grant),
    ])
  ).rows[0].id;
  for (let run = 0; run < timingRuns; run += 1) {
    const started = performance.now();
    await app.query('SELECT * FROM uts.refresh_first_party($1, $2, $3, $4, $5, $6, $7, $8)', [
      'development',
      sha256(grant),
      grantId,
      'kilo-cli',
      Buffer.from(device.jkt, 'base64url'),
      randomUUID(),
      ['gateway:models.read'],
      null,
    ]);
    statement.push(performance.now() - started);
  }
  await app.end();
  log('timing: POST /token refresh (ms)', {
    runs: timingRuns,
    p50: percentile(http, 0.5),
    p95: percentile(http, 0.95),
  });
  log('timing: mint statement (ms)', {
    runs: timingRuns,
    p50: percentile(statement, 0.5),
    p95: percentile(statement, 0.95),
  });

  log(
    'introspect first-party grant',
    (
      await post(
        '/introspect',
        { token: grant, client_id: 'kilo-cli' },
        await device.proof('/introspect')
      )
    ).body
  );
  const revoked = await post('/revoke', { token: grant, client_id: 'kilo-cli' });
  log('revoke (RFC 7009)', { status: revoked.status });
  const afterRevoke = await post(
    '/token',
    { grant_type: 'refresh_token', refresh_token: grant, client_id: 'kilo-cli' },
    await device.proof('/token')
  );
  log('refresh after revoke', { status: afterRevoke.status, body: afterRevoke.body });
  log(
    'introspect after revoke',
    (
      await post(
        '/introspect',
        { token: grant, client_id: 'kilo-cli' },
        await device.proof('/introspect')
      )
    ).body
  );

  // A body without a Content-Length that grows past 16 KiB is cut off, not buffered. It runs
  // last, on its own connection, because the Worker answers before the client finishes sending.
  const streamed = await postChunked(
    '/token',
    `grant_type=refresh_token&pad=${'x'.repeat(4096)}`,
    64
  );
  log('streamed 256 KiB body, no Content-Length', streamed);

  const rows = await admin.query<{
    id: string;
    shard: number;
    event_type: string;
    outcome: string;
    attributes: Record<string, unknown>;
  }>(
    `SELECT id, shard, event_type, event #>> '{data,outcome}' AS outcome, event #> '{data,attributes}' AS attributes
     FROM uts.audit_events WHERE id > $1 AND event_type <> 'ai.kilo.uts.token.issued' OR (id > $1 AND id <= $1 + 12)
     ORDER BY id`,
    [startId]
  );
  console.log('\naudit rows (the timed refreshes are left out after the first few):');
  for (const row of rows.rows) {
    const { tokenRefs, grantId: grant, scopes, rotation } = row.attributes;
    console.log(
      `  #${row.id} stream uts:development:${row.shard} ${row.event_type} ${row.outcome} ${JSON.stringify({ grantId: grant, tokenRefs, scopes, rotation })}`
    );
  }
  const text = (
    await admin.query<{ text: string }>(
      "SELECT string_agg(event::text, ' ') AS text FROM uts.audit_events WHERE id > $1",
      [startId]
    )
  ).rows[0].text;
  const leaked = secrets.filter(secret => text.includes(secret)).length;
  log('token values found in audit rows', { checked: secrets.length, found: leaked });
  await admin.end();
  if (leaked > 0) process.exitCode = 1;
}

await main();
