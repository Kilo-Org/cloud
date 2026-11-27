/**
 * Local end-to-end run of mobile attestation (design 5.5, decision Q67): the `kilo-mobile` code
 * exchange through the mint Worker under `wrangler dev`, over a fresh identity-store database,
 * with stand-ins for Apple and Google in their real formats (`scripts/attest-standins.ts`):
 *
 * * Apple: a stand-in App Attest root (the development-only `ATTEST_DEV_ENDPOINTS`) and devices
 *   whose attestation objects and assertions have Apple's exact structure.
 * * Google: a local server for the service account's token exchange (it checks the RS256
 *   assertion against the run's service-account key) and for `decodeIntegrityToken` (it answers
 *   only the integrity tokens the run registered, and counts every decode).
 *
 * Checks:
 * 1. A complete config serves `kilo-mobile`; a new App Attest key is attested and stored, and an
 *    assertion of it is admitted with counter 1.
 * 2. A replayed assertion (another code) and a repeated counter are refused, and those codes never
 *    exchange.
 * 3. An exchange without an attestation answers `attestation_required` with no decode; the same
 *    code then exchanges with a valid Play Integrity token.
 * 4. A Play Integrity token is decoded once: a retry of the same exchange gets the same grant with
 *    no second decode. The same token for another code, a wrong package, an unrecognized app and
 *    another signing certificate are refused.
 * 5. Refuse by default: a second mint Worker with one attestation value missing refuses
 *    `kilo-mobile` at the authorization endpoint and logs only the missing name.
 * 6. The audit rows name each refusal's reason and hold no credential value.
 *
 * Synthetic data only: every key is generated for the run; the database passwords are random.
 *
 *   UTS_E2E_ADMIN_URL  admin login to the identity-store database (loopback only)
 *   UTS_E2E_PORT       first of the run's ports (default 9490): the mint Worker and its inspector,
 *                      the refusing mint Worker and its inspector at +2 and +3, the Google
 *                      stand-in at +4
 *
 * The run drops and recreates the database `uts_attest_e2e`, applies the migrations, writes its
 * logs under a new temporary directory, prints a PASS or FAIL line per check, and stops its Workers
 * when it ends, also on SIGINT (exit 130) or SIGTERM (exit 143).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, mkdtempSync } from 'node:fs';
import { type IncomingMessage, type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { UTS_ENDPOINTS } from '@kilocode/uts-contracts';
import {
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  jwtVerify,
} from 'jose';
import type pg from 'pg';
import { z } from 'zod';
import {
  type PlayVerdictInput,
  type StandInAppAttestDevice,
  clientDataHashOf,
  playIntegrityToken,
  playRequestHashOf,
  playVerdict,
  standInAppAttestCa,
  standInAppAttestDevice,
} from './attest-standins';
import { openE2eStore } from './e2e-store';

const PORT = z.coerce
  .number()
  .int()
  .positive()
  .parse(process.env.UTS_E2E_PORT ?? '9490');
const MINT = `http://127.0.0.1:${PORT}`;
const REFUSING = `http://127.0.0.1:${PORT + 2}`;
const GOOGLE = `http://127.0.0.1:${PORT + 4}`;
const { issuer } = UTS_ENDPOINTS.development;
const ACCOUNT = 'dev:uts-local';
const REDIRECT = 'com.kilocode.kiloapp:/oauth/callback';
const SCOPE = 'notifications:badges.read';
const TEAM_ID = 'ABCDE12345';
const BUNDLE_ID = 'com.example.kilo';
const APP_ID = `${TEAM_ID}.${BUNDLE_ID}`;
const PACKAGE = 'com.example.kilo';
const DIGEST = randomBytes(32);

const UTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = mkdtempSync(join(tmpdir(), 'uts-attest-e2e-'));
const LOGS = join(WORK, 'logs');
mkdirSync(LOGS, { recursive: true });

let failures = 0;
/** Every credential value the run handles: none may appear in an audit row. */
const secrets: string[] = [];

