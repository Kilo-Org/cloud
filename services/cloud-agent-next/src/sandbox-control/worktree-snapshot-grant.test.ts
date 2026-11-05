import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import {
  WORKTREE_SNAPSHOT_AUDIENCE,
  WORKTREE_SNAPSHOT_GRANT_SECONDS,
  decideWorktreeSnapshotAuthorization,
  mintWorktreeSnapshotGrant,
  purgeWorktreeSnapshot,
  validateWorktreeSnapshotGrant,
  worktreeSnapshotObjectKey,
  worktreeSnapshotReadsEnabled,
  worktreeSnapshotTombstoneKey,
  worktreeSnapshotWritesEnabled,
} from './worktree-snapshot-grant.js';

const secret = 'worktree-snapshot-test-secret';
const identity = {
  sandboxId: 'sandbox_test',
  allocationId: 'allocation_test',
  wrapperInstanceId: '0fce125c-54a3-4143-b503-b7775c4d2135',
};
const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';

describe('worktree snapshot grants', () => {
  it('round-trips the shared sandbox identity', () => {
    const token = mintWorktreeSnapshotGrant(identity, secret);
    expect(validateWorktreeSnapshotGrant(`Bearer ${token}`, secret)).toEqual(identity);
  });

  it('rejects a grant for another audience', () => {
    const token = jwt.sign({ type: 'worktree_snapshot', identity }, secret, {
      algorithm: 'HS256',
      audience: 'cloud-agent-control-log-upload',
      expiresIn: 60,
    });
    expect(validateWorktreeSnapshotGrant(`Bearer ${token}`, secret)).toBeUndefined();
  });

  it('rejects an expired grant', () => {
    const token = jwt.sign({ type: 'worktree_snapshot', identity }, secret, {
      algorithm: 'HS256',
      audience: WORKTREE_SNAPSHOT_AUDIENCE,
      expiresIn: -1,
    });
    expect(validateWorktreeSnapshotGrant(`Bearer ${token}`, secret)).toBeUndefined();
  });

  it('rejects a grant longer than the four-hour half-life contract', () => {
    const token = jwt.sign({ type: 'worktree_snapshot', identity }, secret, {
      algorithm: 'HS256',
      audience: WORKTREE_SNAPSHOT_AUDIENCE,
      expiresIn: WORKTREE_SNAPSHOT_GRANT_SECONDS + 1,
    });
    expect(validateWorktreeSnapshotGrant(`Bearer ${token}`, secret)).toBeUndefined();
  });

  it('rejects a grant issued in the future or with another type', () => {
    const now = Math.floor(Date.now() / 1000);
    const future = jwt.sign(
      {
        type: 'worktree_snapshot',
        identity,
        iat: now + 3600,
        exp: now + 3600 + WORKTREE_SNAPSHOT_GRANT_SECONDS,
      },
      secret,
      { algorithm: 'HS256', audience: WORKTREE_SNAPSHOT_AUDIENCE }
    );
    expect(validateWorktreeSnapshotGrant(`Bearer ${future}`, secret)).toBeUndefined();

    const wrongType = jwt.sign({ type: 'control_log_upload', identity }, secret, {
      algorithm: 'HS256',
      audience: WORKTREE_SNAPSHOT_AUDIENCE,
      expiresIn: 60,
    });
    expect(validateWorktreeSnapshotGrant(`Bearer ${wrongType}`, secret)).toBeUndefined();
  });

  it('rejects a malformed authorization or missing secret', () => {
    expect(validateWorktreeSnapshotGrant(null, secret)).toBeUndefined();
    expect(validateWorktreeSnapshotGrant('Bearer', secret)).toBeUndefined();
    expect(validateWorktreeSnapshotGrant('Bearer one two', secret)).toBeUndefined();
    expect(validateWorktreeSnapshotGrant(`Bearer ${'x'.repeat(4097)}`, secret)).toBeUndefined();
    expect(
      validateWorktreeSnapshotGrant(`Bearer ${mintWorktreeSnapshotGrant(identity, secret)}`, null)
    ).toBeUndefined();
  });
});

