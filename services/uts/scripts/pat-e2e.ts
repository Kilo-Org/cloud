/**
 * Local end-to-end run of PATs and org bot keys against `wrangler dev --env local` and the local
 * identity store (README, "Local development"): sign in the CLI, create a PAT, use it on the probe
 * route, list it, revoke it and time how long until the probe refuses it; a create refused by the
 * tier B gate once the sign-in is 11 minutes old; an org bot key created, listed and revoked; then
 * the audit rows from the database, checked for credential values and hashes. Synthetic data only;
 * it prints ids and audit references, never a token, a PAT or a key.
 *
 *   UTS_E2E_BASE_URL   the mint Worker, such as http://127.0.0.1:8800
 *   UTS_E2E_ADMIN_URL  admin login to the identity-store database (loopback only), for the seed,
 *                      the stale-session step and the audit read
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  BotKeyListSchema,
  CreatedBotKeySchema,
  CreatedPatSchema,
  PatListSchema,
  PatProbeResponseSchema,
  UTS_ENDPOINTS,
} from '@kilocode/uts-contracts';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import pg from 'pg';
import { z } from 'zod';
import { isLoopbackHost } from './connection';

const base = z.url().parse(process.env.UTS_E2E_BASE_URL);
const adminUrl = z.url().parse(process.env.UTS_E2E_ADMIN_URL);
if (!isLoopbackHost(new URL(adminUrl))) {
  throw new Error('the end-to-end run uses a local database only');
}

const issuer = UTS_ENDPOINTS.development.issuer;
const ACCOUNT = 'dev:uts-local';
const ORG = randomUUID();
const CALLBACK = 'http://127.0.0.1:4100/callback';
/** The address the probe route counts lookups by; wrangler dev passes the header through. */
const CLIENT_ADDRESS = '192.0.2.44';
const secrets: string[] = [];
const failures: string[] = [];

function log(step: string, detail: unknown) {
  console.log(`${step.padEnd(40)} ${JSON.stringify(detail)}`);
}

function expectThat(condition: boolean, step: string) {
  if (!condition) failures.push(step);
}

const TokenSchema = z.looseObject({
  issued_tokens: z.array(z.object({ access_token: z.string(), scope: z.string() })),
  refresh_token: z.string(),
});

async function signIn(): Promise<{ pats: string; botKeys: string; grantId: string }> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const jwk = await exportJWK(publicKey);
  const verifier = randomBytes(32).toString('base64url');
  const url = new URL('authorize', base);
  for (const [name, value] of Object.entries({
    response_type: 'code',
    client_id: 'kilo-cli',
    redirect_uri: CALLBACK,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    scope: 'uts:bot-keys.manage uts:pats.manage',
    dpop_jkt: await calculateJwkThumbprint(jwk, 'sha256'),
  })) {
    url.searchParams.set(name, value);
  }
  const authorized = await fetch(url, { redirect: 'manual' });
  const code = new URL(authorized.headers.get('Location') ?? 'about:blank').searchParams.get(
    'code'
  );
  if (code === null) throw new Error(`authorize answered ${authorized.status}`);
  secrets.push(code);
  const proof = await new SignJWT({
    jti: randomUUID(),
    htm: 'POST',
    htu: `${issuer}/token`,
    iat: Math.floor(Date.now() / 1000),
  })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'dpop+jwt', jwk })
    .sign(privateKey);
  const response = await fetch(new URL('token', base), {
    method: 'POST',
    headers: { DPoP: proof },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK,
      client_id: 'kilo-cli',
      code_verifier: verifier,
    }),
  });
  const body = TokenSchema.parse(await response.json());
  secrets.push(body.refresh_token, ...body.issued_tokens.map(token => token.access_token));
  const byScope = new Map(body.issued_tokens.map(token => [token.scope, token.access_token]));
  const pats = byScope.get('uts:pats.manage');
  const botKeys = byScope.get('uts:bot-keys.manage');
  if (pats === undefined || botKeys === undefined) throw new Error('missing account tokens');
  const payload: unknown = JSON.parse(Buffer.from(pats.split('.')[1], 'base64url').toString());
  const grantId = z.object({ sid: z.uuid() }).parse(payload).sid;
  log('sign-in (code + PKCE + DPoP)', { status: response.status, grantId });
  return { pats, botKeys, grantId };
}

