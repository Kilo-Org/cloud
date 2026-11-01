/**
 * Behaviour of the credential a wasteland join persists.
 *
 * The row is one unit: the ciphertext it holds belongs to the
 * `dolthub_org` recorded beside it. These tests drive the real credential
 * store on SQLite and the real encryption helpers, so a scenario is a
 * stored row rather than a mock call.
 */

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import {
  getCredential,
  initializeDatabase,
  storeCredential,
  type WastelandCredentialResult,
} from '../dos/wasteland/credentials';
import { decryptToken, deriveEncryptionKey, encryptToken } from '../util/crypto.util';
import { persistJoinCredential, type JoinCredentialContext } from './persist-credential';

const WASTELAND_ID = 'wasteland-1';
const USER_ID = 'user-1';
const ENCRYPTION_KEY = 'join-credential-test-key';

function makeSql(): SqlStorage {
  const db = new DatabaseSync(':memory:');
  const shim = {
    exec(statement: string, ...params: unknown[]) {
      const prepared = db.prepare(statement);
      if (/^\s*(select|pragma)/i.test(statement)) {
        return prepared.all(...(params as never[]));
      }
      prepared.run(...(params as never[]));
      return [];
    },
  };
  return shim as unknown as SqlStorage;
}

type Harness = {
  sql: SqlStorage;
  env: Pick<Env, 'WASTELAND_ENCRYPTION_KEY'>;
  makeContext: (input: {
    forkOrg: string;
    token: string;
    tokenSource: 'oauth' | 'stored';
  }) => JoinCredentialContext;
  seed: (input: {
    token: string;
    org: string;
    rigHandle: string;
    provenOrg?: string;
    isUpstreamAdmin?: boolean;
  }) => Promise<WastelandCredentialResult>;
  decryptStoredToken: () => Promise<string>;
};

function makeHarness(input: { withKey?: boolean } = {}): Harness {
  const sql = makeSql();
  initializeDatabase(sql);
  const env = {
    WASTELAND_ENCRYPTION_KEY: input.withKey === false ? undefined : ENCRYPTION_KEY,
  } as unknown as Pick<Env, 'WASTELAND_ENCRYPTION_KEY'>;

  async function encrypt(token: string): Promise<string> {
    const cryptoKey = await deriveEncryptionKey(ENCRYPTION_KEY);
    return encryptToken(token, cryptoKey);
  }

  return {
    sql,
    env,
    makeContext: ({ forkOrg, token, tokenSource }) => ({
      doStub: {
        getCredential: async userId => getCredential(sql, WASTELAND_ID, userId),
        storeCredential: async credentialInput =>
          storeCredential(sql, WASTELAND_ID, credentialInput.userId, credentialInput),
      },
      upstream: 'hop/wl',
      forkOrg,
      token,
      tokenSource,
    }),
    seed: async seedInput =>
      storeCredential(sql, WASTELAND_ID, USER_ID, {
        encryptedToken: await encrypt(seedInput.token),
        dolthubOrg: seedInput.org,
        rigHandle: seedInput.rigHandle,
        provenOrg: seedInput.provenOrg,
        isUpstreamAdmin: seedInput.isUpstreamAdmin,
      }),
    decryptStoredToken: async () => {
      const row = getCredential(sql, WASTELAND_ID, USER_ID);
      if (row === null) throw new Error('no credential stored');
      return decryptToken(row.encrypted_token, await deriveEncryptionKey(ENCRYPTION_KEY));
    },
  };
}

describe('persistJoinCredential', () => {
  it('stores the joining account token together with its org', async () => {
    const harness = makeHarness();
    const previous = await harness.seed({
      token: 'account-a-token',
      org: 'alice',
      rigHandle: 'alice-rig',
      provenOrg: 'alice',
      isUpstreamAdmin: true,
    });

    await persistJoinCredential(
      harness.env,
      harness.makeContext({ forkOrg: 'bob', token: 'account-b-token', tokenSource: 'oauth' }),
      USER_ID,
      'bob-rig'
    );

    const row = getCredential(harness.sql, WASTELAND_ID, USER_ID);
    expect(row).not.toBeNull();
    expect(row?.dolthub_org).toBe('bob');
    expect(row?.rig_handle).toBe('bob-rig');
    expect(row?.proven_org).toBe('bob');
    expect(row?.is_upstream_admin).toBe(true);
    expect(row?.encrypted_token).not.toBe(previous.encrypted_token);
    expect(await harness.decryptStoredToken()).toBe('account-b-token');
  });

  it('keeps the stored ciphertext while the row already names the org', async () => {
    const harness = makeHarness();
    const previous = await harness.seed({
      token: 'account-a-token',
      org: 'Alice',
      rigHandle: 'alice-rig',
      provenOrg: 'Alice',
    });

    await persistJoinCredential(
      harness.env,
      harness.makeContext({ forkOrg: 'alice', token: 'refreshed-token', tokenSource: 'oauth' }),
      USER_ID,
      'alice-rig'
    );

    const row = getCredential(harness.sql, WASTELAND_ID, USER_ID);
    expect(row?.dolthub_org).toBe('Alice');
    expect(row?.encrypted_token).toBe(previous.encrypted_token);
    expect(await harness.decryptStoredToken()).toBe('account-a-token');
  });

  it('leaves the stored org alone when the join ran on the stored token', async () => {
    const harness = makeHarness();
    const previous = await harness.seed({
      token: 'account-a-token',
      org: 'alice',
      rigHandle: 'alice-rig',
      provenOrg: 'alice',
    });

    await persistJoinCredential(
      harness.env,
      harness.makeContext({ forkOrg: 'alice', token: 'account-a-token', tokenSource: 'stored' }),
      USER_ID,
      'rejoined-rig'
    );

    const row = getCredential(harness.sql, WASTELAND_ID, USER_ID);
    expect(row?.dolthub_org).toBe('alice');
    expect(row?.rig_handle).toBe('rejoined-rig');
    expect(row?.encrypted_token).toBe(previous.encrypted_token);
    expect(await harness.decryptStoredToken()).toBe('account-a-token');
  });

  it('leaves the row untouched when a new org cannot be encrypted', async () => {
    const harness = makeHarness({ withKey: false });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await harness.seed({
      token: 'account-a-token',
      org: 'alice',
      rigHandle: 'alice-rig',
      provenOrg: 'alice',
    });

    await persistJoinCredential(
      harness.env,
      harness.makeContext({ forkOrg: 'bob', token: 'account-b-token', tokenSource: 'oauth' }),
      USER_ID,
      'bob-rig'
    );

    const row = getCredential(harness.sql, WASTELAND_ID, USER_ID);
    expect(row?.dolthub_org).toBe('alice');
    expect(row?.rig_handle).toBe('alice-rig');
    expect(await harness.decryptStoredToken()).toBe('account-a-token');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('stores the joining token when no credential existed yet', async () => {
    const harness = makeHarness();

    await persistJoinCredential(
      harness.env,
      harness.makeContext({ forkOrg: 'bob', token: 'account-b-token', tokenSource: 'oauth' }),
      USER_ID,
      'bob-rig'
    );

    const row = getCredential(harness.sql, WASTELAND_ID, USER_ID);
    expect(row?.dolthub_org).toBe('bob');
    expect(row?.rig_handle).toBe('bob-rig');
    expect(row?.proven_org).toBe('bob');
    expect(await harness.decryptStoredToken()).toBe('account-b-token');
  });
});
