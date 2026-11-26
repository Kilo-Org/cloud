/**
 * Local end-to-end run of identity import, authority sync and subject operations against
 * `wrangler dev -c wrangler.dev.jsonc` (mint Worker), `wrangler dev --env local` (feed Worker) and
 * the local identity store (README, "Subject operations and identity import"). It plays the web
 * app's outbox: it sends each operation over `POST /internal/...` with the development stand-in
 * STS token, retries after `Retry-After` on 503 and `retry_later`, and stops on every other answer.
 * It checks the import (tombstones, stale versions, deletion), each operation's effect on a CLI
 * grant, a mobile grant, a PAT and a browser session, the feed entries each one publishes, the
 * unblock wait, terminal deletion, the user-created event and the audit rows. Synthetic data only;
 * it prints ids and outcomes, never a token or a PAT.
 *
 *   UTS_E2E_BASE_URL   the mint Worker, such as http://127.0.0.1:9220
 *   UTS_E2E_FEED_URL   the feed Worker, such as http://127.0.0.1:9222
 *   UTS_E2E_ADMIN_URL  admin login to the identity-store database (loopback only)
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  CreatedPatSchema,
  FeedHeadPayloadSchema,
  RevocationListWireSchema,
  UTS_ENDPOINTS,
  httpsFeedSources,
  type RevocationListWire,
} from '@kilocode/uts-contracts';
import { SignJWT, calculateJwkThumbprint, decodeJwt, exportJWK, generateKeyPair } from 'jose';
import pg from 'pg';
import { z } from 'zod';
import { isLoopbackHost } from './connection';

const base = z.url().parse(process.env.UTS_E2E_BASE_URL);
const feedUrl = z.url().parse(process.env.UTS_E2E_FEED_URL);
const adminUrl = z.url().parse(process.env.UTS_E2E_ADMIN_URL);
if (!isLoopbackHost(new URL(adminUrl))) throw new Error('the end-to-end run uses a local database');

const issuer = UTS_ENDPOINTS.development.issuer;
/** The account the development sign-in hand-off signs in; this run imports it first. */
const ACCOUNT = 'dev:uts-local';
const CLI_CALLBACK = 'http://127.0.0.1:4100/callback';
const MOBILE_CALLBACK = 'com.kilocode.kiloapp:/oauth/callback';
const sources = httpsFeedSources(feedUrl);
const secrets: string[] = [];
let failed = 0;
let version = 0;

