/**
 * Behaviour of the credential row that holds the caller's rig identity.
 *
 * `storeCredential` is reachable from the connect flows, while the rig
 * handle and the org proof are only written by a flow that established
 * the org with DoltHub. These tests pin the split: an explicit handle
 * wins, an omitted handle survives only through a credential that still
 * proves the same org, and a handle on its own proves nothing.
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
      provenOrg: 'alice',
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

  it('drops a handle that no verified flow backed when credentials are re-stored for the same org', () => {
    const sql = freshSql();
    // The shape older rows have: a handle written without a proof.
    storeCredential(sql, WASTELAND_ID, USER_ID, {
      encryptedToken: 'enc-1',
      dolthubOrg: 'alice',
      rigHandle: 'legacy-rig',
    });

    const restored = storeCredential(sql, WASTELAND_ID, USER_ID, {
      encryptedToken: 'enc-2',
      dolthubOrg: 'alice',
    });

    expect(restored.rig_handle).toBeNull();
    const row = getCredential(sql, WASTELAND_ID, USER_ID);
    expect(row?.encrypted_token).toBe('enc-2');
    expect(row?.rig_handle).toBeNull();
    expect(row?.proven_org).toBeNull();
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

  it('proves an org only through a recorded proof for that org', () => {
    const sql = freshSql();

    expect(credentialProvesOrg(getCredential(sql, WASTELAND_ID, USER_ID), 'alice')).toBe(false);

    // A handle without a proof — the shape older rows have — proves
    // nothing, because no flow established that org with DoltHub.
    storeCredential(sql, WASTELAND_ID, USER_ID, {
      encryptedToken: 'enc-1',
      dolthubOrg: 'alice',
      rigHandle: 'legacy-rig',
    });
    expect(credentialProvesOrg(getCredential(sql, WASTELAND_ID, USER_ID), 'alice')).toBe(false);

    storeCredential(sql, WASTELAND_ID, USER_ID, {
      encryptedToken: 'enc-1',
      dolthubOrg: 'alice',
      rigHandle: 'alice-rig',
      provenOrg: 'alice',
    });
    const verified = getCredential(sql, WASTELAND_ID, USER_ID);
    expect(verified?.proven_org).toBe('alice');
    expect(credentialProvesOrg(verified, 'Alice')).toBe(true);
    expect(credentialProvesOrg(verified, 'other-org')).toBe(false);
  });

  it('drops the recorded proof when credentials are re-stored for another org', () => {
    const sql = freshSql();
    storeCredential(sql, WASTELAND_ID, USER_ID, {
      encryptedToken: 'enc-1',
      dolthubOrg: 'alice',
      rigHandle: 'alice-rig',
      provenOrg: 'alice',
    });

    const restored = storeCredential(sql, WASTELAND_ID, USER_ID, {
      encryptedToken: 'enc-2',
      dolthubOrg: 'other-org',
    });

    expect(restored.proven_org).toBeNull();
    expect(credentialProvesOrg(getCredential(sql, WASTELAND_ID, USER_ID), 'alice')).toBe(false);
  });

  it('keeps the recorded proof when credentials are re-stored for the same org', () => {
    const sql = freshSql();
    storeCredential(sql, WASTELAND_ID, USER_ID, {
      encryptedToken: 'enc-1',
      dolthubOrg: 'alice',
      rigHandle: 'alice-rig',
      provenOrg: 'alice',
    });

    storeCredential(sql, WASTELAND_ID, USER_ID, {
      encryptedToken: 'enc-2',
      dolthubOrg: 'Alice',
    });

    expect(credentialProvesOrg(getCredential(sql, WASTELAND_ID, USER_ID), 'alice')).toBe(true);
  });
});
