import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TestDatabase,
  insertAccount,
  insertBrowserSession,
  insertDeviceSession,
  insertGatePass,
  randomHash,
  sqlStateOf,
} from './harness';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const GENERATED_ALWAYS = '428C9';
const NOT_NULL_VIOLATION = '23502';

let db: TestDatabase;
let writer: pg.Client;
let accountId: string;

// The constraints hold for every writer, so this file writes as the owner: the app login writes
// grants, codes, device sessions and revocations only through the OAuth functions
// (`oauth-grants.test.ts`), and `privileges.test.ts` covers who may write what.
beforeAll(async () => {
  db = await TestDatabase.create();
  writer = await db.connectAsOwner();
  accountId = await insertAccount(writer);
});
afterAll(() => db.drop());

function rejects(statement: string, values: unknown[] = []) {
  return sqlStateOf(() => writer.query(statement, values));
}

describe('domains', () => {
  it('reject a hash that is not 32 bytes', async () => {
    expect(
      await rejects(
        `INSERT INTO uts.tickets (ticket_hash, purpose, audience, account_id, expires_at)
         VALUES ($1, 'stream', 'session-ingest', $2, now() + interval '30 seconds')`,
        [randomHash().subarray(0, 31), accountId]
      )
    ).toBe(CHECK_VIOLATION);
  });

  it.each([
    ['unsorted', '{gateway:models.read,gateway:chat.write}'],
    ['duplicated', '{gateway:chat.write,gateway:chat.write}'],
    ['malformed', '{Gateway:chat}'],
    ['empty', '{}'],
  ])('reject a scope set that is %s', async (_name, scopes) => {
    const deviceSessionId = await insertDeviceSession(writer, accountId);
    expect(
      await rejects(
        `INSERT INTO uts.refresh_grants
           (account_id, device_session_id, client_id, client_class, token_hash, dpop_jkt,
            allowed_scopes, idle_expires_at, expires_at)
         VALUES ($1, $2, 'kilo-cli', 'desktop', $3, $4, $5, now() + interval '30 days',
                 now() + interval '180 days')`,
        [accountId, deviceSessionId, randomHash(), randomHash(), scopes]
      )
    ).toBe(CHECK_VIOLATION);
  });

  it('reject an email address with upper-case letters', async () => {
    expect(
      await rejects(
        `INSERT INTO uts.accounts (id, primary_email) VALUES ('mixed', 'User@example.com')`
      )
    ).toBe(CHECK_VIOLATION);
  });
});

describe('first-party refresh grants', () => {
  async function insertGrant(clientClass: 'desktop' | 'mobile', idleDays: number, maxDays: number) {
    const deviceSessionId = await insertDeviceSession(writer, accountId, clientClass);
    return writer.query(
      `INSERT INTO uts.refresh_grants
         (account_id, device_session_id, client_id, client_class, token_hash, dpop_jkt,
          allowed_scopes, idle_expires_at, expires_at)
       VALUES ($1, $2, 'kilo-cli', $3, $4, $5, '{gateway:models.read}',
               now() + make_interval(days => $6), now() + make_interval(days => $7))`,
      [accountId, deviceSessionId, clientClass, randomHash(), randomHash(), idleDays, maxDays]
    );
  }

  it('accept the longest lifetime of each client class', async () => {
    await insertGrant('desktop', 30, 180);
    await insertGrant('mobile', 60, 365);
  });

  it.each([
    ['desktop', 31, 180],
    ['desktop', 30, 181],
    ['mobile', 61, 365],
    ['mobile', 60, 366],
  ] as const)(
    'reject a %s grant with %i idle days and %i maximum days',
    async (clientClass, idle, max) => {
      expect(await sqlStateOf(() => insertGrant(clientClass, idle, max))).toBe(CHECK_VIOLATION);
    }
  );

  it('reject a revoked grant without a revocation time', async () => {
    const deviceSessionId = await insertDeviceSession(writer, accountId);
    expect(
      await rejects(
        `INSERT INTO uts.refresh_grants
           (account_id, device_session_id, client_id, client_class, token_hash, dpop_jkt,
            allowed_scopes, idle_expires_at, expires_at, status, revoke_reason)
         VALUES ($1, $2, 'kilo-cli', 'desktop', $3, $4, '{gateway:models.read}',
                 now() + interval '1 day', now() + interval '1 day', 'revoked', 'sign_out')`,
        [accountId, deviceSessionId, randomHash(), randomHash()]
      )
    ).toBe(CHECK_VIOLATION);
  });

  it('reject an active grant that carries a revocation time', async () => {
    const deviceSessionId = await insertDeviceSession(writer, accountId);
    expect(
      await rejects(
        `INSERT INTO uts.refresh_grants
           (account_id, device_session_id, client_id, client_class, token_hash, dpop_jkt,
            allowed_scopes, idle_expires_at, expires_at, revoked_at)
         VALUES ($1, $2, 'kilo-cli', 'desktop', $3, $4, '{gateway:models.read}',
                 now() + interval '1 day', now() + interval '1 day', now())`,
        [accountId, deviceSessionId, randomHash(), randomHash()]
      )
    ).toBe(CHECK_VIOLATION);
  });

  it('reject a second grant with the same token hash', async () => {
    const tokenHash = randomHash();
    const insert = async () =>
      writer.query(
        `INSERT INTO uts.refresh_grants
           (account_id, device_session_id, client_id, client_class, token_hash, dpop_jkt,
            allowed_scopes, idle_expires_at, expires_at)
         VALUES ($1, $2, 'kilo-cli', 'desktop', $3, $4, '{gateway:models.read}',
                 now() + interval '1 day', now() + interval '1 day')`,
        [accountId, await insertDeviceSession(writer, accountId), tokenHash, randomHash()]
      );
    await insert();
    expect(await sqlStateOf(insert)).toBe(UNIQUE_VIOLATION);
  });
});

