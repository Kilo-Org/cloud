import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AuditEventSchema } from '@kilocode/sts-contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AttestationStore,
  type ClaimInput,
  identityStoreAttestations,
} from '../../src/attest/store';
import { IdentityStore, IdentityStoreError } from '../../src/db/client';
import { type GrantStore, identityStoreGrants } from '../../src/grants/store';
import { TestDatabase, insertAccount, sqlStateOf } from './harness';

/** The SQLSTATE a statement through the Worker's store fails with. */
async function storeStateOf(work: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await work();
  } catch (error) {
    if (error instanceof IdentityStoreError) return error.sqlState;
    throw error;
  }
  throw new Error('expected the statement to fail');
}

/**
 * The attestation statements (migration 0017) through the Worker's own statements
 * (`src/attest/store.ts`), as the app login: the claim checks the code against the request before
 * any verification, one request verifies a code at a time, a late settle changes nothing, App
 * Attest counters only grow, a refusal kills the code and writes one audit row, and an attested
 * code exchanges and re-exchanges without a second verification.
 */

let db: TestDatabase;
let owner: pg.Client;
let app: pg.Client;
let grants: GrantStore;
let attestations: AttestationStore;

beforeAll(async () => {
  db = await TestDatabase.create();
  owner = await db.connectAsOwner();
  app = await db.connect('uts_app_a');
  grants = identityStoreGrants(new IdentityStore(app));
  attestations = identityStoreAttestations(new IdentityStore(app));
});
afterAll(() => db.drop());

const environment = 'development';
const REDIRECT = 'com.kilocode.kiloapp:/oauth/callback';
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest();
const token = () => randomBytes(32).toString('base64url');

type MobileCode = {
  accountId: string;
  code: string;
  codeHash: Buffer;
  verifier: string;
  challenge: string;
  jkt: Buffer;
};

async function mobileCode(): Promise<MobileCode> {
  const accountId = await insertAccount(owner);
  const code = token();
  const verifier = token();
  const challenge = sha256(verifier).toString('base64url');
  const jkt = randomBytes(32);
  const issued = await grants.issueCode({
    environment,
    codeHash: sha256(code),
    client: { kind: 'first_party', clientId: 'kilo-mobile', dpopJkt: jkt },
    accountId,
    browserSessionId: null,
    redirectUri: REDIRECT,
    audiences: ['notifications'],
    scopes: ['notifications:badges.read'],
    orgId: null,
    codeChallenge: challenge,
    authTime: new Date(),
    amr: ['passkey'],
  });
  expect(issued).toMatchObject({ outcome: 'issued' });
  return { accountId, code, codeHash: sha256(code), verifier, challenge, jkt };
}

function claim(
  fixture: MobileCode,
  proof: ClaimInput['proof'],
  overrides: Partial<ClaimInput> = {}
) {
  return attestations.claim({
    codeHash: fixture.codeHash,
    clientId: 'kilo-mobile',
    redirectUri: REDIRECT,
    codeChallenge: fixture.challenge,
    dpopJkt: fixture.jkt,
    claimId: randomUUID(),
    proof,
    ...overrides,
  });
}

function exchange(fixture: MobileCode, grantId: string, refreshHash: Buffer) {
  return grants.exchangeCode({
    environment,
    codeHash: fixture.codeHash,
    clientId: 'kilo-mobile',
    redirectUri: REDIRECT,
    codeChallenge: fixture.challenge,
    binding: {
      kind: 'first_party',
      proof: { jkt: fixture.jkt, jti: randomUUID() },
      clientClass: 'mobile',
      device: {
        label: 'Kilo mobile app',
        platform: 'ios',
        clientIp: null,
        asn: null,
        country: null,
        city: null,
      },
    },
    grantId,
    refreshTokenHash: refreshHash,
    scopes: null,
    resources: null,
  });
}

/** A P-256 point and its App Attest key id. */
function appAttestKey() {
  const point = Buffer.concat([Buffer.from([4]), randomBytes(64)]);
  return { point, keyId: sha256(point) };
}

async function claimAs(fixture: MobileCode, proof: ClaimInput['proof']) {
  const claimId = randomUUID();
  const result = await claim(fixture, proof, { claimId });
  return { claimId, result };
}

