import type { db as defaultDb } from '@/lib/drizzle';
import { sql } from 'drizzle-orm';
import { format } from 'date-fns';

type ExaPartitionDb = Pick<typeof defaultDb, 'execute'>;

export type ExaUsageLogPartitionProvisioningResult = {
  created: string[];
  errors: Array<{ name: string; error: unknown }>;
};

/**
 * Creates the current month and next two monthly audit-log partitions.
 *
 * The cron endpoint reports all failed partitions, while test setup treats any
 * failed partition as fatal after calling this best-effort helper.
 */
export async function provisionExaUsageLogPartitions(
  fromDb: ExaPartitionDb,
  now: Date = new Date()
): Promise<ExaUsageLogPartitionProvisioningResult> {
  const created: string[] = [];
  const errors: Array<{ name: string; error: unknown }> = [];

  for (let offset = 0; offset <= 2; offset++) {
    const target = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const nextMonth = new Date(target.getFullYear(), target.getMonth() + 1, 1);
    const name = `exa_usage_log_${format(target, 'yyyy_MM')}`;

    try {
      await fromDb.execute(
        sql.raw(
          `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "exa_usage_log" FOR VALUES FROM ('${format(target, 'yyyy-MM-dd')}') TO ('${format(nextMonth, 'yyyy-MM-dd')}')`
        )
      );
      created.push(name);
    } catch (error) {
      errors.push({ name, error });
    }
  }

  return { created, errors };
}
