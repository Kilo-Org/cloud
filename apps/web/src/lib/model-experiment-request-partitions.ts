import type { db as defaultDb } from '@/lib/drizzle';
import { sql } from 'drizzle-orm';
import { format } from 'date-fns';

type ModelExperimentRequestPartitionDb = Pick<typeof defaultDb, 'execute'>;

export type ModelExperimentRequestPartitionProvisioningResult = {
  created: string[];
  errors: Array<{ name: string; error: unknown }>;
};

/**
 * Creates the current month and next two monthly request-audit partitions.
 *
 * Production keeps this window current via cron. Fresh migrate snapshots (CI,
 * Jest workers) only have the seed months from the partitioning migration, so
 * tests must call this before inserting rows whose created_at defaults to now().
 */
export async function provisionModelExperimentRequestPartitions(
  fromDb: ModelExperimentRequestPartitionDb,
  now: Date = new Date()
): Promise<ModelExperimentRequestPartitionProvisioningResult> {
  const created: string[] = [];
  const errors: Array<{ name: string; error: unknown }> = [];

  for (let offset = 0; offset <= 2; offset++) {
    const target = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const nextMonth = new Date(target.getFullYear(), target.getMonth() + 1, 1);
    const name = `model_experiment_request_${format(target, 'yyyy_MM')}`;

    try {
      await fromDb.execute(
        sql.raw(
          `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "model_experiment_request" FOR VALUES FROM ('${format(target, 'yyyy-MM-dd')}') TO ('${format(nextMonth, 'yyyy-MM-dd')}')`
        )
      );
      created.push(name);
    } catch (error) {
      errors.push({ name, error });
    }
  }

  return { created, errors };
}
