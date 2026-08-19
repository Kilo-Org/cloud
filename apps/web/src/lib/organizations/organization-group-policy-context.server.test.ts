import { db, readDb } from '@/lib/drizzle';

jest.mock('@/lib/drizzle', () => ({
  db: { transaction: jest.fn() },
  readDb: { transaction: jest.fn() },
}));

import { getOrganizationGroupPolicyContext } from './organization-group-policy-context.server';

const mockedPrimaryTransaction = jest.mocked(db.transaction);
const mockedReplicaTransaction = jest.mocked(readDb.transaction);

describe('getOrganizationGroupPolicyContext', () => {
  it('opens its repeatable-read snapshot on the primary database', async () => {
    const transactionError = new Error('stop after selecting the transaction client');
    mockedPrimaryTransaction.mockRejectedValueOnce(transactionError);

    await expect(
      getOrganizationGroupPolicyContext({
        organizationId: '00000000-0000-0000-0000-000000000001',
        subject: { type: 'defaultAccess' },
      })
    ).rejects.toBe(transactionError);

    expect(mockedPrimaryTransaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
    expect(mockedReplicaTransaction).not.toHaveBeenCalled();
  });
});
