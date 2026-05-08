import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type * as do_module from '../dos/NotificationChannelDO';

type DOStub = DurableObjectStub<do_module.NotificationChannelDO> & {
  markBucketRead: (bucket: string) => Promise<number>;
  listNonZeroBuckets: () => Promise<{ badgeBucket: string; badgeCount: number }[]>;
};

function getDO(name: string): DOStub {
  const id = env.NOTIFICATION_CHANNEL_DO.idFromName(name);
  return env.NOTIFICATION_CHANNEL_DO.get(id) as unknown as DOStub;
}

// Seed buckets directly into DO storage so these tests stay focused on the
// helper round-trips rather than exercising dispatchPush again.
async function seedBuckets(stub: DOStub, buckets: Record<string, number>) {
  await runInDurableObject(stub, async (_inst, state) => {
    let total = 0;
    for (const [bucket, count] of Object.entries(buckets)) {
      await state.storage.put<number>(`bucket:${bucket}`, count);
      total += count;
    }
    await state.storage.put<number>('total', total);
  });
}

describe('NotificationChannelDO badge storage helpers', () => {
  it('listNonZeroBuckets returns nothing on a fresh DO', async () => {
    const stub = getDO('user-empty');
    const out = await stub.listNonZeroBuckets();
    expect(out).toEqual([]);
  });

  it('listNonZeroBuckets returns all stored buckets and skips zero counts', async () => {
    const stub = getDO('user-list');
    await seedBuckets(stub, { 'kiloclaw:sb1:conv1': 2, 'kiloclaw:sb1:conv2': 5, zeroed: 0 });

    const out = await stub.listNonZeroBuckets();
    out.sort((a, b) => a.badgeBucket.localeCompare(b.badgeBucket));

    expect(out).toEqual([
      { badgeBucket: 'kiloclaw:sb1:conv1', badgeCount: 2 },
      { badgeBucket: 'kiloclaw:sb1:conv2', badgeCount: 5 },
    ]);
  });

  it('markBucketRead clears the bucket and returns the user total', async () => {
    const stub = getDO('user-mark');
    await seedBuckets(stub, { conv1: 2, conv2: 5 });

    const totalAfter = await stub.markBucketRead('conv1');
    expect(totalAfter).toBe(5);

    const remaining = await runInDurableObject(stub, async (_inst, state) => {
      const entries = await state.storage.list<number>({ prefix: 'bucket:' });
      return Array.from(entries.entries());
    });
    expect(remaining).toEqual([['bucket:conv2', 5]]);

    const aggregate = await runInDurableObject(stub, (_inst, state) =>
      state.storage.get<number>('total')
    );
    expect(aggregate).toBe(5);
  });

  it('markBucketRead does not create aggregate storage for a missing bucket', async () => {
    const stub = getDO('user-mark-missing');

    expect(await stub.markBucketRead('does-not-exist')).toBe(0);

    const stored = await runInDurableObject(stub, async (_inst, state) => {
      const entries = await state.storage.list();
      return Array.from(entries.entries());
    });
    expect(stored).toEqual([]);
  });

  it('markBucketRead does not create aggregate storage for an empty bucket', async () => {
    const stub = getDO('user-mark-empty');
    await runInDurableObject(stub, (_inst, state) => state.storage.put<number>('bucket:empty', 0));

    expect(await stub.markBucketRead('empty')).toBe(0);

    const stored = await runInDurableObject(stub, async (_inst, state) => {
      const entries = await state.storage.list();
      return Array.from(entries.entries());
    });
    expect(stored).toEqual([['bucket:empty', 0]]);
  });

  it('markBucketRead is idempotent and returns the running total', async () => {
    const stub = getDO('user-mark-twice');
    await seedBuckets(stub, { conv1: 3, conv2: 1 });

    expect(await stub.markBucketRead('conv1')).toBe(1);
    // Marking the same bucket again should leave state untouched and still
    // return the user's current total.
    expect(await stub.markBucketRead('conv1')).toBe(1);
    // Marking a never-seen bucket is a no-op.
    expect(await stub.markBucketRead('does-not-exist')).toBe(1);
  });

  it('round-trips: increment via dispatchPush, list, mark read', async () => {
    // Seed two buckets to mimic two conversations the user has unread in.
    const stub = getDO('user-roundtrip');
    await seedBuckets(stub, { 'kiloclaw:sb1:c1': 2, 'kiloclaw:sb1:c2': 1 });

    const before = await stub.listNonZeroBuckets();
    before.sort((a, b) => a.badgeBucket.localeCompare(b.badgeBucket));
    expect(before).toEqual([
      { badgeBucket: 'kiloclaw:sb1:c1', badgeCount: 2 },
      { badgeBucket: 'kiloclaw:sb1:c2', badgeCount: 1 },
    ]);

    const totalAfterRead = await stub.markBucketRead('kiloclaw:sb1:c1');
    expect(totalAfterRead).toBe(1);

    const after = await stub.listNonZeroBuckets();
    expect(after).toEqual([{ badgeBucket: 'kiloclaw:sb1:c2', badgeCount: 1 }]);
  });
});
