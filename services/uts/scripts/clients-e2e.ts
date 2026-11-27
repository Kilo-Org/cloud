/**
 * Local end-to-end run of third-party clients and the broker exchange (design 5.9) against
 * `wrangler dev -c wrangler.dev.jsonc` and the local identity store. The run serves its own Client
 * ID Metadata Document and plays the STS signer, so the mint Worker must run with
 * `--var DEV_CLIENT_METADATA_ORIGIN:http://127.0.0.1:<UTS_E2E_CIMD_PORT>` and
 * `--var DEV_STS_JWKS_URL:http://127.0.0.1:<UTS_E2E_STS_PORT>/jwks.json` (src/dev-clients.ts).
 *
 * Steps: a third-party sign-in on a seeded browser session with the consent screen, the code
 * exchange, the broker exchange to `kilo-api:mcp.read` (300 s, `act` kilo-mcp), refusals for an
 * undelegated scope and a subject token with 20 s left, the withdrawal on the apps page (its
 * `third_party_family` entry reaches a vouching feed object), the refusal after it, then both 429
 * limits. For each case it counts the exchange statements (`pg_stat_user_functions`, which needs
 * `track_functions = 'all'` on the local server) and the audit rows the case wrote. Synthetic data
 * only; it prints token ids, never a token.
 *
 *   UTS_E2E_BASE_URL   the mint Worker, such as http://127.0.0.1:9120/
 *   UTS_E2E_ADMIN_URL  admin login to the local identity-store database
 *   UTS_E2E_CIMD_PORT  the port of the run's metadata host (default 9132)
 *   UTS_E2E_STS_PORT   the port of the run's fake STS key set (default 9131)
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import {
  KILO_API_MCP_READ_SCOPE,
  KILO_MCP_CATALOG_CONSENT_TEXT,
  KILO_MCP_CATALOG_READ_SCOPE,
  UTS_ACCESS_TOKEN_TYPE_URN,
  UTS_ENDPOINTS,
  UTS_GRANT_TYPES,
} from '@kilocode/uts-contracts';
import { SignJWT, decodeJwt, exportJWK, generateKeyPair } from 'jose';
import pg from 'pg';
import { z } from 'zod';
import { localDatabaseUrl } from './e2e-store';

const base = z.url().parse(process.env.UTS_E2E_BASE_URL);
const adminUrl = localDatabaseUrl('UTS_E2E_ADMIN_URL').toString();
const cimdPort = z.coerce
  .number()
  .int()
  .parse(process.env.UTS_E2E_CIMD_PORT ?? '9132');
const stsPort = z.coerce
  .number()
  .int()
  .parse(process.env.UTS_E2E_STS_PORT ?? '9131');

const issuer = UTS_ENDPOINTS.development.issuer;
const origin = new URL(base).origin;
const ACCOUNT = `e2e/clients-${randomUUID()}`;
const CLIENT_ID = `https://mcp-client.example.com/${randomUUID()}/client.json`;
const REDIRECT = 'http://127.0.0.1:9133/callback';
const MCP_RESOURCE = 'http://localhost:8815/mcp';
const API_RESOURCE = 'http://localhost:3000';
const sha256 = (value: string) => createHash('sha256').update(value).digest();
const token = () => randomBytes(32).toString('base64url');

function log(step: string, detail: unknown) {
  console.log(`${step.padEnd(40)} ${JSON.stringify(detail)}`);
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`check failed: ${message}`);
}

/** The run's metadata host: one Client ID Metadata Document at the client id's path. */
function metadataHost(): Server {
  const path = new URL(CLIENT_ID).pathname;
  return createServer((request, response) => {
    if (request.url !== path) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=600' })
      .end(
        JSON.stringify({
          client_id: CLIENT_ID,
          client_name: 'E2E MCP client',
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        })
      );
  }).listen(cimdPort, '127.0.0.1');
}

/** The run's fake STS signer: its public key set over HTTP, its tokens signed in this process. */
async function fakeSts() {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const kid = `sts-e2e-${randomUUID()}`;
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid, alg: 'EdDSA', use: 'sig' }] };
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(jwks));
  }).listen(stsPort, '127.0.0.1');
  const sign = async (workload: string, scope: string) => {
    const now = Math.floor(Date.now() / 1000);
    return await new SignJWT({
      aud: 'uts',
      sub: `service:${workload}`,
      client_id: workload,
      req: workload,
      scope,
      jti: randomUUID(),
      env: 'development',
    })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid })
      .setIssuer('http://localhost:8825')
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);
  };
  return { server, sign };
}

