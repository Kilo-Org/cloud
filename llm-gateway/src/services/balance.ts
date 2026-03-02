import { eq } from 'drizzle-orm';
import { kilocode_users } from '@kilocode/db/schema';
import type { User } from '@kilocode/db/schema';
import type { WorkerDb } from '../lib/db.js';

type BalanceResult = {
  balance: number;
  settings?: {
    model_allow_list?: string[];
    provider_allow_list?: string[];
    data_collection?: 'allow' | 'deny';
  };
  plan?: 'teams' | 'enterprise';
};

export async function getBalanceAndOrgSettings(
  organizationId: string | undefined,
  user: User,
  db: WorkerDb
): Promise<BalanceResult> {
  if (organizationId) {
    // For org users, query organization balance and settings
    // TODO: Port full organization balance query from Next.js
    return { balance: Infinity };
  }

  // For individual users, balance = credits - usage
  const [freshUser] = await db
    .select({
      microdollars_used: kilocode_users.microdollars_used,
      total_microdollars_acquired: kilocode_users.total_microdollars_acquired,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, user.id))
    .limit(1);

  if (!freshUser) {
    return { balance: 0 };
  }

  const balance =
    Number(freshUser.total_microdollars_acquired) - Number(freshUser.microdollars_used);
  return { balance };
}