describe('browser sessions', () => {
  it.each([
    ['15 idle days', "interval '15 days'", "interval '30 days'"],
    ['31 maximum days', "interval '14 days'", "interval '31 days'"],
  ])('reject %s', async (_name, idle, max) => {
    expect(
      await rejects(
        `INSERT INTO uts.browser_sessions (account_id, token_hash, auth_time, amr, idle_expires_at, expires_at)
         VALUES ($1, $2, now(), '{oauth}', now() + ${idle}, now() + ${max})`,
        [accountId, randomHash()]
      )
    ).toBe(CHECK_VIOLATION);
  });

  it('reject a session without a sign-in method', async () => {
    expect(
      await rejects(
        `INSERT INTO uts.browser_sessions (account_id, token_hash, auth_time, amr, idle_expires_at, expires_at)
         VALUES ($1, $2, now(), '{}', now() + interval '1 day', now() + interval '1 day')`,
        [accountId, randomHash()]
      )
    ).toBe(CHECK_VIOLATION);
  });
});

describe('third-party refresh tokens', () => {
  async function insertFamily(): Promise<string> {
    const clientId = `https://client.example.com/${crypto.randomUUID()}`;
    await writer.query(
      `INSERT INTO uts.third_party_clients
         (client_id, client_name, redirect_uris, document, fetched_at, cache_expires_at)
       VALUES ($1, 'Example', '{https://client.example.com/callback}', '{}', now(), now() + interval '1 hour')`,
      [clientId]
    );
    const consent = await writer.query<{ id: string }>(
      `INSERT INTO uts.third_party_consents (account_id, client_id, scopes, gate_pass_id)
       VALUES ($1, $2, '{mcp:tools.read}', $3) RETURNING id`,
      [accountId, clientId, await insertGatePass(writer, accountId, 'third_party_approve')]
    );
    const family = await writer.query<{ id: string }>(
      `INSERT INTO uts.third_party_grant_families
         (account_id, client_id, consent_id, scopes, auth_time, amr, expires_at)
       VALUES ($1, $2, $3, '{mcp:tools.read}', now(), '{oauth}', now() + interval '90 days')
       RETURNING id`,
      [accountId, clientId, consent.rows[0].id]
    );
    return family.rows[0].id;
  }

  function insertToken(familyId: string, fields = '', values = '') {
    return writer.query(
      `INSERT INTO uts.third_party_refresh_tokens (family_id, token_hash, idle_expires_at${fields})
       VALUES ($1, $2, now() + interval '30 days'${values})`,
      [familyId, randomHash()]
    );
  }

  it('reject a family longer than 90 days', async () => {
    const familyId = await insertFamily();
    expect(
      await rejects(
        `UPDATE uts.third_party_grant_families SET expires_at = created_at + interval '91 days' WHERE id = $1`,
        [familyId]
      )
    ).toBe(CHECK_VIOLATION);
  });

  it('allow one active token per family', async () => {
    const familyId = await insertFamily();
    await insertToken(familyId);
    expect(await sqlStateOf(() => insertToken(familyId))).toBe(UNIQUE_VIOLATION);
  });

  it('accept a rotated token with a 60-second grace and reject any other grace', async () => {
    const familyId = await insertFamily();
    await insertToken(
      familyId,
      ', status, rotated_at, grace_until',
      ", 'rotated', now(), now() + interval '60 seconds'"
    );
    expect(
      await sqlStateOf(() =>
        insertToken(
          familyId,
          ', status, rotated_at, grace_until',
          ", 'rotated', now(), now() + interval '5 minutes'"
        )
      )
    ).toBe(CHECK_VIOLATION);
    expect(
      await sqlStateOf(() => insertToken(familyId, ', status, rotated_at', ", 'rotated', now()"))
    ).toBe(CHECK_VIOLATION);
  });

  it('reject a token idle window over 30 days', async () => {
    const familyId = await insertFamily();
    expect(
      await rejects(
        `INSERT INTO uts.third_party_refresh_tokens (family_id, token_hash, idle_expires_at)
         VALUES ($1, $2, now() + interval '31 days')`,
        [familyId, randomHash()]
      )
    ).toBe(CHECK_VIOLATION);
  });
});

