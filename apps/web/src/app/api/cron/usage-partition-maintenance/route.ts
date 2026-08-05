import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { db } from '@/lib/drizzle';
import { CRON_SECRET } from '@/lib/config.server';
import {
  provisionComputeUsageChargePartitions,
  provisionExaUsageLogPartitions,
} from '@/lib/usage-partitions';

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

/**
 * Usage Ledger Partition Maintenance
 *
 * Run monthly. Creates the next two months' partitions (idempotent).
 * Old partitions are retained indefinitely because balance recomputation
 * depends on the full history of each usage ledger.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [
    { created: exaCreated, errors: exaErrors },
    { created: chargeCreated, errors: chargeErrors },
  ] = await Promise.all([
    provisionExaUsageLogPartitions(db),
    provisionComputeUsageChargePartitions(db),
  ]);
  const created = [...exaCreated, ...chargeCreated];
  const partitionErrors = [...exaErrors, ...chargeErrors];
  const errors: string[] = [];

  for (const { name, error } of partitionErrors) {
    const msg = `Failed to create partition ${name}: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`[usage-partition-maintenance] ${msg}`);
    captureException(error, { tags: { source: 'usage-partition-maintenance', partition: name } });
    errors.push(msg);
  }

  console.log(
    `[usage-partition-maintenance] created=[${created.join(', ')}] errors=${errors.length}`
  );

  return NextResponse.json({
    success: errors.length === 0,
    created,
    errors,
  });
}
