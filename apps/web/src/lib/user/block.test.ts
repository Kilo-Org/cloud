import { describe, test, expect } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { kilocode_users } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { blockUser } from '@/lib/user/block';

async function getUser(id: string) {
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

describe('blockUser (integration)', () => {
  test('blocks an unblocked user and rotates the api_token_pepper', async () => {
    const actor = await insertTestUser({ is_admin: true });
    const user = await insertTestUser({ api_token_pepper: 'initial-pepper' });

    const didBlock = await blockUser({
      kiloUserId: user.id,
      reason: 'manual block',
      blockedByKiloUserId: actor.id,
    });

    expect(didBlock).toBe(true);

    const after = await getUser(user.id);
    expect(after?.blocked_reason).toBe('manual block');
    expect(after?.blocked_at).not.toBeNull();
    expect(after?.blocked_by_kilo_user_id).toBe(actor.id);
    expect(after?.api_token_pepper).toEqual(expect.any(String));
    expect(after?.api_token_pepper).not.toBe('initial-pepper');
  });

  test('defaults blocked_by_kilo_user_id to null when no actor is given', async () => {
    const user = await insertTestUser({ api_token_pepper: 'initial-pepper' });

    const didBlock = await blockUser({ kiloUserId: user.id, reason: 'autoban' });

    expect(didBlock).toBe(true);
    const after = await getUser(user.id);
    expect(after?.blocked_reason).toBe('autoban');
    expect(after?.blocked_by_kilo_user_id).toBeNull();
    expect(after?.api_token_pepper).not.toBe('initial-pepper');
  });

  test('does not overwrite an existing block and leaves the pepper untouched', async () => {
    const user = await insertTestUser({ api_token_pepper: 'initial-pepper' });
    await db
      .update(kilocode_users)
      .set({ blocked_reason: 'already blocked' })
      .where(eq(kilocode_users.id, user.id));

    const didBlock = await blockUser({ kiloUserId: user.id, reason: 'second reason' });

    expect(didBlock).toBe(false);
    const after = await getUser(user.id);
    expect(after?.blocked_reason).toBe('already blocked');
    expect(after?.api_token_pepper).toBe('initial-pepper');
  });

  test('returns false for a non-existent user', async () => {
    const didBlock = await blockUser({ kiloUserId: 'does-not-exist', reason: 'nope' });
    expect(didBlock).toBe(false);
  });

  test('runs inside a provided transaction', async () => {
    const user = await insertTestUser({ api_token_pepper: 'initial-pepper' });

    await db.transaction(async tx => {
      const didBlock = await blockUser({
        kiloUserId: user.id,
        reason: 'tx block',
        dbOrTx: tx,
      });
      expect(didBlock).toBe(true);
    });

    const after = await getUser(user.id);
    expect(after?.blocked_reason).toBe('tx block');
    expect(after?.api_token_pepper).not.toBe('initial-pepper');
  });

  test('rolls back the block (and pepper rotation) when the transaction throws', async () => {
    const user = await insertTestUser({ api_token_pepper: 'initial-pepper' });

    await expect(
      db.transaction(async tx => {
        await blockUser({ kiloUserId: user.id, reason: 'tx block', dbOrTx: tx });
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const after = await getUser(user.id);
    expect(after?.blocked_reason).toBeNull();
    expect(after?.api_token_pepper).toBe('initial-pepper');
  });
});