describe('authorization codes', () => {
  function insertCode(
    challenge: string,
    lifetime: string,
    clientKind = 'first_party',
    jkt: Buffer | null = randomHash()
  ) {
    return writer.query(
      `INSERT INTO uts.authorization_codes
         (code_hash, client_id, client_kind, account_id, redirect_uri, scopes, code_challenge,
          dpop_jkt, auth_time, amr, expires_at)
       VALUES ($1, 'kilo-cli', $2, $3, 'http://127.0.0.1:4100/callback', '{gateway:models.read}',
               $4, $5, now(), '{passkey}', now() + $6::interval)`,
      [randomHash(), clientKind, accountId, challenge, jkt, lifetime]
    );
  }
  const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

  it('accept a 60-second S256 code', async () => {
    await insertCode(challenge, '60 seconds');
  });

  it.each([
    ['a lifetime over 60 seconds', challenge, '61 seconds'],
    ['a plain challenge', 'short-plain-verifier', '60 seconds'],
  ])('reject %s', async (_name, codeChallenge, lifetime) => {
    expect(await sqlStateOf(() => insertCode(codeChallenge, lifetime))).toBe(CHECK_VIOLATION);
  });

  it('reject a first-party code without a DPoP key', async () => {
    expect(await sqlStateOf(() => insertCode(challenge, '60 seconds', 'first_party', null))).toBe(
      CHECK_VIOLATION
    );
  });

  it('tie a consent to every third-party code and only to those', async () => {
    const clientId = `https://client.example.com/${crypto.randomUUID()}`;
    await writer.query(
      `INSERT INTO uts.third_party_clients
         (client_id, client_name, redirect_uris, document, fetched_at, cache_expires_at)
       VALUES ($1, 'Example', '{https://client.example.com/callback}', '{}', now(), now() + interval '1 hour')`,
      [clientId]
    );
    const consent = await writer.query<{ id: string }>(
      `INSERT INTO uts.third_party_consents (account_id, client_id, scopes, gate_pass_id)
       VALUES ($1, $2, '{gateway:models.read}', $3) RETURNING id`,
      [accountId, clientId, await insertGatePass(writer, accountId, 'third_party_approve')]
    );
    const insertWithConsent = (clientKind: string, consentId: string | null) =>
      writer.query(
        `INSERT INTO uts.authorization_codes
           (code_hash, client_id, client_kind, account_id, redirect_uri, scopes, code_challenge,
            auth_time, amr, expires_at, consent_id)
         VALUES ($1, $2, $3, $4, 'https://client.example.com/callback', '{gateway:models.read}',
                 $5, now(), '{oauth}', now() + interval '60 seconds', $6)`,
        [randomHash(), clientId, clientKind, accountId, challenge, consentId]
      );
    await insertWithConsent('third_party', consent.rows[0].id);
    expect(await sqlStateOf(() => insertWithConsent('third_party', null))).toBe(CHECK_VIOLATION);
    expect(await sqlStateOf(() => insertCode(challenge, '60 seconds', 'third_party', null))).toBe(
      CHECK_VIOLATION
    );
  });

  it('name the grant of a consumed code and only of a consumed code', async () => {
    const consume = (grantId: string | null) =>
      writer.query(
        `INSERT INTO uts.authorization_codes
           (code_hash, client_id, client_kind, account_id, redirect_uri, scopes, code_challenge,
            dpop_jkt, auth_time, amr, expires_at, status, consumed_at, grant_id)
         VALUES ($1, 'kilo-cli', 'first_party', $2, 'http://127.0.0.1:4100/callback',
                 '{gateway:models.read}', $3, $4, now(), '{passkey}', now() + interval '60 seconds',
                 'consumed', now(), $5)`,
        [randomHash(), accountId, challenge, randomHash(), grantId]
      );
    await consume(crypto.randomUUID());
    expect(await sqlStateOf(() => consume(null))).toBe(CHECK_VIOLATION);
  });
});

