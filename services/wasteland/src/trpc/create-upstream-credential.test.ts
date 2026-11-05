/**
 * The credential `createUpstream` records once its bootstrap has run.
 *
 * The bootstrap itself is mocked at its module boundary: what this file
 * pins is the credential decision that runs before it, including the
 * `INTERNAL_SERVER_ERROR` a call returns when the row it would write
 * cannot be encrypted.
 */

import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCredential, initializeDatabase, storeCredential } from '../dos/wasteland/credentials';
import { decryptToken, deriveEncryptionKey, encryptToken } from '../util/crypto.util';
import { wastelandRouter } from './router';

const bootstrap = vi.hoisted(() => ({
  createUpstream: vi.fn(async () => ({ databaseCreated: true, upstreamOwner: 'bob' })),
}));

vi.mock('../upstream-bootstrap/create-upstream', () => ({
  createUpstream: bootstrap.createUpstream,
}));

const WASTELAND_ID = '4f1a3f2e-8f0b-4a3f-9d1e-4b6c8a2d7e10';
const USER_ID = 'user-1';
const ENCRYPTION_KEY = 'create-upstream-credential-test-key';

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

async function encrypt(token: string): Promise<string> {
  return encryptToken(token, await deriveEncryptionKey(ENCRYPTION_KEY));
}

async function decryptStored(sql: SqlStorage): Promise<string> {
  const row = getCredential(sql, WASTELAND_ID, USER_ID);
  if (row === null) throw new Error('no credential stored');
  return decryptToken(row.encrypted_token, await deriveEncryptionKey(ENCRYPTION_KEY));
}

function makeEnv(input: { sql: SqlStorage; withKey?: boolean; tokenResponse?: unknown }) {
  const { sql } = input;
  let config = {
    wasteland_id: WASTELAND_ID,
    name: 'Harness',
    owner_type: 'user' as const,
    owner_user_id: USER_ID,
    organization_id: null,
    dolthub_upstream: null,
    visibility: 'public' as const,
    status: 'active' as const,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };

  const stub = {
    getConfig: async () => config,
    updateConfig: async (patch: Record<string, unknown>) => {
      config = { ...config, ...patch };
      return config;
    },
    getCredential: async (userId: string) => getCredential(sql, WASTELAND_ID, userId),
    storeCredential: async (credentialInput: {
      userId: string;
      encryptedToken: string;
      dolthubOrg: string;
      rigHandle?: string;
      provenOrg?: string;
      isUpstreamAdmin?: boolean;
    }) => storeCredential(sql, WASTELAND_ID, credentialInput.userId, credentialInput),
  };

  const env = {
    WASTELAND: { idFromName: (name: string) => name, get: () => stub },
    WASTELAND_REGISTRY: {
      idFromName: (name: string) => name,
      get: () => ({ setDolthubUpstream: async () => undefined }),
    },
    WASTELAND_ENCRYPTION_KEY: input.withKey === false ? undefined : ENCRYPTION_KEY,
    INTERNAL_API_SECRET: 'test-internal-secret',
    KILO_INTERNAL_API_URL: 'http://localhost:3000',
  };

  vi.stubGlobal('fetch', async () =>
    Response.json(input.tokenResponse ?? { token: 'account-b-token', dolthubUsername: 'bob' })
  );

  return env as unknown as Env;
}

function makeCaller(env: Env) {
  return wastelandRouter.createCaller({
    env,
    userId: USER_ID,
    isAdmin: false,
    apiTokenPepper: null,
    orgMemberships: [],
  });
}

function makeWasteland(): { sql: SqlStorage; seed: () => Promise<string> } {
  const sql = makeSql();
  initializeDatabase(sql);
  return {
    sql,
    seed: async () => {
      const encryptedToken = await encrypt('account-a-token');
      return storeCredential(sql, WASTELAND_ID, USER_ID, {
        encryptedToken,
        dolthubOrg: 'alice',
        rigHandle: 'alice-rig',
        provenOrg: 'alice',
        isUpstreamAdmin: true,
      }).encrypted_token;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  bootstrap.createUpstream.mockClear();
});

describe('createUpstream credential', () => {
  it('records the token the bootstrap used under the org it acted for', async () => {
    const wasteland = makeWasteland();
    const previous = await wasteland.seed();
    const env = makeEnv({ sql: wasteland.sql });

    const result = await makeCaller(env).createUpstream({
      wastelandId: WASTELAND_ID,
      upstream: 'bob/new-wl',
      rigHandle: 'bob-rig',
    });

    expect(result).toEqual({ success: true, databaseCreated: true });
    const row = getCredential(wasteland.sql, WASTELAND_ID, USER_ID);
    expect(row?.dolthub_org).toBe('bob');
    expect(row?.proven_org).toBe('bob');
    expect(row?.rig_handle).toBe('bob-rig');
    expect(row?.is_upstream_admin).toBe(true);
    expect(row?.encrypted_token).not.toBe(previous);
    expect(await decryptStored(wasteland.sql)).toBe('account-b-token');
  });

  it('keeps the stored ciphertext while the row names the org it acts for', async () => {
    const wasteland = makeWasteland();
    await wasteland.seed();
    const env = makeEnv({
      sql: wasteland.sql,
      withKey: false,
      tokenResponse: { token: 'refreshed-token', dolthubUsername: 'ALICE' },
    });

    await makeCaller(env).createUpstream({
      wastelandId: WASTELAND_ID,
      upstream: 'alice/new-wl',
    });

    const row = getCredential(wasteland.sql, WASTELAND_ID, USER_ID);
    expect(row?.dolthub_org).toBe('alice');
    expect(await decryptStored(wasteland.sql)).toBe('account-a-token');
  });

  it('stops before the bootstrap when it cannot encrypt for the org it acts for', async () => {
    const wasteland = makeWasteland();
    await wasteland.seed();
    const env = makeEnv({ sql: wasteland.sql, withKey: false });

    await expect(
      makeCaller(env).createUpstream({ wastelandId: WASTELAND_ID, upstream: 'bob/new-wl' })
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Encryption key unavailable',
    });

    expect(bootstrap.createUpstream).not.toHaveBeenCalled();
    const row = getCredential(wasteland.sql, WASTELAND_ID, USER_ID);
    expect(row?.dolthub_org).toBe('alice');
    expect(await decryptStored(wasteland.sql)).toBe('account-a-token');
  });
});