describe('claim_code_attestation', () => {
  it('checks the code against the request before claiming anything', async () => {
    const fixture = await mobileCode();
    const play = { type: 'play_integrity' as const, keyId: null };
    expect(await claim(fixture, play, { codeHash: sha256(token()) })).toEqual({
      outcome: 'invalid_grant',
    });
    expect(
      await claim(fixture, play, { codeChallenge: sha256(token()).toString('base64url') })
    ).toEqual({
      outcome: 'invalid_grant',
    });
    expect(await claim(fixture, play, { dpopJkt: randomBytes(32) })).toEqual({
      outcome: 'invalid_grant',
    });
    expect(await claim(fixture, play, { redirectUri: 'com.kilocode.kiloapp:/other' })).toEqual({
      outcome: 'invalid_grant',
    });
    expect(await claim(fixture, play, { clientId: 'kilo-cli' })).toEqual({
      outcome: 'invalid_grant',
    });
    const rows = await owner.query('SELECT 1 FROM uts.code_attestations WHERE code_hash = $1', [
      fixture.codeHash,
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it('refuses an expired code', async () => {
    const fixture = await mobileCode();
    await owner.query(
      `UPDATE uts.authorization_codes SET created_at = now() - interval '2 minutes',
         expires_at = now() - interval '1 minute' WHERE code_hash = $1`,
      [fixture.codeHash]
    );
    expect(await claim(fixture, { type: 'play_integrity', keyId: null })).toEqual({
      outcome: 'invalid_grant',
    });
  });

  it('asks for a proof when none is sent and the code has none', async () => {
    expect(await claim(await mobileCode(), null)).toEqual({ outcome: 'proof_required' });
  });

  it('lets one request verify a code at a time, and takes over a claim older than 15 seconds', async () => {
    const fixture = await mobileCode();
    const first = await claimAs(fixture, { type: 'play_integrity', keyId: null });
    expect(first.result).toEqual({ outcome: 'claimed', storedKey: null });
    expect(await claim(fixture, { type: 'play_integrity', keyId: null })).toEqual({
      outcome: 'busy',
    });
    expect(await claim(fixture, null)).toEqual({ outcome: 'busy' });

    await owner.query(
      `UPDATE uts.code_attestations SET claimed_at = now() - interval '16 seconds' WHERE code_hash = $1`,
      [fixture.codeHash]
    );
    const second = await claimAs(fixture, { type: 'play_integrity', keyId: null });
    expect(second.result).toEqual({ outcome: 'claimed', storedKey: null });
    // The first verification ends late: its result changes nothing.
    expect(
      await attestations.settle({
        environment,
        codeHash: fixture.codeHash,
        claimId: first.claimId,
        result: { kind: 'attested', publicKey: null, signCount: null },
      })
    ).toBe('stale');
    expect(
      await attestations.settle({
        environment,
        codeHash: fixture.codeHash,
        claimId: second.claimId,
        result: { kind: 'attested', publicKey: null, signCount: null },
      })
    ).toBe('attested');
  });

  it('answers unknown_key for an assertion of a key it does not hold, and claims nothing', async () => {
    const fixture = await mobileCode();
    const { keyId } = appAttestKey();
    expect(await claim(fixture, { type: 'app_attest_assertion', keyId })).toEqual({
      outcome: 'unknown_key',
    });
    expect(await claim(fixture, null)).toEqual({ outcome: 'proof_required' });
  });

  it('refuses inputs that do not fit the attestation type', async () => {
    const fixture = await mobileCode();
    expect(
      await storeStateOf(() => claim(fixture, { type: 'play_integrity', keyId: randomBytes(32) }))
    ).toBe('22004');
    expect(await storeStateOf(() => claim(fixture, { type: 'app_attest_key', keyId: null }))).toBe(
      '22004'
    );
  });
});

describe('settle_code_attestation', () => {
  it('stores a new App Attest key, then accepts only growing assertion counters', async () => {
    const { point, keyId } = appAttestKey();
    const attested = await mobileCode();
    const keyClaim = await claimAs(attested, { type: 'app_attest_key', keyId });
    expect(
      await attestations.settle({
        environment,
        codeHash: attested.codeHash,
        claimId: keyClaim.claimId,
        result: { kind: 'attested', publicKey: point, signCount: null },
      })
    ).toBe('attested');

    const assertWith = async (signCount: number) => {
      const fixture = await mobileCode();
      const claimed = await claimAs(fixture, { type: 'app_attest_assertion', keyId });
      if (claimed.result.outcome !== 'claimed') throw new Error(claimed.result.outcome);
      const settled = await attestations.settle({
        environment,
        codeHash: fixture.codeHash,
        claimId: claimed.claimId,
        result: { kind: 'attested', publicKey: null, signCount },
      });
      return { stored: claimed.result.storedKey, settled, fixture };
    };
    const first = await assertWith(1);
    expect(first.stored?.signCount).toBe(0);
    expect(Buffer.from(first.stored?.publicKey ?? [])).toEqual(point);
    expect(first.settled).toBe('attested');
    expect((await assertWith(5)).settled).toBe('attested');
    const replayed = await assertWith(5);
    expect(replayed.settled).toBe('refused');
    expect((await assertWith(3)).settled).toBe('refused');
    expect(await claim(replayed.fixture, null)).toEqual({ outcome: 'refused' });

    // A lost answer: the app attests the stored key again for another code. The code stays
    // usable, and an assertion of the key then attests it.
    const again = await mobileCode();
    const againClaim = await claimAs(again, { type: 'app_attest_key', keyId });
    expect(
      await attestations.settle({
        environment,
        codeHash: again.codeHash,
        claimId: againClaim.claimId,
        result: { kind: 'attested', publicKey: point, signCount: null },
      })
    ).toBe('key_known');
    const retried = await claimAs(again, { type: 'app_attest_assertion', keyId });
    expect(retried.result).toEqual({
      outcome: 'claimed',
      storedKey: { publicKey: expect.anything(), signCount: 5 },
    });
    expect(
      await attestations.settle({
        environment,
        codeHash: again.codeHash,
        claimId: retried.claimId,
        result: { kind: 'attested', publicKey: null, signCount: 6 },
      })
    ).toBe('attested');
    const denied = await owner.query(
      `SELECT 1 FROM uts.audit_events
       WHERE account_id = $1 AND event_type = 'ai.kilo.uts.token.denied'`,
      [again.accountId]
    );
    expect(denied.rowCount).toBe(0);
  });

  it('refuses a key whose id is not the SHA-256 of its point', async () => {
    const fixture = await mobileCode();
    const { point } = appAttestKey();
    const claimed = await claimAs(fixture, { type: 'app_attest_key', keyId: randomBytes(32) });
    expect(
      await storeStateOf(() =>
        attestations.settle({
          environment,
          codeHash: fixture.codeHash,
          claimId: claimed.claimId,
          result: { kind: 'attested', publicKey: point, signCount: null },
        })
      )
    ).toBe('23514');
  });

  it('kills the code on a refusal and writes one denied audit row without credential values', async () => {
    const fixture = await mobileCode();
    const claimed = await claimAs(fixture, { type: 'play_integrity', keyId: null });
    expect(
      await attestations.settle({
        environment,
        codeHash: fixture.codeHash,
        claimId: claimed.claimId,
        result: { kind: 'refused', reason: 'package_mismatch' },
      })
    ).toBe('refused');
    expect(await claim(fixture, { type: 'play_integrity', keyId: null })).toEqual({
      outcome: 'refused',
    });
    const rows = await owner.query<{ event_type: string; event: unknown }>(
      `SELECT event_type, event FROM uts.audit_events
       WHERE account_id = $1 AND event_type <> 'ai.kilo.uts.authorization_code.issued'`,
      [fixture.accountId]
    );
    expect(rows.rows.map(row => row.event_type)).toEqual(['ai.kilo.uts.token.denied']);
    const event = AuditEventSchema.parse(rows.rows[0].event);
    expect(event.data).toMatchObject({
      outcome: 'denied',
      outcomeDetail: 'attestation refused',
      attributes: {
        grantType: 'authorization_code',
        clientId: 'kilo-mobile',
        attestationType: 'play_integrity',
        reason: 'package_mismatch',
      },
    });
    const text = JSON.stringify(rows.rows);
    for (const secret of [fixture.code, fixture.verifier, fixture.codeHash.toString('hex')]) {
      expect(text).not.toContain(secret);
    }
  });

  it('drops the claim on a release, so a retry can claim again', async () => {
    const fixture = await mobileCode();
    const claimed = await claimAs(fixture, { type: 'play_integrity', keyId: null });
    expect(
      await attestations.settle({
        environment,
        codeHash: fixture.codeHash,
        claimId: claimed.claimId,
        result: { kind: 'released' },
      })
    ).toBe('released');
    expect((await claim(fixture, { type: 'play_integrity', keyId: null })).outcome).toBe('claimed');
  });
});

describe('the exchange backstop', () => {
  it('refuses to consume an unattested kilo-mobile code', async () => {
    const fixture = await mobileCode();
    expect(await storeStateOf(() => exchange(fixture, randomUUID(), randomBytes(32)))).toBe(
      '23514'
    );
    const claimed = await claimAs(fixture, { type: 'play_integrity', keyId: null });
    expect(await storeStateOf(() => exchange(fixture, randomUUID(), randomBytes(32)))).toBe(
      '23514'
    );
    await attestations.settle({
      environment,
      codeHash: fixture.codeHash,
      claimId: claimed.claimId,
      result: { kind: 'refused', reason: 'package_mismatch' },
    });
    expect(await storeStateOf(() => exchange(fixture, randomUUID(), randomBytes(32)))).toBe(
      '23514'
    );
  });

  it('lets a code marked exempt in development through, and refuses the mark elsewhere', async () => {
    const fixture = await mobileCode();
    expect(
      await storeStateOf(() =>
        attestations.exempt({ environment: 'staging', codeHash: fixture.codeHash })
      )
    ).toBe('22004');
    expect(
      await storeStateOf(() =>
        attestations.exempt({ environment: 'production', codeHash: fixture.codeHash })
      )
    ).toBe('22004');
    await attestations.exempt({ environment, codeHash: fixture.codeHash });
    expect(await claim(fixture, null)).toEqual({ outcome: 'attested' });
    expect((await exchange(fixture, randomUUID(), randomBytes(32))).outcome).toBe('issued');
  });
});

describe('an attested code', () => {
  it('exchanges, and a retry of the same exchange needs no new attestation', async () => {
    const fixture = await mobileCode();
    const claimed = await claimAs(fixture, { type: 'play_integrity', keyId: null });
    await attestations.settle({
      environment,
      codeHash: fixture.codeHash,
      claimId: claimed.claimId,
      result: { kind: 'attested', publicKey: null, signCount: null },
    });
    const grantId = randomUUID();
    const refreshHash = randomBytes(32);
    expect((await exchange(fixture, grantId, refreshHash)).outcome).toBe('issued');
    expect(await claim(fixture, null)).toEqual({ outcome: 'attested' });
    expect(await claim(fixture, { type: 'play_integrity', keyId: null })).toEqual({
      outcome: 'attested',
    });
    expect((await exchange(fixture, grantId, refreshHash)).outcome).toBe('issued');
    // Another DPoP key with the consumed code is a reuse, for the exchange statement to decide.
    expect(await claim(fixture, null, { dpopJkt: randomBytes(32) })).toEqual({ outcome: 'reused' });
  });

  it('goes with its code when the code is deleted', async () => {
    const fixture = await mobileCode();
    await claimAs(fixture, { type: 'play_integrity', keyId: null });
    await owner.query('DELETE FROM uts.authorization_codes WHERE code_hash = $1', [
      fixture.codeHash,
    ]);
    const rows = await owner.query('SELECT 1 FROM uts.code_attestations WHERE code_hash = $1', [
      fixture.codeHash,
    ]);
    expect(rows.rowCount).toBe(0);
  });
});

describe('maintain_attestation_rows', () => {
  it('deletes App Attest keys 400 days past their last use and keeps the others', async () => {
    const stale = appAttestKey();
    const fresh = appAttestKey();
    await owner.query(
      `INSERT INTO uts.app_attest_keys (key_id, public_key, sign_count, last_used_at)
       VALUES ($1, $2, 3, now() - interval '401 days'), ($3, $4, 3, now() - interval '399 days')`,
      [stale.keyId, stale.point, fresh.keyId, fresh.point]
    );
    const result = await app.query<{ kind: string; deleted: number }>(
      'SELECT kind, deleted FROM uts.maintain_attestation_rows()'
    );
    expect(result.rows).toEqual([{ kind: 'app_attest_keys', deleted: 1 }]);
    const left = await owner.query<{ key_id: Buffer }>(
      'SELECT key_id FROM uts.app_attest_keys WHERE key_id = ANY($1)',
      [[stale.keyId, fresh.keyId]]
    );
    expect(left.rows.map(row => Buffer.from(row.key_id))).toEqual([fresh.keyId]);
  });

  it('gives the app login no direct read of either table', async () => {
    expect(await sqlStateOf(() => app.query('SELECT * FROM uts.app_attest_keys'))).toBe('42501');
    expect(await sqlStateOf(() => app.query('SELECT * FROM uts.code_attestations'))).toBe('42501');
  });
});