describe('device codes', () => {
  function insertDeviceCode(status: string, extra: Record<string, string | null>) {
    const columns = Object.keys(extra);
    return writer.query(
      `INSERT INTO uts.device_codes
         (device_code_hash, user_code_hash, client_id, scopes, expires_at, status${columns.map(c => `, ${c}`).join('')})
       VALUES ($1, $2, 'kilo-cli', '{gateway:models.read}', now() + interval '10 minutes', $3${columns
         .map((_, index) => `, $${index + 4}`)
         .join('')})`,
      [randomHash(), randomHash(), status, ...Object.values(extra)]
    );
  }

  it('accept each status with its own fields', async () => {
    const now = new Date().toISOString();
    await insertDeviceCode('pending', {});
    await insertDeviceCode('approved', {
      account_id: accountId,
      gate_pass_id: await insertGatePass(writer, accountId, 'device_approve'),
      approved_at: now,
    });
    await insertDeviceCode('denied', { account_id: accountId, denied_at: now });
    await insertDeviceCode('consumed', {
      account_id: accountId,
      gate_pass_id: await insertGatePass(writer, accountId, 'device_approve'),
      approved_at: now,
      consumed_at: now,
    });
  });

  it.each([
    ['approved without a gate pass', 'approved', { approved_at: 'now' }],
    ['consumed without an approval', 'consumed', { consumed_at: 'now' }],
    ['pending with an account', 'pending', { account_id: 'account' }],
    ['denied and approved', 'denied', { denied_at: 'now', approved_at: 'now' }],
  ])('reject a code %s', async (_name, status, fields) => {
    const now = new Date().toISOString();
    const values = Object.fromEntries(
      Object.entries(fields).map(([column, value]) => [
        column,
        value === 'now' ? now : value === 'account' ? accountId : value,
      ])
    );
    if (status !== 'pending') values.account_id = accountId;
    expect(await sqlStateOf(() => insertDeviceCode(status, values))).toBe(CHECK_VIOLATION);
  });

  it('reject a lifetime over 10 minutes', async () => {
    expect(
      await rejects(
        `INSERT INTO uts.device_codes (device_code_hash, user_code_hash, client_id, scopes, expires_at)
         VALUES ($1, $2, 'kilo-cli', '{gateway:models.read}', now() + interval '11 minutes')`,
        [randomHash(), randomHash()]
      )
    ).toBe(CHECK_VIOLATION);
  });
});

describe('email codes and limits', () => {
  function insertEmailCode(
    status: string,
    attempts: number,
    consumed: boolean,
    purpose = 'sign_in',
    account: string | null = null
  ) {
    return writer.query(
      `INSERT INTO uts.email_codes (purpose, email_hash, account_id, code_hash, attempts, expires_at, status, consumed_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '10 minutes', $6, CASE WHEN $7 THEN now() END)`,
      [purpose, randomHash(), account, randomHash(), attempts, status, consumed]
    );
  }

  it('accept each status with its own fields', async () => {
    await insertEmailCode('pending', 4, false);
    await insertEmailCode('consumed', 1, true);
    await insertEmailCode('exhausted', 5, false);
  });

  it.each([
    ['a sixth attempt', 'pending', 6, false],
    ['an exhausted code under 5 attempts', 'exhausted', 4, false],
    ['a pending code at 5 attempts', 'pending', 5, false],
    ['a consumed code without a time', 'consumed', 1, false],
  ])('reject %s', async (_name, status, attempts, consumed) => {
    expect(await sqlStateOf(() => insertEmailCode(status, attempts, consumed))).toBe(
      CHECK_VIOLATION
    );
  });

  it('reject a tier A code without an account', async () => {
    expect(await sqlStateOf(() => insertEmailCode('pending', 0, false, 'tier_a'))).toBe(
      CHECK_VIOLATION
    );
    await insertEmailCode('pending', 0, false, 'tier_a', accountId);
  });

  it('cap a limit row at 5 codes per hour and stop only sign-in codes', async () => {
    const insertLimit = (purpose: string, sent: number, status: string, stopped: boolean) =>
      writer.query(
        `INSERT INTO uts.email_code_limits
           (purpose, email_hash, hour_started_at, sent_in_hour, day_started_at, failures_in_day, status, stopped_until)
         VALUES ($1, $2, now(), $3, now(), 20, $4, CASE WHEN $5 THEN now() + interval '1 hour' END)`,
        [purpose, randomHash(), sent, status, stopped]
      );
    await insertLimit('sign_in', 5, 'stopped', true);
    expect(await sqlStateOf(() => insertLimit('sign_in', 6, 'open', false))).toBe(CHECK_VIOLATION);
    expect(await sqlStateOf(() => insertLimit('tier_a', 5, 'stopped', true))).toBe(CHECK_VIOLATION);
    expect(await sqlStateOf(() => insertLimit('sign_in', 5, 'stopped', false))).toBe(
      CHECK_VIOLATION
    );
  });
});

