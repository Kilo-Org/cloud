import { beforeEach, describe, expect, test } from '@jest/globals';

jest.mock('./bonus-repair', () => ({ repairExpiredOrganizationPassBonuses: jest.fn() }));

import { repairExpiredOrganizationPassBonuses } from './bonus-repair';
import { runOrganizationPassBonusRepairCron } from './bonus-repair-cron';

const mockRepairExpiredOrganizationPassBonuses = jest.mocked(repairExpiredOrganizationPassBonuses);

describe('runOrganizationPassBonusRepairCron', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('runs the repair in one database transaction at the supplied time', async () => {
    const transaction = jest.fn();
    const database = { transaction };
    const tx = { id: 'transaction' };
    const now = new Date('2026-07-24T10:00:00.000Z');
    const summary = { examined: 4, recordedMisses: 2 };
    mockRepairExpiredOrganizationPassBonuses.mockResolvedValue(summary);
    transaction.mockImplementation(callback => callback(tx));

    await expect(runOrganizationPassBonusRepairCron(database as never, now)).resolves.toEqual(
      summary
    );

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(mockRepairExpiredOrganizationPassBonuses as jest.Mock).toHaveBeenCalledWith(
      tx,
      now.toISOString()
    );
  });
});