async function api(path: string, token: string, init: { method?: string; json?: unknown } = {}) {
  const response = await fetch(new URL(path.slice(1), base), {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.json === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const text = await response.text();
  return {
    status: response.status,
    challenge: response.headers.get('WWW-Authenticate'),
    body: text === '' ? null : (JSON.parse(text) as unknown),
  };
}

async function probe(pat: string) {
  const response = await fetch(new URL('probe/pat', base), {
    headers: { Authorization: `Bearer ${pat}`, 'CF-Connecting-IP': CLIENT_ADDRESS },
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

async function main() {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query('SET ROLE uts_owner');
  await admin.query(
    `INSERT INTO uts.accounts (id, primary_email) VALUES ($1, 'e2e@example.com') ON CONFLICT DO NOTHING`,
    [ACCOUNT]
  );
  await admin.query(
    `INSERT INTO uts.org_memberships (org_id, account_id, role, event_version) VALUES ($1, $2, 'admin', 1)`,
    [ORG, ACCOUNT]
  );
  const startId = (
    await admin.query<{ id: string }>('SELECT coalesce(max(id), 0) AS id FROM uts.audit_events')
  ).rows[0].id;

  const metadata = await fetch(new URL('.well-known/oauth-protected-resource', base));
  log('protected-resource metadata', { status: metadata.status, body: await metadata.json() });

  const tokens = await signIn();

  // PAT: create, use, list, revoke, use again.
  const createdResponse = await api('/account/pats', tokens.pats, {
    method: 'POST',
    json: { name: 'e2e probe', scope: 'uts:probe.read', expires_in_days: 30 },
  });
  const created = CreatedPatSchema.parse(createdResponse.body);
  secrets.push(created.token, createHash('sha256').update(created.token).digest('hex'));
  log('POST /account/pats', {
    status: createdResponse.status,
    id: created.id,
    scope: created.scope,
    expires_at: created.expires_at,
    last_four: created.last_four,
  });
  expectThat(createdResponse.status === 201, 'PAT created');

  const used = await probe(created.token);
  log('GET /probe/pat with the PAT', {
    status: used.status,
    body: PatProbeResponseSchema.safeParse(used.body).data ?? used.body,
  });
  expectThat(used.status === 200, 'PAT accepted');

  const listed = await api('/account/pats', tokens.pats);
  const pats = PatListSchema.parse(listed.body).pats;
  log('GET /account/pats', { status: listed.status, ids: pats.map(pat => pat.id) });
  expectThat(
    pats.some(pat => pat.id === created.id) && !JSON.stringify(listed.body).includes(created.token),
    'PAT listed without its value'
  );

  const revoked = await api(`/account/pats/${created.id}`, tokens.pats, { method: 'DELETE' });
  const revokedAt = performance.now();
  log('DELETE /account/pats/<id>', { status: revoked.status });
  let refusedAfterMs: number | null = null;
  let afterRevoke = await probe(created.token);
  while (afterRevoke.status === 200 && performance.now() - revokedAt < 60_000) {
    await sleep(250);
    afterRevoke = await probe(created.token);
  }
  if (afterRevoke.status === 401) refusedAfterMs = Math.round(performance.now() - revokedAt);
  log('GET /probe/pat after revoke', {
    status: afterRevoke.status,
    refusedAfterMs,
    challenge: afterRevoke.body,
  });
  expectThat(refusedAfterMs !== null && refusedAfterMs < 60_000, 'revoked PAT refused within 60 s');
  const listedAfter = PatListSchema.parse((await api('/account/pats', tokens.pats)).body).pats;
  expectThat(!listedAfter.some(pat => pat.id === created.id), 'revoked PAT not listed');

  // Org bot key while the sign-in is fresh.
  const keyResponse = await api(`/account/orgs/${ORG}/bot-keys`, tokens.botKeys, {
    method: 'POST',
    json: { name: 'e2e bot', scope: 'uts:probe.read' },
  });
  const key = CreatedBotKeySchema.parse(keyResponse.body);
  secrets.push(key.token, createHash('sha256').update(key.token).digest('hex'));
  log('POST /account/orgs/<org>/bot-keys', {
    status: keyResponse.status,
    id: key.id,
    org: key.org,
  });
  const keys = BotKeyListSchema.parse(
    (await api(`/account/orgs/${ORG}/bot-keys`, tokens.botKeys)).body
  );
  log('GET /account/orgs/<org>/bot-keys', {
    keys: keys.bot_keys.map(item => ({ id: item.id, status: item.status })),
  });
  const keyRevoked = await api(`/account/orgs/${ORG}/bot-keys/${key.id}`, tokens.botKeys, {
    method: 'DELETE',
  });
  log('DELETE /account/orgs/<org>/bot-keys/<id>', { status: keyRevoked.status });
  expectThat(
    keyResponse.status === 201 && keyRevoked.status === 204,
    'bot key created and revoked'
  );

  // The tier B gate: the same session 11 minutes after its sign-in.
  await admin.query(
    `UPDATE uts.device_sessions SET auth_time = now() - interval '11 minutes'
     WHERE id = (SELECT device_session_id FROM uts.refresh_grants WHERE id = $1)`,
    [tokens.grantId]
  );
  const gated = await api('/account/pats', tokens.pats, {
    method: 'POST',
    json: { name: 'e2e late', scope: 'uts:probe.read' },
  });
  log('POST /account/pats, sign-in 11 min old', {
    status: gated.status,
    challenge: gated.challenge,
    body: gated.body,
  });
  expectThat(
    gated.status === 401 && (gated.challenge ?? '').includes('max_age="600"'),
    'gate refused'
  );

  const rows = await admin.query<{
    id: string;
    event_type: string;
    outcome: string;
    actor: unknown;
    attributes: Record<string, unknown>;
  }>(
    `SELECT id, event_type, event #>> '{data,outcome}' AS outcome, event #> '{data,actor}' AS actor,
            event #> '{data,attributes}' AS attributes
     FROM uts.audit_events WHERE id > $1 ORDER BY id`,
    [startId]
  );
  console.log('\naudit rows:');
  for (const row of rows.rows) {
    const { patId, patRef, botKeyId, botKeyRef, gateChecks, action, reason } = row.attributes;
    console.log(
      `  #${row.id} ${row.event_type} ${row.outcome} ${JSON.stringify({ patId, patRef, botKeyId, botKeyRef, gateChecks, action, reason })}`
    );
  }
  const types = rows.rows.map(row => row.event_type);
  for (const type of [
    'ai.kilo.uts.pat.created',
    'ai.kilo.uts.pat.revoked',
    'ai.kilo.uts.bot_key.created',
    'ai.kilo.uts.bot_key.revoked',
    'ai.kilo.uts.gate.refused',
  ]) {
    expectThat(types.includes(type), `audit row ${type}`);
  }
  const text = (
    await admin.query<{ text: string }>(
      "SELECT string_agg(event::text, ' ') AS text FROM uts.audit_events WHERE id > $1",
      [startId]
    )
  ).rows[0].text;
  const leaked = secrets.filter(secret => text.includes(secret)).length;
  log('credential values or hashes in audit rows', { checked: secrets.length, found: leaked });
  expectThat(leaked === 0, 'no credential value in audit rows');
  await admin.end();
  log('result', { failed: failures });
  if (failures.length > 0) process.exitCode = 1;
}

await main();