describe('tickets', () => {
  it('reject a ticket that lives over 60 seconds', async () => {
    expect(
      await rejects(
        `INSERT INTO uts.tickets (ticket_hash, purpose, audience, account_id, expires_at)
         VALUES ($1, 'stream', 'session-ingest', $2, now() + interval '61 seconds')`,
        [randomHash(), accountId]
      )
    ).toBe(CHECK_VIOLATION);
  });
});

describe('PATs and org bot keys', () => {
  it('reject a PAT that lives over 1 year', async () => {
    expect(
      await rejects(
        `INSERT INTO uts.personal_access_tokens
           (account_id, name, token_hash, last_four, audience, scope, gate_pass_id, expires_at)
         VALUES ($1, 'ci', $2, 'abcd', 'gateway', 'gateway:models.read', $3, now() + interval '366 days')`,
        [accountId, randomHash(), await insertGatePass(writer, accountId, 'pat_create')]
      )
    ).toBe(CHECK_VIOLATION);
  });

  async function insertBotKey(status: string, fields: string, values: string) {
    return writer.query(
      `INSERT INTO uts.org_bot_keys
         (org_id, created_by, name, token_hash, last_four, audience, scope, gate_pass_id, expires_at, status${fields})
       VALUES (gen_random_uuid(), $1, 'bot', $2, 'wxyz', 'gateway', 'gateway:models.read', $3,
               now() + interval '90 days', $4${values})`,
      [accountId, randomHash(), await insertGatePass(writer, accountId, 'bot_key_create'), status]
    );
  }

  it('accept each bot key status with its own fields', async () => {
    await insertBotKey('active', '', '');
    await insertBotKey('flagged', ', flagged_at', ', now()');
    await insertBotKey('kept', ', flagged_at, kept_by, kept_at', ', now(), $1, now()');
    await insertBotKey('revoked', ', revoked_at, revoked_by', ', now(), $1');
  });

  it.each([
    ['a flagged key without a flag time', 'flagged', '', ''],
    ['a kept key without the admin who kept it', 'kept', ', flagged_at, kept_at', ', now(), now()'],
    ['a kept key that was never flagged', 'kept', ', kept_by, kept_at', ', $1, now()'],
    ['an active key with a flag time', 'active', ', flagged_at', ', now()'],
  ])('reject %s', async (_name, status, fields, values) => {
    expect(await sqlStateOf(() => insertBotKey(status, fields, values))).toBe(CHECK_VIOLATION);
  });
});

