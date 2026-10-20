import { env, reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { getWorktreeCleanupStub } from '../../src/worktree-cleanup/stub.js';
import { StoredWorktreeCleanupItem } from '../../src/worktree-cleanup/schemas.js';

const owner = { userId: 'oauth/google:background-cleanup' };
const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
const otherWorktreeId = 'worktree_22222222-2222-4222-8222-222222222222';

afterEach(() => reset());

describe('worktree cleanup durable storage', () => {
  it('atomically accepts one frozen batch for concurrent starts and isolates tenants', async () => {
    const stub = getWorktreeCleanupStub(env, owner);
    const batches = await Promise.all([
      stub.start(owner, { worktreeIds: [worktreeId] }),
      stub.start(owner, { worktreeIds: [otherWorktreeId] }),
    ]);
    expect(batches[0]).toEqual(batches[1]);
    expect(await getWorktreeCleanupStub(env, owner).get(owner)).toEqual(batches[0]);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
      const batch = await state.storage.get('batch');
      expect(batch).toMatchObject({ owner });
      expect(JSON.stringify(batch)).not.toContain('authToken');
      await state.storage.deleteAlarm();
    });
    const otherUser = { userId: 'other-user' };
    const organization = {
      ...owner,
      kilocodeOrganizationId: '22222222-2222-4222-8222-222222222222',
    };
    expect(await getWorktreeCleanupStub(env, otherUser).get(otherUser)).toBeNull();
    expect(await getWorktreeCleanupStub(env, organization).get(organization)).toBeNull();
  });

  it('stores the maximum 1000-item batch as separate durable records', async () => {
    const stub = getWorktreeCleanupStub(env, owner);
    const worktreeIds = Array.from(
      { length: 1000 },
      (_, index): `worktree_${string}` =>
        `worktree_${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`
    );
    const batch = await stub.start(owner, { worktreeIds });
    expect(batch.items.map(item => item.worktreeId)).toEqual(worktreeIds);
    await runInDurableObject(stub, async (_instance, state) => {
      expect((await state.storage.list({ prefix: 'item:' })).size).toBe(1000);
      await state.storage.deleteAlarm();
    });
    expect(await stub.get(owner)).toEqual(batch);
  });

  it('recovers a deleting item and bounds retries without another browser request', async () => {
    const stub = getWorktreeCleanupStub(env, owner);
    await stub.start(owner, { worktreeIds: [worktreeId, otherWorktreeId] });
    await runInDurableObject(stub, async (_instance, state) => {
      const item = StoredWorktreeCleanupItem.parse(await state.storage.get('item:0000'));
      await state.storage.put('item:0000', { ...item, status: 'deleting', attempts: 1 });
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(StoredWorktreeCleanupItem.parse(await state.storage.get('item:0000'))).toMatchObject({
        attempts: 2,
        status: 'pending',
      });
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await stub.get(owner))?.items[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('stopped after 3 attempts'),
    });
    expect((await stub.get(owner))?.items[1].status).toBe('pending');
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
    });
  });
});