const admin = new pg.Client({ connectionString: adminUrl });

async function exchangeCalls(): Promise<number> {
  await admin.query('SELECT pg_stat_clear_snapshot()');
  const result = await admin.query<{ calls: string | null }>(
    `SELECT sum(calls)::text AS calls FROM pg_stat_user_functions
     WHERE schemaname = 'uts' AND funcname = 'exchange_delegated_token'`
  );
  return Number(result.rows[0].calls ?? '0');
}

async function auditCounts(): Promise<Record<string, number>> {
  const result = await admin.query<{ event_type: string; count: number }>(
    `SELECT event_type, count(*)::int AS count FROM uts.audit_events WHERE account_id = $1
     GROUP BY event_type`,
    [ACCOUNT]
  );
  return Object.fromEntries(result.rows.map(row => [row.event_type, row.count]));
}

/**
 * Runs one case and logs what it cost: exchange statements and audit rows by type. A closed
 * connection flushes its statistics, so the count waits a moment after the case.
 */
async function measured<Result>(name: string, work: () => Promise<Result>): Promise<Result> {
  const callsBefore = await exchangeCalls();
  const auditBefore = await auditCounts();
  const result = await work();
  await new Promise(resolve => setTimeout(resolve, 1_500));
  const auditAfter = await auditCounts();
  const audit: Record<string, number> = {};
  for (const [type, count] of Object.entries(auditAfter)) {
    const delta = count - (auditBefore[type] ?? 0);
    if (delta !== 0) audit[type.replace('ai.kilo.uts.', '')] = delta;
  }
  log(`cost: ${name}`, { exchangeStatements: (await exchangeCalls()) - callsBefore, audit });
  return result;
}

const ExchangedSchema = z.object({
  access_token: z.string(),
  issued_token_type: z.literal(UTS_ACCESS_TOKEN_TYPE_URN),
  token_type: z.literal('Bearer'),
  expires_in: z.number(),
  scope: z.string(),
});

async function exchange(stsToken: string, subject: string, fields: Record<string, string> = {}) {
  const response = await fetch(new URL('token', base), {
    method: 'POST',
    headers: { Authorization: `Bearer ${stsToken}` },
    body: new URLSearchParams({
      grant_type: UTS_GRANT_TYPES.tokenExchange,
      subject_token: subject,
      subject_token_type: UTS_ACCESS_TOKEN_TYPE_URN,
      requested_token_type: UTS_ACCESS_TOKEN_TYPE_URN,
      resource: API_RESOURCE,
      scope: KILO_API_MCP_READ_SCOPE,
      ...fields,
    }),
  });
  const body: unknown = await response.json();
  return { status: response.status, retryAfter: response.headers.get('Retry-After'), body };
}

/** A subject token for `grantId` signed by the development signing route. */
async function devSubject(grantId: string, secondsLeft: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const response = await fetch(new URL('__dev/sign', base), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grantId,
      claims: {
        iss: issuer,
        exp: now + secondsLeft,
        aud: 'kilo-mcp',
        sub: ACCOUNT,
        client_id: CLIENT_ID,
        iat: now,
        jti: randomUUID(),
        scope: KILO_MCP_CATALOG_READ_SCOPE,
        sid: grantId,
        auth_time: now - 60,
        amr: ['passkey'],
        env: 'development',
      },
    }),
  });
  return z.object({ token: z.string() }).parse(await response.json()).token;
}