describe('gate passes and step-ups', () => {
  it('reject a tier A pass without the emailed code', async () => {
    const sessionId = await insertBrowserSession(writer, accountId);
    expect(
      await rejects(
        `INSERT INTO uts.gate_passes (account_id, browser_session_id, tier, action, satisfied_by, expires_at)
         VALUES ($1, $2, 'a', 'passkey_add', '{recent_sign_in}', now() + interval '10 minutes')`,
        [accountId, sessionId]
      )
    ).toBe(CHECK_VIOLATION);
  });

  it('reject an email change without the code sent to the new address', async () => {
    const sessionId = await insertBrowserSession(writer, accountId);
    expect(
      await rejects(
        `INSERT INTO uts.gate_passes (account_id, browser_session_id, tier, action, satisfied_by, expires_at)
         VALUES ($1, $2, 'a', 'email_change', '{recent_sign_in,email_code}', now() + interval '10 minutes')`,
        [accountId, sessionId]
      )
    ).toBe(CHECK_VIOLATION);
  });

  it('reject a tier B pass for a tier A action, and a pass over 10 minutes', async () => {
    const sessionId = await insertBrowserSession(writer, accountId);
    expect(
      await rejects(
        `INSERT INTO uts.gate_passes (account_id, browser_session_id, tier, action, satisfied_by, expires_at)
         VALUES ($1, $2, 'b', 'method_remove', '{passkey}', now() + interval '10 minutes')`,
        [accountId, sessionId]
      )
    ).toBe(CHECK_VIOLATION);
    expect(
      await rejects(
        `INSERT INTO uts.gate_passes (account_id, browser_session_id, tier, action, satisfied_by, expires_at)
         VALUES ($1, $2, 'b', 'pat_create', '{passkey}', now() + interval '11 minutes')`,
        [accountId, sessionId]
      )
    ).toBe(CHECK_VIOLATION);
  });

  it('require an admin step-up to carry a recent company sign-in and the client address', async () => {
    const sessionId = await insertBrowserSession(writer, accountId);
    const passkey = await writer.query<{ id: string }>(
      `INSERT INTO uts.passkey_credentials
         (account_id, credential_id, public_key, backup_eligible, backed_up, rp_id, name)
       VALUES ($1, $2, '\\x01', true, true, 'app.example.com', 'laptop') RETURNING id`,
      [accountId, randomHash()]
    );
    const insertStepUp = (ssoAge: string, ip: string | null) =>
      writer.query(
        `INSERT INTO uts.step_ups
           (account_id, browser_session_id, purpose, passkey_credential_id, expires_at, sso_auth_time, client_ip)
         VALUES ($1, $2, 'admin', $3, now() + interval '10 minutes', now() - $4::interval, $5)`,
        [accountId, sessionId, passkey.rows[0].id, ssoAge, ip]
      );
    await insertStepUp('11 hours', '192.0.2.10');
    expect(await sqlStateOf(() => insertStepUp('13 hours', '192.0.2.10'))).toBe(CHECK_VIOLATION);
    expect(await sqlStateOf(() => insertStepUp('1 hour', null))).toBe(CHECK_VIOLATION);
  });
});

describe('revocations', () => {
  it('keep a PAT entry exactly 15 minutes and every other entry at least 10 minutes', async () => {
    const insert = (kind: string, feedExpiry: string, revokedBefore: string | null = null) =>
      writer.query(
        `INSERT INTO uts.revocations (kind, subject_id, revoked_before, feed_expires_at)
         VALUES ($1, $2, $3::timestamptz, now() + $4::interval)`,
        [kind, crypto.randomUUID(), revokedBefore, feedExpiry]
      );
    await insert('pat', '15 minutes');
    await insert('grant', '20 minutes');
    await insert('subject', '20 minutes', new Date(Date.now() - 1000).toISOString());
    expect(await sqlStateOf(() => insert('pat', '20 minutes'))).toBe(CHECK_VIOLATION);
    expect(await sqlStateOf(() => insert('session', '5 minutes'))).toBe(CHECK_VIOLATION);
    expect(await sqlStateOf(() => insert('subject', '20 minutes'))).toBe(CHECK_VIOLATION);
    expect(await sqlStateOf(() => insert('grant', '20 minutes', new Date().toISOString()))).toBe(
      CHECK_VIOLATION
    );
  });
});

describe('org membership replica', () => {
  it('keep a removed membership with its removal time', async () => {
    const orgId = crypto.randomUUID();
    expect(
      await rejects(
        `INSERT INTO uts.org_memberships (org_id, account_id, role, status, event_version)
         VALUES ($1, $2, 'member', 'removed', 3)`,
        [orgId, accountId]
      )
    ).toBe(CHECK_VIOLATION);
    await writer.query(
      `INSERT INTO uts.org_memberships (org_id, account_id, role, status, removed_at, event_version)
       VALUES ($1, $2, 'member', 'removed', now(), 3)`,
      [orgId, accountId]
    );
  });
});