function log(step: string, detail: unknown, ok = true) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step.padEnd(52)} ${JSON.stringify(detail)}`);
}

type Answer = { status: number; retryAfter: string | null; body: unknown };

/** One `/internal/` call with the development stand-in STS token of `workload` for `scope`. */
async function internal(path: string, body: unknown, scope: string | null, workload = 'web') {
  const response = await fetch(new URL(path.slice(1), base), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(scope === null ? {} : { Authorization: `Bearer uts-dev-sts:${workload}:${scope}` }),
    },
    body: JSON.stringify(body),
  });
  const answer: Answer = {
    status: response.status,
    retryAfter: response.headers.get('Retry-After'),
    body: await response.json(),
  };
  return answer;
}

const SCOPES: Record<string, string> = {
  revoke: 'uts:subjects.revoke',
  unblock: 'uts:subjects.revoke',
  'end-browser-sessions': 'uts:browser-sessions.end',
  'end-device-sessions': 'uts:device-sessions.end',
  'revoke-api-credentials': 'uts:api-credentials.revoke',
};

/**
 * The outbox: sends one operation and retries the same `operation_id` after `Retry-After` on a
 * 503 or a `retry_later`, as the web app's outbox does. Answers every answer it got.
 */
async function outbox(
  op: string,
  subject: string,
  reason: string,
  options: { operationId?: string; sourceVersion?: number; retries?: number } = {}
): Promise<Answer[]> {
  version += 1;
  const body = {
    operation_id: options.operationId ?? randomUUID(),
    subject,
    reason,
    actor: 'admin:e2e-staff',
    source_version: options.sourceVersion ?? version,
  };
  const answers: Answer[] = [];
  for (let attempt = 0; attempt <= (options.retries ?? 5); attempt += 1) {
    const answer = await internal(`/internal/subjects/${op}`, body, SCOPES[op]);
    answers.push(answer);
    const retry =
      answer.status === 503 ||
      (answer.status === 409 &&
        z.object({ outcome: z.literal('retry_later') }).safeParse(answer.body).success);
    if (!retry) break;
    await sleep(Number(answer.retryAfter ?? '1') * 1000);
  }
  return answers;
}

const outcomeOf = (answer: Answer | undefined) =>
  z.object({ outcome: z.string() }).safeParse(answer?.body).data?.outcome ?? null;

async function readFeed(): Promise<RevocationListWire> {
  const signal = () => AbortSignal.timeout(5000);
  const head = await sources.feed.head(signal());
  const payload = FeedHeadPayloadSchema.parse(decodeJwt(head));
  const bytes = await sources.feed.list(payload.list_hash, signal());
  return RevocationListWireSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

/** Polls the feed until `found` holds; answers the seconds it took, or null after `limitS`. */
async function feedUntil(found: (list: RevocationListWire) => boolean, limitS = 60) {
  const started = Date.now();
  while (Date.now() - started < limitS * 1000) {
    try {
      if (found(await readFeed())) return Math.round((Date.now() - started) / 100) / 10;
    } catch {
      // An unavailable read counts as not yet.
    }
    await sleep(250);
  }
  return null;
}

/** A first-party grant through the development sign-in: the CLI or the mobile app. */
async function grant(client: 'kilo-cli' | 'kilo-mobile') {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const jwk = await exportJWK(publicKey);
  const proof = () =>
    new SignJWT({
      jti: randomUUID(),
      htm: 'POST',
      htu: `${issuer}/token`,
      iat: Math.floor(Date.now() / 1000),
    })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'dpop+jwt', jwk })
      .sign(privateKey);
  const verifier = randomBytes(32).toString('base64url');
  const redirect = client === 'kilo-cli' ? CLI_CALLBACK : MOBILE_CALLBACK;
  const authorize = new URL('authorize', base);
  for (const [name, value] of Object.entries({
    response_type: 'code',
    client_id: client,
    redirect_uri: redirect,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    scope: client === 'kilo-cli' ? 'uts:pats.manage' : 'notifications:badges.read',
    state: 'subjects-e2e',
    dpop_jkt: await calculateJwkThumbprint(jwk, 'sha256'),
  })) {
    authorize.searchParams.set(name, value);
  }
  const location = new URL(
    (await fetch(authorize, { redirect: 'manual' })).headers.get('Location') ?? 'about:blank'
  );
  const code = location.searchParams.get('code');
  if (code === null) {
    return { authorizeError: location.searchParams.get('error') ?? 'no_code' } as const;
  }
  secrets.push(code);
  const token = async (form: Record<string, string>) => {
    const response = await fetch(new URL('token', base), {
      method: 'POST',
      headers: { DPoP: await proof() },
      body: new URLSearchParams({ client_id: client, ...form }),
    });
    const body = z
      .looseObject({ refresh_token: z.string().optional(), access_token: z.string().optional() })
      .safeParse(await response.json()).data;
    for (const value of [body?.refresh_token, body?.access_token]) {
      if (value !== undefined) secrets.push(value);
    }
    return { status: response.status, body };
  };
  const exchanged = await token({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirect,
    code_verifier: verifier,
  });
  const refreshToken = exchanged.body?.refresh_token ?? '';
  const accessToken = exchanged.body?.access_token ?? '';
  const sid = z.object({ sid: z.uuid() }).parse(decodeJwt(accessToken)).sid;
  return {
    authorizeError: null,
    sid,
    accessToken,
    refresh: async () =>
      (await token({ grant_type: 'refresh_token', refresh_token: refreshToken })).status,
  } as const;
}

async function signedIn(client: 'kilo-cli' | 'kilo-mobile') {
  const result = await grant(client);
  if (result.authorizeError !== null)
    throw new Error(`authorize refused: ${result.authorizeError}`);
  return result;
}

async function createPat(accessToken: string) {
  const response = await fetch(new URL('account/pats', base), {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'e2e', scope: 'uts:probe.read', expires_in_days: 30 }),
  });
  const pat = CreatedPatSchema.parse(await response.json());
  secrets.push(pat.token, createHash('sha256').update(pat.token).digest('hex'));
  return pat;
}

async function probe(pat: string) {
  const response = await fetch(new URL('probe/pat', base), {
    headers: { Authorization: `Bearer ${pat}`, 'CF-Connecting-IP': '192.0.2.77' },
  });
  return response.status;
}

/** Polls the probe route until it refuses the PAT; answers the seconds it took. */
async function probeRefusedWithin(pat: string, limitS = 60) {
  const started = Date.now();
  while (Date.now() - started < limitS * 1000) {
    if ((await probe(pat)) === 401) return Math.round((Date.now() - started) / 100) / 10;
    await sleep(250);
  }
  return null;
}

function importBody(appUserId: string, sourceVersion: number) {
  return {
    app_user_id: appUserId,
    primary_email: `${randomBytes(5).toString('hex')}@example.com`,
    status: 'active',
    verified_identities: [
      {
        provider: 'google',
        provider_subject: randomUUID(),
        verified_email: null,
        workos_connection_id: null,
        linked_at: '2025-01-02T03:04:05Z',
      },
    ],
    sso_authority: null,
    passkeys: [
      {
        credential_id: randomBytes(32).toString('base64url'),
        public_key: randomBytes(77).toString('base64url'),
        sign_count: 3,
        transports: ['internal'],
        backup_eligible: true,
        backed_up: true,
        aaguid: null,
        name: 'Synthetic key',
        user_handle: createHash('sha256').update(appUserId).digest('base64url'),
        created_at: '2025-03-04T05:06:07Z',
      },
    ],
    source_version: sourceVersion,
  };
}

const IMPORT = 'uts:accounts.import';

async function main() {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query('SET ROLE uts_owner');
  const startAudit = (
    await admin.query<{ id: string }>('SELECT coalesce(max(id), 0) AS id FROM uts.audit_events')
  ).rows[0].id;

  // --- Import -------------------------------------------------------------------------------
  const imported = await internal('/internal/accounts/import', importBody(ACCOUNT, 10), IMPORT);
  const again = await internal('/internal/accounts/import', importBody(ACCOUNT, 10), IMPORT);
  log(
    'import keeps the app user id',
    { first: imported.body, repeat: again.body },
    outcomeOf(imported) === 'imported' && outcomeOf(again) === 'already_imported'
  );
  version = 10;

  const blockedFirst = `oauth/e2e-${randomUUID()}`;
  const tombstone = await outbox('revoke', blockedFirst, 'access_block', { sourceVersion: 3 });
  const stale = await internal('/internal/accounts/import', importBody(blockedFirst, 2), IMPORT);
  const fresh = await internal('/internal/accounts/import', importBody(blockedFirst, 3), IMPORT);
  const status = await admin.query<{ status: string; revoked: boolean }>(
    'SELECT status::text, revoked_before IS NOT NULL AS revoked FROM uts.accounts WHERE id = $1',
    [blockedFirst]
  );
  log(
    'block before import: tombstone, stale refused, imported blocked',
    {
      operation: tombstone.map(outcomeOf),
      stale: stale.body,
      fresh: fresh.body,
      account: status.rows[0],
    },
    outcomeOf(tombstone[0]) === 'no_subject' &&
      stale.status === 409 &&
      outcomeOf(fresh) === 'imported' &&
      status.rows[0]?.status === 'blocked'
  );

  const deletedFirst = `oauth/e2e-${randomUUID()}`;
  const deletion = await outbox('revoke', deletedFirst, 'account_deleted', { sourceVersion: 1 });
  const afterDeletion = await internal(
    '/internal/accounts/import',
    importBody(deletedFirst, 50),
    IMPORT
  );
  log(
    'deletion before import: the import is refused for good',
    {
      operation: deletion.map(outcomeOf),
      import: afterDeletion.body,
    },
    outcomeOf(deletion[0]) === 'no_subject' && afterDeletion.status === 409
  );

  // --- Admission ----------------------------------------------------------------------------
  const body = {
    operation_id: randomUUID(),
    subject: ACCOUNT,
    reason: 'access_block',
    actor: 'admin:e2e',
    source_version: 1,
  };
  const noToken = await internal('/internal/subjects/revoke', body, null);
  const wrongScope = await internal('/internal/subjects/revoke', body, 'uts:browser-sessions.end');
  const otherWorkload = await internal(
    '/internal/subjects/revoke',
    body,
    'uts:subjects.revoke',
    'o11y'
  );
  const badActor = await internal(
    '/internal/subjects/revoke',
    { ...body, actor: 'anyone' },
    'uts:subjects.revoke'
  );
  const wrongReason = await internal('/internal/subjects/unblock', body, 'uts:subjects.revoke');
  log(
    'refusals before any statement',
    {
      noToken: noToken.status,
      wrongScope: wrongScope.status,
      otherWorkload: otherWorkload.status,
      badActor: badActor.status,
      wrongReason: [wrongReason.status, wrongReason.body],
    },
    noToken.status === 401 &&
      wrongScope.status === 403 &&
      otherWorkload.status === 403 &&
      badActor.status === 400 &&
      wrongReason.status === 409
  );

  // --- Credentials of every kind ------------------------------------------------------------
  let cli = await signedIn('kilo-cli');
  const mobile = await signedIn('kilo-mobile');
  const pat = await createPat(cli.accessToken);
  log('signed in: CLI and mobile grants, one PAT', {
    cli: cli.sid,
    mobile: mobile.sid,
    pat: pat.id,
    probe: await probe(pat.token),
  });

  // Warm the feed objects: their first backfill must run before they vouch for a list.
  await feedUntil(() => true, 30);

  // revoke-api-credentials: PATs only.
  const apiReset = await outbox('revoke-api-credentials', ACCOUNT, 'staff_api_reset');
  const patRefused = await probeRefusedWithin(pat.token);
  const patInFeed = await feedUntil(list => list.revoked_pat_ids.includes(pat.id));
  const [cliAfterPat, mobileAfterPat] = [await cli.refresh(), await mobile.refresh()];
  log(
    'revoke-api-credentials: PAT refused, grants untouched',
    {
      answers: apiReset.map(answer => [answer.status, outcomeOf(answer)]),
      patRefusedAfterS: patRefused,
      patInFeedAfterS: patInFeed,
      cliRefresh: cliAfterPat,
      mobileRefresh: mobileAfterPat,
    },
    outcomeOf(apiReset.at(-1)) === 'applied' &&
      patRefused !== null &&
      patInFeed !== null &&
      cliAfterPat === 200 &&
      mobileAfterPat === 200
  );

  // end-device-sessions: CLI and mobile grants only; a PAT made before stays.
  const keptPat = await createPat(cli.accessToken);
  const deviceOperation = randomUUID();
  const devices = await outbox('end-device-sessions', ACCOUNT, 'apple_consent_revoked', {
    operationId: deviceOperation,
  });
  const devicesInFeed = await feedUntil(
    list => list.revoked_sids.includes(cli.sid) && list.revoked_sids.includes(mobile.sid)
  );
  const repeat = await outbox('end-device-sessions', ACCOUNT, 'apple_consent_revoked', {
    operationId: deviceOperation,
  });
  log(
    'end-device-sessions: CLI and mobile ended, PAT kept, idempotent',
    {
      answers: devices.map(outcomeOf),
      repeat: repeat.map(outcomeOf),
      sidsInFeedAfterS: devicesInFeed,
      cliRefresh: await cli.refresh(),
      mobileRefresh: await mobile.refresh(),
      keptPatProbe: await probe(keptPat.token),
    },
    outcomeOf(devices.at(-1)) === 'applied' &&
      outcomeOf(repeat.at(-1)) === 'already_applied' &&
      devicesInFeed !== null &&
      (await probe(keptPat.token)) === 200
  );

  // end-browser-sessions: browser sessions only.
  cli = await signedIn('kilo-cli');
  const browser = (
    await admin.query<{ id: string }>(
      `INSERT INTO uts.browser_sessions (account_id, token_hash, auth_time, amr, idle_expires_at, expires_at)
       VALUES ($1, $2, now(), '{oauth}', now() + interval '14 days', now() + interval '30 days') RETURNING id`,
      [ACCOUNT, randomBytes(32)]
    )
  ).rows[0].id;
  const browserEnd = await outbox('end-browser-sessions', ACCOUNT, 'staff_signout');
  const browserInFeed = await feedUntil(list => list.revoked_sids.includes(browser));
  const browserRow = await admin.query<{ status: string }>(
    'SELECT status::text FROM uts.browser_sessions WHERE id = $1',
    [browser]
  );
  const cliAfterBrowser = await cli.refresh();
  log(
    'end-browser-sessions: browser ended, CLI kept',
    {
      answers: browserEnd.map(outcomeOf),
      session: browserRow.rows[0],
      sidInFeedAfterS: browserInFeed,
      cliRefresh: cliAfterBrowser,
    },
    outcomeOf(browserEnd.at(-1)) === 'applied' && browserInFeed !== null && cliAfterBrowser === 200
  );

  // access_block: everything, and the account in blocked_accounts.
  const block = await outbox('revoke', ACCOUNT, 'access_block');
  const blockedInFeed = await feedUntil(
    list => list.blocked_accounts.includes(ACCOUNT) && ACCOUNT in list.revoked_before
  );
  const blockedAuthorize = await grant('kilo-cli');
  log(
    'access_block: grants and PAT refused, account listed blocked',
    {
      answers: block.map(outcomeOf),
      blockedInFeedAfterS: blockedInFeed,
      cliRefresh: await cli.refresh(),
      keptPatProbe: await probe(keptPat.token),
      newSignIn: blockedAuthorize.authorizeError,
    },
    outcomeOf(block.at(-1)) === 'applied' &&
      blockedInFeed !== null &&
      (await cli.refresh()) !== 200 &&
      blockedAuthorize.authorizeError !== null
  );

  // unblock: refused under 60 s with Retry-After, then the outbox waits and retries.
  const unblockStarted = Date.now();
  const unblock = await outbox('unblock', ACCOUNT, 'access_unblock', { retries: 3 });
  const firstUnblock = unblock[0];
  const unblockedInFeed = await feedUntil(list => !list.blocked_accounts.includes(ACCOUNT));
  const oldGrantAfterUnblock = await cli.refresh();
  cli = await signedIn('kilo-cli');
  log(
    'unblock: retry_later, then applied; nothing restored',
    {
      first: [firstUnblock?.status, firstUnblock?.retryAfter, firstUnblock?.body],
      last: outcomeOf(unblock.at(-1)),
      waitedS: Math.round((Date.now() - unblockStarted) / 1000),
      leftBlockedAccountsAfterS: unblockedInFeed,
      oldGrantRefresh: oldGrantAfterUnblock,
      newSignInRefresh: await cli.refresh(),
    },
    firstUnblock?.status === 409 &&
      Number(firstUnblock.retryAfter) >= 1 &&
      Number(firstUnblock.retryAfter) <= 60 &&
      outcomeOf(unblock.at(-1)) === 'applied' &&
      unblockedInFeed !== null &&
      oldGrantAfterUnblock !== 200
  );

  // A 503 while no feed object answers, then the same operation id once they do.
  const recoveryPat = await createPat(cli.accessToken);
  for (const feed of [0, 1]) {
    await fetch(new URL('__dev/feed/stop', base), {
      method: 'POST',
      body: JSON.stringify({ feed, seconds: 6 }),
    });
  }
  const unpublished = await outbox('revoke-api-credentials', ACCOUNT, 'staff_api_reset', {
    retries: 10,
  });
  log(
    '503 until a vouching feed object takes the entries',
    {
      answers: unpublished.map(answer => [answer.status, answer.retryAfter, outcomeOf(answer)]),
      probe: await probe(recoveryPat.token),
    },
    unpublished[0]?.status === 503 && outcomeOf(unpublished.at(-1)) === 'already_applied'
  );

  // account_recovery: revoked_before moves, the account stays active.
  const recovery = await outbox('revoke', ACCOUNT, 'account_recovery');
  log(
    'account_recovery: grant refused, account active',
    {
      answers: recovery.map(outcomeOf),
      cliRefresh: await cli.refresh(),
      account: (
        await admin.query<{ status: string }>(
          'SELECT status::text FROM uts.accounts WHERE id = $1',
          [ACCOUNT]
        )
      ).rows[0],
    },
    outcomeOf(recovery.at(-1)) === 'applied' && (await cli.refresh()) !== 200
  );

  // Authority sync: SSO organization and membership.
  const org = randomUUID();
  const sso = await internal(
    '/internal/authority/sso-organization',
    {
      operation_id: randomUUID(),
      actor: 'system:e2e',
      source_version: 1,
      app_organization_id: org,
      workos_organization_id: 'org_e2e',
      workos_connection_ids: ['conn_e2e'],
      enforcement: 'optional',
    },
    'uts:authority.sync'
  );
  const member = await internal(
    '/internal/authority/membership',
    {
      operation_id: randomUUID(),
      actor: 'system:e2e',
      source_version: version + 1,
      subject: ACCOUNT,
      app_organization_id: org,
      role: 'member',
    },
    'uts:authority.sync'
  );
  const email = await internal(
    '/internal/authority/email',
    {
      operation_id: randomUUID(),
      actor: 'system:e2e',
      source_version: 1,
      subject: ACCOUNT,
      primary_email: 'stale@example.com',
    },
    'uts:authority.sync'
  );
  log(
    'authority sync: SSO setup, membership, a stale email',
    {
      sso: sso.body,
      membership: member.body,
      email: email.body,
    },
    outcomeOf(sso) === 'applied' &&
      outcomeOf(member) === 'applied' &&
      outcomeOf(email) === 'already_applied'
  );

  // account_deleted: terminal.
  const deleted = await outbox('revoke', ACCOUNT, 'account_deleted');
  const deletedInFeed = await feedUntil(
    list => list.blocked_accounts.includes(ACCOUNT) && ACCOUNT in list.revoked_before
  );
  const deleteRepeat = await outbox('revoke', ACCOUNT, 'account_deleted');
  const unblockDeleted = await outbox('unblock', ACCOUNT, 'access_unblock');
  const reimport = await internal('/internal/accounts/import', importBody(ACCOUNT, 1000), IMPORT);
  const row = await admin.query('SELECT 1 FROM uts.accounts WHERE id = $1', [ACCOUNT]);
  log(
    'account_deleted: gone for good',
    {
      answers: deleted.map(outcomeOf),
      listedAfterS: deletedInFeed,
      repeat: outcomeOf(deleteRepeat.at(-1)),
      unblock: [unblockDeleted[0]?.status, unblockDeleted[0]?.body],
      reimport: reimport.body,
      accountRows: row.rowCount,
    },
    outcomeOf(deleted.at(-1)) === 'applied' &&
      deletedInFeed !== null &&
      outcomeOf(deleteRepeat.at(-1)) === 'already_applied' &&
      unblockDeleted[0]?.status === 409 &&
      reimport.status === 409 &&
      row.rowCount === 0
  );

  // The user-created event: an account with a UTS id, read and acknowledged over the outbox.
  const created = `uts_${Array.from(randomBytes(26), byte => 'abcdefghijklmnopqrstuvwxyz234567'[byte % 32]).join('')}`;
  await admin.query(
    "INSERT INTO uts.accounts (id, primary_email) VALUES ($1, 'created-e2e@example.com')",
    [created]
  );
  const read = await internal('/internal/app-events/read', { limit: 100 }, 'uts:app-events.read');
  const events = z
    .object({
      events: z.array(
        z
          .object({ event_id: z.uuid(), type: z.string(), account: z.object({ id: z.string() }) })
          .loose()
      ),
    })
    .parse(read.body).events;
  const event = events.find(item => item.account.id === created);
  const ack = await internal(
    '/internal/app-events/ack',
    { event_ids: [event?.event_id ?? randomUUID()] },
    'uts:app-events.read'
  );
  const reread = await internal('/internal/app-events/read', { limit: 100 }, 'uts:app-events.read');
  log(
    'user.created: read, acknowledged, gone',
    {
      event,
      ack: ack.body,
      leftAfterAck: JSON.stringify(reread.body).includes(created),
    },
    event?.type === 'user.created' && !JSON.stringify(reread.body).includes(created)
  );

  // Audit rows of the run.
  const rows = await admin.query<{
    id: string;
    event_type: string;
    actor: unknown;
    attributes: Record<string, unknown>;
  }>(
    `SELECT id, event_type, event #> '{data,actor}' AS actor, event #> '{data,attributes}' AS attributes
     FROM uts.audit_events WHERE id > $1 AND event_type ~ '(subject|sessions|api_credentials|account\\.imported|synced|tombstoned)' ORDER BY id`,
    [startAudit]
  );
  console.log('\naudit rows:');
  for (const audit of rows.rows) {
    const { reason, requestedBy, sourceVersion, operationId } = audit.attributes;
    console.log(
      `  #${audit.id} ${audit.event_type} ${JSON.stringify({ actor: audit.actor, reason, requestedBy, sourceVersion, operationId })}`
    );
  }
  const text = (
    await admin.query<{ text: string }>(
      "SELECT coalesce(string_agg(event::text, ' '), '') AS text FROM uts.audit_events WHERE id > $1",
      [startAudit]
    )
  ).rows[0].text;
  const leaked = secrets.filter(secret => text.includes(secret)).length;
  log(
    'credential values or hashes in audit rows',
    { checked: secrets.length, found: leaked },
    leaked === 0
  );
  await admin.end();
  log('result', { failed });
  if (failed > 0) process.exitCode = 1;
}

await main();