describe('worktree snapshot flags', () => {
  it('defaults both flags off', () => {
    expect(worktreeSnapshotWritesEnabled({})).toBe(false);
    expect(worktreeSnapshotReadsEnabled({})).toBe(false);
  });

  it('requires writes before reads', () => {
    expect(
      worktreeSnapshotReadsEnabled({
        WORKTREE_SNAPSHOT_WRITES_ENABLED: 'false',
        WORKTREE_SNAPSHOT_READS_ENABLED: 'true',
      })
    ).toBe(false);
    expect(
      worktreeSnapshotReadsEnabled({
        WORKTREE_SNAPSHOT_WRITES_ENABLED: 'true',
        WORKTREE_SNAPSHOT_READS_ENABLED: 'true',
      })
    ).toBe(true);
  });
});

describe('worktree snapshot authorization', () => {
  const authorized = {
    allocationId: identity.allocationId,
    currentAllocationId: identity.allocationId,
    allocationKind: 'connected',
    routeScopeIds: ['workspace_other', worktreeId],
    worktreeId,
    tombstoned: false,
  };

  it('accepts the current allocation with a matching route', () => {
    expect(decideWorktreeSnapshotAuthorization(authorized)).toBe(true);
  });

  it('rejects a stale allocation', () => {
    expect(
      decideWorktreeSnapshotAuthorization({
        ...authorized,
        currentAllocationId: 'allocation_new',
      })
    ).toBe(false);
  });

  it('rejects stopped and stopping allocations', () => {
    expect(decideWorktreeSnapshotAuthorization({ ...authorized, allocationKind: 'stopped' })).toBe(
      false
    );
    expect(decideWorktreeSnapshotAuthorization({ ...authorized, allocationKind: 'stopping' })).toBe(
      false
    );
  });

  it('rejects a missing or mismatched route scope', () => {
    expect(decideWorktreeSnapshotAuthorization({ ...authorized, routeScopeIds: [] })).toBe(false);
    expect(
      decideWorktreeSnapshotAuthorization({
        ...authorized,
        routeScopeIds: ['worktree_22222222-2222-4222-8222-222222222222'],
      })
    ).toBe(false);
  });

  it('rejects a tombstoned worktree', () => {
    expect(decideWorktreeSnapshotAuthorization({ ...authorized, tombstoned: true })).toBe(false);
  });
});

describe('worktree snapshot storage', () => {
  it('uses the v1 object key and versioned tombstone key', () => {
    expect(worktreeSnapshotObjectKey(worktreeId)).toBe(`v1/${worktreeId}.tar.gz`);
    expect(worktreeSnapshotTombstoneKey(worktreeId)).toMatch(/^worktree_snapshot_tombstone\//);
  });

  it('writes the tombstone before deleting the object', async () => {
    const calls: string[] = [];
    const storage = {
      async put(key: string, _value: unknown) {
        calls.push(`put:${key}`);
      },
    };
    const bucket = {
      async delete(key: string) {
        calls.push(`delete:${key}`);
      },
    };
    await expect(purgeWorktreeSnapshot({ worktreeId, storage, bucket })).resolves.toBe(true);
    expect(calls).toEqual([
      `put:${worktreeSnapshotTombstoneKey(worktreeId)}`,
      `delete:${worktreeSnapshotObjectKey(worktreeId)}`,
    ]);
  });

  it('keeps the tombstone when the object delete fails', async () => {
    const deleted: string[] = [];
    const storage = {
      async put(key: string) {
        deleted.push(`put:${key}`);
      },
    };
    const bucket = {
      async delete() {
        throw new Error('r2 unavailable');
      },
    };
    await expect(purgeWorktreeSnapshot({ worktreeId, storage, bucket })).resolves.toBe(false);
    expect(deleted).toEqual([`put:${worktreeSnapshotTombstoneKey(worktreeId)}`]);
  });

  it('still writes the tombstone when no bucket is bound', async () => {
    const calls: string[] = [];
    const storage = {
      async put(key: string) {
        calls.push(key);
      },
    };
    await expect(purgeWorktreeSnapshot({ worktreeId, storage })).resolves.toBe(true);
    expect(calls).toEqual([worktreeSnapshotTombstoneKey(worktreeId)]);
  });
});