describe('gate pass binding', () => {
  function insertPat(owner: string, gatePassId: string) {
    return writer.query(
      `INSERT INTO uts.personal_access_tokens
         (account_id, name, token_hash, last_four, audience, scope, gate_pass_id, expires_at)
       VALUES ($1, 'ci', $2, 'abcd', 'gateway', 'gateway:models.read', $3, now() + interval '90 days')`,
      [owner, randomHash(), gatePassId]
    );
  }

  it('let a pass create one credential of its own account and action', async () => {
    const gatePassId = await insertGatePass(writer, accountId, 'pat_create');
    await insertPat(accountId, gatePassId);
    expect(await sqlStateOf(() => insertPat(accountId, gatePassId))).toBe(UNIQUE_VIOLATION);
  });

  it('refuse a pass of another account or another action', async () => {
    const otherAccountId = await insertAccount(writer);
    expect(
      await sqlStateOf(async () =>
        insertPat(accountId, await insertGatePass(writer, otherAccountId, 'pat_create'))
      )
    ).toBe(FOREIGN_KEY_VIOLATION);
    expect(
      await sqlStateOf(async () =>
        insertPat(accountId, await insertGatePass(writer, accountId, 'bot_key_create'))
      )
    ).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('bind a bot key pass to the member who creates the key', async () => {
    const otherAccountId = await insertAccount(writer);
    const insertBotKey = (creator: string, gatePassId: string) =>
      writer.query(
        `INSERT INTO uts.org_bot_keys
           (org_id, created_by, name, token_hash, last_four, audience, scope, gate_pass_id, expires_at)
         VALUES (gen_random_uuid(), $1, 'bot', $2, 'wxyz', 'gateway', 'gateway:models.read', $3,
                 now() + interval '90 days')`,
        [creator, randomHash(), gatePassId]
      );
    const gatePassId = await insertGatePass(writer, accountId, 'bot_key_create');
    expect(await sqlStateOf(() => insertBotKey(otherAccountId, gatePassId))).toBe(
      FOREIGN_KEY_VIOLATION
    );
    await insertBotKey(accountId, gatePassId);
  });

  const insertBotKeyFor = (creator: string, orgId: string, gatePassId: string) =>
    writer.query<{ id: string }>(
      `INSERT INTO uts.org_bot_keys
         (org_id, created_by, name, token_hash, last_four, audience, scope, gate_pass_id, expires_at)
       VALUES ($1, $2, 'bot', $3, 'wxyz', 'gateway', 'gateway:models.read', $4,
               now() + interval '90 days')
       RETURNING id`,
      [orgId, creator, randomHash(), gatePassId]
    );

  it('flag the bot keys of a deleted creator account and keep the creator as history', async () => {
    const creatorId = await insertAccount(writer);
    const orgId = crypto.randomUUID();
    const gatePassId = await insertGatePass(writer, creatorId, 'bot_key_create');
    const active = await insertBotKeyFor(creatorId, orgId, gatePassId);
    const revoked = await insertBotKeyFor(
      creatorId,
      orgId,
      await insertGatePass(writer, creatorId, 'bot_key_create')
    );
    await writer.query(
      `UPDATE uts.org_bot_keys SET status = 'revoked', revoked_at = now(), revoked_by = created_by
       WHERE id = $1`,
      [revoked.rows[0].id]
    );
    // The creator also holds a PAT, which goes with the account.
    await writer.query(
      `INSERT INTO uts.personal_access_tokens
         (account_id, name, token_hash, last_four, audience, scope, gate_pass_id, expires_at)
       VALUES ($1, 'ci', $2, 'abcd', 'gateway', 'gateway:models.read', $3, now() + interval '90 days')`,
      [creatorId, randomHash(), await insertGatePass(writer, creatorId, 'pat_create')]
    );

    await writer.query('DELETE FROM uts.accounts WHERE id = $1', [creatorId]);

    const keys = await writer.query(
      `SELECT id, org_id, created_by, gate_pass_id, status, flagged_at IS NOT NULL AS flagged
       FROM uts.org_bot_keys WHERE id = ANY ($1::uuid[])`,
      [[active.rows[0].id, revoked.rows[0].id]]
    );
    const common = { org_id: orgId, created_by: creatorId, gate_pass_id: null };
    expect(keys.rows).toEqual(
      expect.arrayContaining([
        { id: active.rows[0].id, ...common, status: 'flagged', flagged: true },
        { id: revoked.rows[0].id, ...common, status: 'revoked', flagged: false },
      ])
    );
    expect(keys.rows).toHaveLength(2);
    const passes = await writer.query('SELECT 1 FROM uts.gate_passes WHERE account_id = $1', [
      creatorId,
    ]);
    expect(passes.rowCount).toBe(0);
    const pats = await writer.query(
      'SELECT 1 FROM uts.personal_access_tokens WHERE account_id = $1',
      [creatorId]
    );
    expect(pats.rowCount).toBe(0);

    // The deleted pass cannot create another key.
    expect(await sqlStateOf(() => insertBotKeyFor(creatorId, orgId, gatePassId))).toBe(
      FOREIGN_KEY_VIOLATION
    );
  });

  it('refuse a new bot key without a gate pass, even one inserted as flagged', async () => {
    const insert = (status: string) =>
      writer.query(
        `INSERT INTO uts.org_bot_keys
           (org_id, created_by, name, token_hash, last_four, audience, scope, expires_at, status,
            flagged_at)
         VALUES (gen_random_uuid(), $1, 'bot', $2, 'wxyz', 'gateway', 'gateway:models.read',
                 now() + interval '90 days', $3,
                 CASE WHEN $3::uts.bot_key_status = 'flagged' THEN now() END)`,
        [accountId, randomHash(), status]
      );
    expect(await sqlStateOf(() => insert('active'))).toBe(NOT_NULL_VIOLATION);
    expect(await sqlStateOf(() => insert('flagged'))).toBe(NOT_NULL_VIOLATION);
  });

  it('refuse a bot key gate pass action of another kind', async () => {
    expect(
      await sqlStateOf(async () =>
        writer.query(
          `INSERT INTO uts.org_bot_keys
             (org_id, created_by, gate_pass_id, gate_pass_action, name, token_hash, last_four,
              audience, scope, expires_at)
           VALUES (gen_random_uuid(), $1, $2, 'pat_create', 'bot', $3, 'wxyz', 'gateway',
                   'gateway:models.read', now() + interval '90 days')`,
          [accountId, await insertGatePass(writer, accountId, 'bot_key_create'), randomHash()]
        )
      )
    ).toBe(CHECK_VIOLATION);
  });

  it('refuse a pass delete that would leave an active bot key without its pass', async () => {
    const gatePassId = await insertGatePass(writer, accountId, 'bot_key_create');
    const key = await insertBotKeyFor(accountId, crypto.randomUUID(), gatePassId);
    const deletePass = () =>
      writer.query('DELETE FROM uts.gate_passes WHERE id = $1', [gatePassId]);
    expect(await sqlStateOf(deletePass)).toBe(CHECK_VIOLATION);

    await writer.query(
      `UPDATE uts.org_bot_keys SET status = 'flagged', flagged_at = now() WHERE id = $1`,
      [key.rows[0].id]
    );
    await deletePass();
    const after = await writer.query('SELECT gate_pass_id FROM uts.org_bot_keys WHERE id = $1', [
      key.rows[0].id,
    ]);
    expect(after.rows).toEqual([{ gate_pass_id: null }]);
  });

  it('bind a device approval to the approving account and one code', async () => {
    const approve = (approver: string, gatePassId: string) =>
      writer.query(
        `INSERT INTO uts.device_codes
           (device_code_hash, user_code_hash, client_id, scopes, expires_at, status, account_id,
            gate_pass_id, approved_at)
         VALUES ($1, $2, 'kilo-cli', '{gateway:models.read}', now() + interval '10 minutes',
                 'approved', $3, $4, now())`,
        [randomHash(), randomHash(), approver, gatePassId]
      );
    const otherAccountId = await insertAccount(writer);
    const gatePassId = await insertGatePass(writer, accountId, 'device_approve');
    expect(await sqlStateOf(() => approve(otherAccountId, gatePassId))).toBe(FOREIGN_KEY_VIOLATION);
    await approve(accountId, gatePassId);
    expect(await sqlStateOf(() => approve(accountId, gatePassId))).toBe(UNIQUE_VIOLATION);
  });

  it('refuse a consent made with a pass for a PAT', async () => {
    const clientId = `https://client.example.com/${crypto.randomUUID()}`;
    await writer.query(
      `INSERT INTO uts.third_party_clients
         (client_id, client_name, redirect_uris, document, fetched_at, cache_expires_at)
       VALUES ($1, 'Example', '{https://client.example.com/callback}', '{}', now(), now() + interval '1 hour')`,
      [clientId]
    );
    expect(
      await sqlStateOf(async () =>
        writer.query(
          `INSERT INTO uts.third_party_consents (account_id, client_id, scopes, gate_pass_id)
           VALUES ($1, $2, '{mcp:tools.read}', $3)`,
          [accountId, clientId, await insertGatePass(writer, accountId, 'pat_create')]
        )
      )
    ).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('refuse a gate pass action that the caller sets', async () => {
    expect(
      await sqlStateOf(async () =>
        writer.query(
          `INSERT INTO uts.personal_access_tokens
             (account_id, name, token_hash, last_four, audience, scope, gate_pass_id,
              gate_pass_action, expires_at)
           VALUES ($1, 'ci', $2, 'abcd', 'gateway', 'gateway:models.read', $3, 'bot_key_create',
                   now() + interval '90 days')`,
          [accountId, randomHash(), await insertGatePass(writer, accountId, 'bot_key_create')]
        )
      )
    ).toBe(GENERATED_ALWAYS);
  });
});

describe('refresh grants', () => {
  it('leave 10 percent of each page free for last-use updates', async () => {
    const result = await writer.query<{ reloptions: string[] }>(
      `SELECT reloptions FROM pg_class WHERE oid = 'uts.refresh_grants'::regclass`
    );
    expect(result.rows[0].reloptions).toEqual(['fillfactor=90']);
  });
});
