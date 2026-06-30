import { describe, test, expect } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { kilocode_users } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';

async function getBlockState(id: string) {
  return db.query.kilocode_users.findFirst({
    where: eq(kilocode_users.id, id),
    columns: {
      blocked_reason: true,
      blocked_at: true,
      blocked_by_kilo_user_id: true,
      api_token_pepper: true,
    },
  });
}

describe('admin.users.updateBlockStatus', () => {
  test('blocking a user rotates the api_token_pepper', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser({ api_token_pepper: 'initial-pepper' });

    const caller = await createCallerForUser(admin.id);
    const result = await caller.admin.users.updateBlockStatus({
      userId: user.id,
      blocked_reason: 'manual admin block',
    });
    expect(result).toEqual({ success: true });

    const after = await getBlockState(user.id);
    expect(after?.blocked_reason).toBe('manual admin block');
    expect(after?.blocked_by_kilo_user_id).toBe(admin.id);
    expect(after?.blocked_at).not.toBeNull();
    expect(after?.api_token_pepper).toEqual(expect.any(String));
    expect(after?.api_token_pepper).not.toBe('initial-pepper');
  });

  test('unblocking clears block fields and leaves the pepper untouched', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser({
      api_token_pepper: 'blocked-pepper',
      blocked_reason: 'previously blocked',
      blocked_at: new Date().toISOString(),
    });

    const caller = await createCallerForUser(admin.id);
    const result = await caller.admin.users.updateBlockStatus({
      userId: user.id,
      blocked_reason: null,
    });
    expect(result).toEqual({ success: true });

    const after = await getBlockState(user.id);
    expect(after?.blocked_reason).toBeNull();
    expect(after?.blocked_at).toBeNull();
    expect(after?.blocked_by_kilo_user_id).toBeNull();
    // Unblock must not rotate the pepper (it is not a revocation event).
    expect(after?.api_token_pepper).toBe('blocked-pepper');
  });

  test('blocking an already-blocked user preserves the original block and pepper', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser({
      api_token_pepper: 'first-block-pepper',
      blocked_reason: 'first reason',
      blocked_at: new Date().toISOString(),
    });

    const caller = await createCallerForUser(admin.id);
    await caller.admin.users.updateBlockStatus({
      userId: user.id,
      blocked_reason: 'second reason',
    });

    const after = await getBlockState(user.id);
    // Existing block is never overwritten; the original reason and pepper stand.
    expect(after?.blocked_reason).toBe('first reason');
    expect(after?.api_token_pepper).toBe('first-block-pepper');
  });
});
