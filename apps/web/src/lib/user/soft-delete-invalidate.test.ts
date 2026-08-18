import { describe, test, expect, beforeEach } from '@jest/globals';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { invalidateUserAuthCache } from '@/lib/session-ingest-client';
import { db } from '@/lib/drizzle';
import { findUserById, softDeleteUser } from '@/lib/user';

jest.mock('@/lib/stripe-client', () => ({
  createStripeCustomer: jest.fn(),
  deleteStripeCustomer: jest.fn(),
}));

jest.mock('@/lib/session-ingest-client', () => ({
  invalidateUserAuthCache: jest.fn().mockResolvedValue(undefined),
}));

const mockInvalidateUserAuthCache = jest.mocked(invalidateUserAuthCache);

describe('softDeleteUser auth-cache invalidation', () => {
  beforeEach(() => {
    mockInvalidateUserAuthCache.mockReset();
    mockInvalidateUserAuthCache.mockResolvedValue(undefined);
  });

  test('invalidates after a successful soft-delete', async () => {
    const user = await insertTestUser();

    await expect(softDeleteUser(user.id)).resolves.toBeUndefined();

    expect(mockInvalidateUserAuthCache).toHaveBeenCalledWith(user.id);
    const deleted = await findUserById(user.id);
    expect(deleted?.blocked_reason).toMatch(/^soft-deleted at /);
  });

  test('still succeeds when invalidation fails', async () => {
    const user = await insertTestUser();
    mockInvalidateUserAuthCache.mockRejectedValueOnce(new Error('invalidation unavailable'));

    await expect(softDeleteUser(user.id)).resolves.toBeUndefined();

    expect(mockInvalidateUserAuthCache).toHaveBeenCalledWith(user.id);
    const deleted = await findUserById(user.id);
    expect(deleted?.blocked_reason).toMatch(/^soft-deleted at /);
  });

  test('does not invalidate when the user is missing', async () => {
    await expect(softDeleteUser('non-existent-user')).resolves.toBeUndefined();
    expect(mockInvalidateUserAuthCache).not.toHaveBeenCalled();
  });

  test('does not invalidate when the anonymization transaction fails', async () => {
    const user = await insertTestUser();
    const transaction = jest.spyOn(db, 'transaction').mockImplementationOnce(async () => {
      throw new Error('database unavailable');
    });

    await expect(softDeleteUser(user.id)).rejects.toThrow('database unavailable');
    expect(mockInvalidateUserAuthCache).not.toHaveBeenCalled();
    transaction.mockRestore();
  });
});