function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`PASS ${message}`);
    return;
  }
  failures += 1;
  console.log(`FAIL ${message}`);
}

function log(step: string, detail: unknown): void {
  console.log(`${step.padEnd(52)} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}

type Worker = { label: string; child: ChildProcess; lines: string[] };
const workers: Worker[] = [];
let google: Server | undefined;
let admin: pg.Client | undefined;
let cleaning: Promise<void> | undefined;

function startMint(
  label: string,
  port: number,
  vars: Record<string, string>,
  urls: { app: string; pat: string; reader: string }
): Worker {
  if (cleaning !== undefined) throw new Error('the run is stopping');
  const lines: string[] = [];
  const file = createWriteStream(join(LOGS, `${label}.log`), { flags: 'a' });
  const varArgs = Object.entries(vars).flatMap(([name, value]) => ['--var', `${name}:${value}`]);
  const child = spawn(
    './node_modules/.bin/wrangler',
    [
      'dev',
      '-c',
      'wrangler.dev.jsonc',
      '--port',
      String(port),
      '--inspector-port',
      String(port + 1),
      '--persist-to',
      join(WORK, `${label}-state`),
      ...varArgs,
    ],
    {
      cwd: UTS_DIR,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        WRANGLER_REGISTRY_PATH: join(WORK, 'registry'),
        XDG_CONFIG_HOME: join(WORK, 'xdg'),
        WRANGLER_SEND_METRICS: 'false',
        CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_IDENTITY_STORE: urls.app,
        CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_IDENTITY_STORE_PAT: urls.pat,
        CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_IDENTITY_STORE_REPLICA: urls.reader,
      },
    }
  );
  const collect = (chunk: Buffer) => {
    lines.push(chunk.toString());
    file.write(chunk);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  child.once('exit', () => file.end());
  const worker = { label, child, lines };
  workers.push(worker);
  return worker;
}

async function waitForHttp(url: string, worker: Worker): Promise<void> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (worker.child.exitCode !== null) throw new Error(`${worker.label} exited`);
    const answered = await fetch(url).then(
      () => true,
      () => false
    );
    if (answered) return;
    await sleep(1000);
  }
  throw new Error(`${worker.label} did not answer at ${url}`);
}

async function stop(worker: Worker): Promise<void> {
  const { child } = worker;
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(done => child.once('exit', () => done()));
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // The Worker exited between the check and the signal.
  }
  await Promise.race([exited, sleep(5000)]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // The Worker exited between the check and the signal.
    }
  }
}

function cleanup(): Promise<void> {
  cleaning ??= (async () => {
    await Promise.all(workers.map(stop));
    await new Promise<void>(done => (google === undefined ? done() : google.close(() => done())));
    await admin?.end().catch(() => undefined);
    console.log(`run directory: ${WORK}`);
  })();
  return cleaning;
}

let signalled = false;
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const) {
  process.on(signal, () => {
    if (signalled) return;
    signalled = true;
    console.log(`attest e2e: ${signal}, stopping`);
    void cleanup().finally(() => process.exit(code));
  });
}

/** The Google stand-in: the token exchange and `decodeIntegrityToken`, counting decodes. */
function startGoogle(publicKey: CryptoKey, clientEmail: string) {
  const verdicts = new Map<string, unknown>();
  const decodes: string[] = [];
  const accessTokens = new Set<string>();
  const body = async (incoming: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks).toString('utf8');
  };
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const send = (status: number, value: unknown) => {
        outgoing.writeHead(status, { 'Content-Type': 'application/json' });
        outgoing.end(JSON.stringify(value));
      };
      const text = await body(incoming);
      if (incoming.method === 'POST' && incoming.url === '/token') {
        const form = new URLSearchParams(text);
        try {
          const { payload } = await jwtVerify(form.get('assertion') ?? '', publicKey, {
            issuer: clientEmail,
            audience: `${GOOGLE}/token`,
          });
          if (payload.scope !== 'https://www.googleapis.com/auth/playintegrity') {
            send(400, { error: 'invalid_scope' });
            return;
          }
        } catch {
          send(400, { error: 'invalid_grant' });
          return;
        }
        const token = randomBytes(24).toString('base64url');
        accessTokens.add(token);
        send(200, { access_token: token, expires_in: 3599, token_type: 'Bearer' });
        return;
      }
      if (incoming.method === 'POST' && incoming.url === `/v1/${PACKAGE}:decodeIntegrityToken`) {
        const bearer = /^Bearer (.+)$/.exec(incoming.headers.authorization ?? '')?.[1] ?? '';
        if (!accessTokens.has(bearer)) {
          send(401, { error: { status: 'UNAUTHENTICATED' } });
          return;
        }
        const integrityToken = z
          .object({ integrityToken: z.string() })
          .parse(JSON.parse(text)).integrityToken;
        decodes.push(integrityToken);
        const verdict = verdicts.get(integrityToken);
        if (verdict === undefined) {
          send(400, { error: { status: 'INVALID_ARGUMENT' } });
          return;
        }
        send(200, { tokenPayloadExternal: verdict });
        return;
      }
      send(404, { error: 'not_found' });
    })();
  });
  server.listen(PORT + 4, '127.0.0.1');
  google = server;
  return { verdicts, decodes };
}

/** A device's DPoP key: its RFC 7638 thumbprint and fresh proofs for the token endpoint. */
type DpopKey = { jkt: string; proof: () => Promise<string> };

async function dpopKey(): Promise<DpopKey> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const jwk = await exportJWK(publicKey);
  return {
    jkt: await calculateJwkThumbprint(jwk, 'sha256'),
    proof: () =>
      new SignJWT({
        jti: randomUUID(),
        htm: 'POST',
        htu: `${issuer}/token`,
        iat: Math.floor(Date.now() / 1000),
      })
        .setProtectedHeader({ alg: 'EdDSA', typ: 'dpop+jwt', jwk })
        .sign(privateKey),
  };
}

type Authorization = {
  code: string;
  verifier: string;
  key: DpopKey;
};

async function authorize(base: string): Promise<Authorization | { status: number; error: string }> {
  const key = await dpopKey();
  const verifier = randomBytes(32).toString('base64url');
  const url = new URL('/authorize', base);
  for (const [name, value] of Object.entries({
    response_type: 'code',
    client_id: 'kilo-mobile',
    redirect_uri: REDIRECT,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    scope: SCOPE,
    state: 'attest-e2e',
    dpop_jkt: key.jkt,
  })) {
    url.searchParams.set(name, value);
  }
  const response = await fetch(url, { redirect: 'manual' });
  const location = response.headers.get('Location');
  const code = location === null ? null : new URL(location).searchParams.get('code');
  if (response.status !== 302 || code === null) {
    const body = await response.json().catch(() => ({}));
    return {
      status: response.status,
      error: z.object({ error: z.string() }).catch({ error: '' }).parse(body).error,
    };
  }
  secrets.push(code, verifier);
  return { code, verifier, key };
}

async function authorized(): Promise<Authorization> {
  const result = await authorize(MINT);
  if ('status' in result) throw new Error(`authorize answered ${result.status} ${result.error}`);
  return result;
}

const TokenBodySchema = z.object({
  refresh_token: z.string(),
  issued_tokens: z.array(z.unknown()),
});
const ErrorBodySchema = z.object({ error: z.string() });

async function exchange(
  authorization: Authorization,
  attestation: Record<string, string> = {}
): Promise<{ status: number; error: string | null; refreshToken: string | null }> {
  const response = await fetch(`${MINT}/token`, {
    method: 'POST',
    headers: { DPoP: await authorization.key.proof() },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorization.code,
      redirect_uri: REDIRECT,
      client_id: 'kilo-mobile',
      code_verifier: authorization.verifier,
      device_platform: 'e2e',
      ...attestation,
    }),
  });
  const body: unknown = await response.json();
  const tokens = TokenBodySchema.safeParse(body);
  if (tokens.success) secrets.push(tokens.data.refresh_token);
  return {
    status: response.status,
    error: ErrorBodySchema.safeParse(body).data?.error ?? null,
    refreshToken: tokens.data?.refresh_token ?? null,
  };
}

async function keyAttestation(device: StandInAppAttestDevice, code: string) {
  const attestation = await device.attest(await clientDataHashOf(code));
  secrets.push(attestation);
  return {
    attestation_type: 'app_attest_key',
    attestation_key_id: device.keyId,
    attestation,
  };
}

async function assertion(device: StandInAppAttestDevice, code: string, counter?: number) {
  const value = await device.assert(
    await clientDataHashOf(code),
    counter === undefined ? {} : { counter }
  );
  secrets.push(value);
  return {
    attestation_type: 'app_attest_assertion',
    attestation_key_id: device.keyId,
    attestation: value,
  };
}

async function main(): Promise<void> {
  const store = await openE2eStore('uts_attest_e2e');
  admin = store.admin;
  await admin.query('SET ROLE uts_owner');
  await admin.query(
    `INSERT INTO uts.accounts (id, primary_email) VALUES ($1, 'e2e@example.com') ON CONFLICT DO NOTHING`,
    [ACCOUNT]
  );

  const ca = await standInAppAttestCa();
  const serviceAccount = await generateKeyPair('RS256', { extractable: true });
  const clientEmail = 'uts-play-integrity@example-project.iam.gserviceaccount.com';
  const { verdicts, decodes } = startGoogle(serviceAccount.publicKey, clientEmail);
  const complete = {
    ATTEST_APPLE_TEAM_ID: TEAM_ID,
    ATTEST_APPLE_BUNDLE_ID: BUNDLE_ID,
    ATTEST_PLAY_INTEGRITY_PACKAGE_NAME: PACKAGE,
    ATTEST_PLAY_INTEGRITY_CERT_DIGESTS: DIGEST.toString('hex'),
    ATTEST_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY: JSON.stringify({
      type: 'service_account',
      project_id: 'example-project',
      private_key_id: randomBytes(20).toString('hex'),
      private_key: await exportPKCS8(serviceAccount.privateKey),
      client_email: clientEmail,
    }),
    ATTEST_DEV_ENDPOINTS: JSON.stringify({
      appleRootCertificate: Buffer.from(ca.root).toString('base64'),
      playIntegrityOrigin: GOOGLE,
    }),
  };
  const { ATTEST_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY: _withheld, ...incomplete } = complete;

  const mint = startMint('mint', PORT, complete, store.urls);
  const refusing = startMint('mint-refusing', PORT + 2, incomplete, store.urls);
  await waitForHttp(`${MINT}/.well-known/oauth-authorization-server`, mint);
  await waitForHttp(`${REFUSING}/.well-known/oauth-authorization-server`, refusing);
  const startId = (
    await admin.query<{ id: string }>(
      'SELECT coalesce(max(id), 0)::text AS id FROM uts.audit_events'
    )
  ).rows[0].id;

  // 1. iOS: a new key, then an assertion.
  const device = await standInAppAttestDevice(ca, APP_ID);
  const first = await authorized();
  const attested = await exchange(first, await keyAttestation(device, first.code));
  log('iOS key attestation', { status: attested.status, error: attested.error });
  check(attested.status === 200, 'a valid App Attest key attestation is admitted');
  const keyRow = await admin.query<{ sign_count: string }>(
    'SELECT sign_count::text FROM uts.app_attest_keys WHERE key_id = $1',
    [Buffer.from(device.keyId, 'base64')]
  );
  check(keyRow.rows[0]?.sign_count === '0', 'the attested key is stored with counter 0');

  const second = await authorized();
  const firstAssertion = await assertion(device, second.code);
  const asserted = await exchange(second, firstAssertion);
  log('iOS assertion', { status: asserted.status, error: asserted.error });
  check(asserted.status === 200, 'a valid App Attest assertion is admitted');
  const counted = await admin.query<{ sign_count: string }>(
    'SELECT sign_count::text FROM uts.app_attest_keys WHERE key_id = $1',
    [Buffer.from(device.keyId, 'base64')]
  );
  check(counted.rows[0]?.sign_count === '1', 'the assertion moved the stored counter to 1');

  // A lost answer: the app sends the stored key's attestation again for a new code.
  const lost = await authorized();
  const reattested = await exchange(lost, await keyAttestation(device, lost.code));
  log('iOS attestation of a stored key, new code', {
    status: reattested.status,
    error: reattested.error,
  });
  check(
    reattested.status === 400 && reattested.error === 'attestation_required',
    'an attestation of a stored key asks for an assertion or a new key'
  );
  const lostAssertion = await exchange(lost, await assertion(device, lost.code));
  check(lostAssertion.status === 200, 'the same code then exchanges with an assertion of the key');

  // 2. Replays.
  const third = await authorized();
  const replayed = await exchange(third, firstAssertion);
  log('iOS assertion replayed for another code', {
    status: replayed.status,
    error: replayed.error,
  });
  check(
    replayed.status === 400 && replayed.error === 'invalid_grant',
    'a replayed assertion is refused'
  );
  const thirdAgain = await exchange(third, await assertion(device, third.code));
  check(
    thirdAgain.status === 400 && thirdAgain.error === 'invalid_grant',
    'the code of a refused attestation never exchanges, even with a valid assertion'
  );

  const fourth = await authorized();
  const sameCounter = await exchange(fourth, await assertion(device, fourth.code, 1));
  log('iOS assertion with a repeated counter', {
    status: sameCounter.status,
    error: sameCounter.error,
  });
  check(
    sameCounter.status === 400 && sameCounter.error === 'invalid_grant',
    'a repeated counter is refused'
  );

  const unknownDevice = await standInAppAttestDevice(ca, APP_ID);
  const fifth = await authorized();
  const unknown = await exchange(fifth, await assertion(unknownDevice, fifth.code));
  log('iOS assertion of a key UTS never attested', {
    status: unknown.status,
    error: unknown.error,
  });
  check(
    unknown.status === 400 && unknown.error === 'attestation_required',
    'an unknown key asks for a new attestation'
  );
  const fifthKey = await exchange(fifth, await keyAttestation(unknownDevice, fifth.code));
  check(fifthKey.status === 200, 'the same code then exchanges with a key attestation');

  // 3. Missing attestation, then Android on the same code.
  const sixth = await authorized();
  const decodesBefore = decodes.length;
  const missing = await exchange(sixth);
  log('exchange without an attestation', { status: missing.status, error: missing.error });
  check(
    missing.status === 400 && missing.error === 'attestation_required',
    'a missing attestation is refused'
  );
  check(decodes.length === decodesBefore, 'a missing attestation costs no decode');

  const play = async (code: string, overrides: Partial<PlayVerdictInput> = {}) => {
    const token = playIntegrityToken();
    secrets.push(token);
    verdicts.set(
      token,
      playVerdict({
        requestHash: await playRequestHashOf(code),
        packageName: PACKAGE,
        certificateDigest: DIGEST.toString('base64url'),
        ...overrides,
      })
    );
    return { attestation_type: 'play_integrity', attestation: token };
  };
  const sixthPlay = await play(sixth.code);
  const android = await exchange(sixth, sixthPlay);
  log('Android Play Integrity', { status: android.status, error: android.error });
  check(android.status === 200, 'a valid Play Integrity verdict is admitted');
  check(decodes.length === decodesBefore + 1, 'one decode for the admitted token');

  // 4. A retry decodes nothing again; the other refusals.
  const retry = await exchange(sixth, sixthPlay);
  log('Android exchange retried', {
    status: retry.status,
    sameGrant: retry.refreshToken === android.refreshToken,
  });
  check(
    retry.status === 200 && retry.refreshToken === android.refreshToken,
    'a retry of the exchange gets the same grant'
  );
  check(decodes.length === decodesBefore + 1, 'the retry makes no second decode');

  const seventh = await authorized();
  const replayedPlay = await exchange(seventh, sixthPlay);
  log('Play token replayed for another code', {
    status: replayedPlay.status,
    error: replayedPlay.error,
  });
  check(
    replayedPlay.status === 400 && replayedPlay.error === 'invalid_grant',
    'a replayed Play token is refused'
  );

  for (const [name, overrides] of [
    ['a wrong package', { packageName: 'com.example.repackaged' }],
    ['an unrecognized app', { appRecognitionVerdict: 'UNRECOGNIZED_VERSION' }],
    ['another signing certificate', { certificateDigest: randomBytes(32).toString('base64url') }],
    ['basic device integrity only', { deviceRecognitionVerdict: ['MEETS_BASIC_INTEGRITY'] }],
  ] as const) {
    const authorization = await authorized();
    const refused = await exchange(authorization, await play(authorization.code, overrides));
    log(`Play verdict with ${name}`, { status: refused.status, error: refused.error });
    check(
      refused.status === 400 && refused.error === 'invalid_grant',
      `a verdict with ${name} is refused`
    );
  }

  // 5. Refuse by default.
  const refusedClient = await authorize(REFUSING);
  log('authorize kilo-mobile, one attestation value missing', refusedClient);
  check(
    'status' in refusedClient &&
      refusedClient.status === 400 &&
      refusedClient.error === 'unauthorized_client',
    'an incomplete attestation config refuses kilo-mobile'
  );
  // wrangler dev prints the Worker's log lines after the response, so wait for the line.
  let refusingLog = '';
  for (
    let attempt = 0;
    attempt < 20 && !refusingLog.includes('uts.attestation.misconfigured');
    attempt += 1
  ) {
    await sleep(250);
    refusingLog = refusing.lines.join('');
  }
  check(
    refusingLog.includes('uts.attestation.misconfigured') &&
      refusingLog.includes('ATTEST_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY'),
    'the refusing Worker logs the missing value by name'
  );

  // 6. Audit rows.
  const denied = await admin.query<{ reason: string }>(
    `SELECT event #>> '{data,attributes,reason}' AS reason FROM uts.audit_events
     WHERE id > $1 AND event_type = 'ai.kilo.uts.token.denied'
       AND event #>> '{data,outcomeDetail}' = 'attestation refused'
     ORDER BY id`,
    [startId]
  );
  const reasons = denied.rows.map(row => row.reason);
  log('attestation refusals in the audit rows', reasons);
  check(
    JSON.stringify(reasons) ===
      JSON.stringify([
        'signature_invalid',
        'counter_not_increased',
        'request_hash_mismatch',
        'package_mismatch',
        'app_not_recognized',
        'certificate_mismatch',
        'device_integrity',
      ]),
    'each refusal wrote one audit row with its reason'
  );
  const auditText = (
    await admin.query<{ text: string }>(
      `SELECT coalesce(string_agg(event::text, ' '), '') AS text FROM uts.audit_events WHERE id > $1`,
      [startId]
    )
  ).rows[0].text;
  const leaked = secrets.filter(secret => auditText.includes(secret));
  log('credential values checked in audit rows', { checked: secrets.length, found: leaked.length });
  check(leaked.length === 0, 'no credential value reached an audit row');
  log('Play Integrity decode calls', { total: decodes.length });
}

try {
  await main();
} catch (error) {
  failures += 1;
  console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await cleanup();
}
console.log(failures === 0 ? 'attest e2e passed' : `attest e2e failed: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