async function main() {
  const host = metadataHost();
  const sts = await fakeSts();
  await admin.connect();
  // The admin login owns no table; the schema owner reads and seeds them.
  await admin.query('SET ROLE uts_owner');
  // Wake both feed objects (a one-second stop loads each and starts its backfill alarm), so one
  // of them vouches for its list by the time the withdrawal publishes.
  for (const feed of [0, 1]) {
    await fetch(new URL('__dev/feed/stop', base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feed, seconds: 1 }),
    });
  }
  await new Promise(resolve => setTimeout(resolve, 12_000));
  try {
    // Seed: an account and a browser session signed in a minute ago, as the sign-in slice writes.
    const cookie = token();
    await admin.query(`INSERT INTO uts.accounts (id, primary_email) VALUES ($1, $2)`, [
      ACCOUNT,
      `${randomBytes(4).toString('hex')}@example.com`,
    ]);
    await admin.query(
      `INSERT INTO uts.browser_sessions (account_id, token_hash, auth_time, amr, idle_expires_at, expires_at)
       VALUES ($1, $2, now() - interval '1 minute', '{passkey}', now() + interval '14 days',
               now() + interval '29 days')`,
      [ACCOUNT, sha256(cookie)]
    );
    const session = { Cookie: `__Host-uts_session=${cookie}` };

    // 1. Third-party sign-in: the metadata fetch, the consent screen, the consent.
    const verifier = token();
    const authorizeUrl = new URL('authorize', base);
    for (const [name, value] of Object.entries({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: sha256(verifier).toString('base64url'),
      code_challenge_method: 'S256',
      scope: KILO_MCP_CATALOG_READ_SCOPE,
      resource: MCP_RESOURCE,
      state: 'e2e-state',
      dev_handoff: 'signin',
    })) {
      authorizeUrl.searchParams.set(name, value);
    }
    const screen = await fetch(authorizeUrl, { headers: session, redirect: 'manual' });
    const html = await screen.text();
    check(screen.status === 200, `consent screen answered ${screen.status}`);
    check(html.includes(KILO_MCP_CATALOG_CONSENT_TEXT.replace("'", '&#39;')), 'the consent line');
    check(html.includes(CLIENT_ID), 'the metadata URL');
    log('1 consent screen', {
      status: screen.status,
      shows: ['E2E MCP client', 'metadata URL', 'consent line'],
      formAction: screen.headers.get('Content-Security-Policy')?.match(/form-action [^;]+/)?.[0],
    });
    const allowed = await fetch(authorizeUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        ...session,
        Origin: origin,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ decision: 'allow', consent: KILO_MCP_CATALOG_READ_SCOPE }),
    });
    const location = new URL(allowed.headers.get('Location') ?? 'about:blank');
    const code = location.searchParams.get('code');
    check(allowed.status === 302 && code !== null, `consent answered ${allowed.status}`);
    log('1 consent allowed', {
      status: allowed.status,
      redirect: `${location.origin}${location.pathname}`,
      state: location.searchParams.get('state'),
      iss: location.searchParams.get('iss'),
    });
    const consent = await admin.query<{ id: string }>(
      `SELECT id FROM uts.third_party_consents WHERE account_id = $1 AND status = 'active'`,
      [ACCOUNT]
    );
    check(consent.rows.length === 1, 'one consent row');

    // 2. The code exchange: the MCP access token.
    const tokenResponse = await fetch(new URL('token', base), {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }),
    });
    const issued = z
      .looseObject({ access_token: z.string(), expires_in: z.number(), scope: z.string() })
      .parse(await tokenResponse.json());
    const subjectClaims = decodeJwt(issued.access_token);
    const familyId = z.uuid().parse(subjectClaims.sid);
    log('2 MCP access token', {
      status: tokenResponse.status,
      aud: subjectClaims.aud,
      scope: issued.scope,
      expires_in: issued.expires_in,
      client_id: subjectClaims.client_id,
      sid: familyId,
    });

    // 3. The broker exchange.
    const callerToken = await sts.sign('kilo-mcp', 'uts:token-exchange');
    const success = await measured('success, third-party subject', () =>
      exchange(callerToken, issued.access_token)
    );
    check(success.status === 200, `exchange answered ${success.status}`);
    const exchanged = ExchangedSchema.parse(success.body);
    const delegated = decodeJwt(exchanged.access_token);
    check(exchanged.expires_in === 300, 'a 300-second token');
    check(
      JSON.stringify(delegated.act) === JSON.stringify({ sub: 'kilo-mcp' }),
      'act names kilo-mcp'
    );
    log('3 exchange', {
      status: success.status,
      expires_in: exchanged.expires_in,
      scope: exchanged.scope,
      aud: delegated.aud,
      act: delegated.act,
      req: delegated.req,
      sub: delegated.sub === ACCOUNT ? 'the subject' : 'another subject',
      sid: delegated.sid === familyId ? 'the consent family' : 'another sid',
      client_id: delegated.client_id === CLIENT_ID ? 'the metadata URL' : delegated.client_id,
      org: delegated.org ?? null,
      lifetime: Number(delegated.exp) - Number(delegated.iat),
      jti: delegated.jti,
    });

    // 4. Refusals before the store.
    const otherWorkload = await measured('bad caller (another workload)', async () =>
      exchange(await sts.sign('web', 'uts:token-exchange'), issued.access_token)
    );
    log('4 another workload', { status: otherWorkload.status, body: otherWorkload.body });
    const undelegated = await measured('undelegated scope', () =>
      exchange(callerToken, issued.access_token, { scope: 'kilo-api:profile.read' })
    );
    log('4 undelegated scope', { status: undelegated.status, body: undelegated.body });
    check(undelegated.status === 400, 'undelegated scope refused');
    const nearlyOver = await devSubject(familyId, 20);
    const expiring = await measured('subject with 20 s left', () =>
      exchange(callerToken, nearlyOver)
    );
    log('4 subject with 20 s left', { status: expiring.status, body: expiring.body });
    check(expiring.status === 400, 'near-expired subject refused');

    // 5. Withdrawal on the apps page reaches the feed, and the exchange stops.
    const appsUrl = new URL('signin/apps', base);
    const listed = await (await fetch(appsUrl, { headers: session })).text();
    check(listed.includes('E2E MCP client'), 'the apps page lists the client');
    const withdrawn = await fetch(appsUrl, {
      method: 'POST',
      headers: {
        ...session,
        Origin: origin,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ consent_id: consent.rows[0].id }),
    });
    const withdrawnPage = await withdrawn.text();
    const entry = await admin.query<{ kind: string; feed_expires_at: Date; revoked_at: Date }>(
      `SELECT kind, revoked_at, feed_expires_at FROM uts.revocations
       WHERE kind = 'third_party_family' AND subject_id = $1`,
      [familyId]
    );
    const subjectEntries = await admin.query(
      `SELECT 1 FROM uts.revocations WHERE kind = 'subject' AND subject_id = $1`,
      [ACCOUNT]
    );
    log('5 withdrawal', {
      status: withdrawn.status,
      vouchedPublish: withdrawnPage.includes('can no longer act'),
      feedEntry: entry.rows.map(row => ({
        kind: row.kind,
        keptSeconds: (row.feed_expires_at.getTime() - row.revoked_at.getTime()) / 1000,
      })),
      subjectWideEntries: subjectEntries.rowCount,
    });
    check(withdrawn.status === 200 && withdrawnPage.includes('can no longer act'), 'published');
    const afterWithdrawal = await measured('withdrawn consent (store refusal)', () =>
      exchange(callerToken, issued.access_token)
    );
    log('5 exchange after withdrawal', {
      status: afterWithdrawal.status,
      body: afterWithdrawal.body,
    });
    check(afterWithdrawal.status === 400, 'withdrawn consent refused');
    const again = await measured('withdrawn consent again, same minute', () =>
      exchange(callerToken, issued.access_token)
    );
    log('5 refused again', { status: again.status });

    // 6. The subject limit. The sid counted 4 verified exchanges this minute (the success, the
    // 20-second subject and the two refusals after the withdrawal); the 61st answers 429.
    const subjectLimit = await measured('subject limit (store refusals, then 429)', async () => {
      for (let index = 5; index <= 70; index += 1) {
        const result = await exchange(callerToken, issued.access_token);
        if (result.status === 429) return { ...result, refusedAt: index };
        check(result.status === 400, 'a store refusal before the limit');
      }
      throw new Error('no subject limit within 70 exchanges');
    });
    log('6 subject limit', {
      status: subjectLimit.status,
      retryAfter: subjectLimit.retryAfter,
      body: subjectLimit.body,
      exchangeNumber: subjectLimit.refusedAt,
    });
    check(subjectLimit.status === 429 && subjectLimit.refusedAt === 61, 'the 61st is limited');

    // 7. The caller limit: distinct unknown sids until the workload's 600 a minute run out.
    const callerLimit = await measured('caller limit', async () => {
      for (let index = 0; index < 700; index += 1) {
        const result = await exchange(callerToken, await devSubject(randomUUID(), 600));
        if (result.status === 429) return { ...result, after: index };
      }
      throw new Error('no caller limit within 700 exchanges');
    });
    log('7 caller limit', {
      status: callerLimit.status,
      retryAfter: callerLimit.retryAfter,
      body: callerLimit.body,
      refusedAfter: callerLimit.after,
    });
    const limited = await measured('one more 429 (caller)', () =>
      exchange(callerToken, issued.access_token)
    );
    log('7 a 429 costs', { status: limited.status });
    console.log('clients-e2e: every check passed');
  } finally {
    host.close();
    sts.server.close();
    await admin.end();
  }
}

await main();
