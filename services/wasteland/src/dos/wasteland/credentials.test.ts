/**
 * Behaviour of the credential row that holds the caller's rig identity.
 *
 * `storeCredential` is reachable from the connect flows, while the rig
 * handle is only written by a flow that proved ownership. These tests
 * pin the split: an explicit handle wins, an omitted handle never
 * clears the stored one.
 *
 * Runs against a real SQLite database through a minimal `SqlStorage`
 * shim, because the module only uses `exec(query, ...bindings)`.
 */

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  credentialProvesOrg,
  getCredential,
  initializeDatabase,
  storeCredential,
} from './credentials';

const WASTELAND_ID = 'wasteland-1';
const USER_ID = 'user-1';

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

function freshSql(): SqlStorage {
  const sql = makeSql();
  initializeDatabase(sql);
  return sql;
}

describe('wasteland credentials', () => {
  it('stores the handle a verified flow supplies', () => {
    const sql = freshSql();

    const stored = storeCredential(sql, WASTELAND_ID, USER_ID, {
      encryptedToken: 'enc-1',
      dolthubOrg: 'alice',
      rigHandle: 'alice-rig',
    });

    expect(stored.rig_handle).toBe('alice-rig');
    expect(getCredential(sql, WASTELAND_ID, USER_ID)?.rig_handle).toBe('alice-rig');
  });

  it('keeps the stored handle when credentials are re-stored for the same org', () => {
    const sql = freshSql();
    storeCredential(sql, WASTELAND_ID, USER_ID, {
      encryptedToken: 'enc-1',
      dolthubOrg: 'alice',
      rigHandle: 'alice-rig',
    });

    const restored = storeCredential(sql, WASTELAND_ID, USER_ID, {
      encryptedToken: 'enc-2',
      dolthubOrg: 'Alice',
    });

    expect(restored.rig_handle).toBe('alice-rig');
    const row = getCredential(sql, WASTELAND_ID, USER_ID);
    expect(row?.encrypted_token).toBe('enc-2');
    expect(row?.dolthub_org).toBe('Alice');
    expect(row?.rig_handle).toBe('alice-rig');
  });

  it('drops the stored handle when credentials are re-stored for another org', () => {
    const sql = freshSql();
    storeCredential(sql, WASTELAND_ID, USER_ID, {
      encryptedToken: 'enc-1',
      dolthubOrg: 'alice',
      rigHandle: 'alice-rig',
    });

    const restored = storeCredential(sql, WASTELAND_ID, USER_ID, {
      encryptedToken: 'enc-2',
      dolthubOrg: 'other-org',
    });

    expect(restored.rig_handle).toBeNull();
    const row = getCredential(sql, WASTELAND_ID, USER_ID);
    expect(row?.dolthub_org).toBe('other-org');
    expect(row?.rig_handle).toBeNull();
  });

  it('has no handle for a credential that was never verified', () => {
    const sql = freshSql();

    const stored = storeCredential(sql, WASTELAND_ID, USER_ID, {
      encryptedToken: 'enc-1',
      dolthubOrg: 'alice',
    });

    expect(stored.rig_handle).toBeNull();
  });

  it('proves an org only through a handle recorded for that org', () => {
    const sql = freshSql();

    expect(credentialProvesOrg(getCredential(sql, WASTELAND_ID, USER_ID), 'alice')).toBe(false);

    storeCredential(sql, WASTELAND_ID, USER_ID, {
      encryptedToken: 'enc-1',
      dolthubOrg: 'alice',
    });
    expect(credentialProvesOrg(getCredential(sql, WASTELAND_ID, USER_ID), 'alice')).toBe(false);

    storeCredential(sql, WASTELAND_ID, USER_ID, {
      encryptedToken: 'enc-1',
      dolthubOrg: 'alice',
      rigHandle: 'acme-rig',
    });
    const verified = getCredential(sql, WASTELAND_ID, USER_ID);
    expect(credentialProvesOrg(verified, 'Alice')).toBe(true);
    expect(credentialProvesOrg(verified, 'other-org')).toBe(false);
  });
});
