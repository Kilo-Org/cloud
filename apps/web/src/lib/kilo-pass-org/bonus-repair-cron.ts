import 'server-only';

import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { repairExpiredOrganizationPassBonuses } from './bonus-repair';

export async function runOrganizationPassBonusRepairCron(
  database: typeof db = db,
  now = new Date()
): Promise<{ examined: number; recordedMisses: number }> {
  return database.transaction((tx: DrizzleTransaction) =>
    repairExpiredOrganizationPassBonuses(tx, now.toISOString())
  );
}
