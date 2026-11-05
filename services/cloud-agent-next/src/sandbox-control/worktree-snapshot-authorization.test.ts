import { describe, expect, it } from 'vitest';
import {
  decideWorktreeSnapshotAuthorization,
  purgeWorktreeSnapshot,
  worktreeSnapshotAuthorizationInputSchema,
  worktreeSnapshotObjectKey,
  worktreeSnapshotReadsEnabled,
  worktreeSnapshotTombstoneKey,
  worktreeSnapshotWritesEnabled,
} from './worktree-snapshot-authorization.js';

const allocationId = 'allocation_test';
const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
const credential = 'a'.repeat(64);

describe('worktree snapshot authorization input', () => {
  it('requires the allocation, worktree, and current credential', () => {
    expect(
      worktreeSnapshotAuthorizationInputSchema.safeParse({ allocationId, worktreeId, credential })
        .success
    ).toBe(true);
    expect(
      worktreeSnapshotAuthorizationInputSchema.safeParse({ allocationId, worktreeId }).success
    ).toBe(false);
    expect(
      worktreeSnapshotAuthorizationInputSchema.safeParse({
        allocationId,
        worktreeId,
        credential: 'short',
      }).success
    ).toBe(false);
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
    allocationId,
    currentAllocationId: allocationId,
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
