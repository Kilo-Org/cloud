import { describe, test, expect, beforeEach } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { kilocode_users } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { invalidateUserAuthCache } from '@/lib/session-ingest-client';
import { blockUser } from '@/lib/user/block';

const mockAfterCallbacks: Array<() => unknown> = [];

jest.mock('next/server', () => ({
  after: jest.fn((callback: () => unknown) => {
    mockAfterCallbacks.push(callback);
  }),
}));

jest.mock('@/lib/session-ingest-client', () => ({
  invalidateUserAuthCache: jest.fn().mockResolvedValue(undefined),
}));

const mockInvalidateUserAuthCache = jest.mocked(invalidateUserAuthCache);

describe('blockUser auth-cache invalidation', () => {
  beforeEach(() => {
    mockInvalidateUserAuthCache.mockReset();
    mockInvalidateUserAuthCache.mockResolvedValue(undefined);
    mockAfterCallbacks.length = 0;
  });

  test('invalidates after a successful self-owned block', async () => {
    const user = await insertTestUser({ api_token_pepper: 'initial-pepper' });

    const didBlock = await blockUser({ kiloUserId: user.id, reason: 'manual block' });

    expect(didBlock).toBe(true);
    expect(mockInvalidateUserAuthCache).toHaveBeenCalledWith(user.id);
  });

  test('still returns true when invalidation fails', async () => {
    const user = await insertTestUser({ api_token_pepper: 'initial-pepper' });
    mockInvalidateUserAuthCache.mockRejectedValueOnce(new Error('invalidation unavailable'));

    await expect(blockUser({ kiloUserId: user.id, reason: 'manual block' })).resolves.toBe(true);

    const after = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
      columns: { blocked_reason: true },
    });
    expect(after?.blocked_reason).toBe('manual block');
    expect(mockInvalidateUserAuthCache).toHaveBeenCalledWith(user.id);
  });

  test('does not invalidate when the user was already blocked', async () => {
    const user = await insertTestUser({ api_token_pepper: 'initial-pepper' });
    await db
      .update(kilocode_users)
      .set({ blocked_reason: 'already blocked' })
      .where(eq(kilocode_users.id, user.id));

    const didBlock = await blockUser({ kiloUserId: user.id, reason: 'second reason' });

    expect(didBlock).toBe(false);
    expect(mockInvalidateUserAuthCache).not.toHaveBeenCalled();
  });

  test('does not invalidate when the user is missing', async () => {
    await expect(
      blockUser({ kiloUserId: 'non-existent-user', reason: 'manual block' })
    ).resolves.toBe(false);
    expect(mockInvalidateUserAuthCache).not.toHaveBeenCalled();
  });

  test('defers invalidation until after a provided transaction callback returns', async () => {
    const user = await insertTestUser({ api_token_pepper: 'initial-pepper' });
    let transactionCallbackFinished = false;
    mockInvalidateUserAuthCache.mockImplementation(async () => {
      expect(transactionCallbackFinished).toBe(true);
    });

    const didBlock = await db.transaction(async tx => {
      const result = await blockUser({ kiloUserId: user.id, reason: 'tx block', dbOrTx: tx });
      expect(mockInvalidateUserAuthCache).not.toHaveBeenCalled();
      transactionCallbackFinished = true;
      return result;
    });

    expect(didBlock).toBe(true);
    expect(mockAfterCallbacks).toHaveLength(1);
    await mockAfterCallbacks[0]!();
    expect(mockInvalidateUserAuthCache).toHaveBeenCalledWith(user.id);
  });
});
