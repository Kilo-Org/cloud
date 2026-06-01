import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { db } from '@/lib/drizzle';
import { CRON_SECRET } from '@/lib/config.server';
import { provisionExaUsageLogPartitions } from '@/lib/exa-usage-partitions';

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

/**
 * Exa Usage Log Partition Maintenance
 *
 * Run monthly. Creates the next two months' partitions (idempotent).
 * Old partitions are retained indefinitely — the recompute balance
 * functions depend on the full exa_usage_log history.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { created, errors: partitionErrors } = await provisionExaUsageLogPartitions(db);
  const errors: string[] = [];

  for (const { name, error } of partitionErrors) {
    const msg = `Failed to create partition ${name}: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`[exa-partition-maintenance] ${msg}`);
    captureException(error, { tags: { source: 'exa-partition-maintenance', partition: name } });
    errors.push(msg);
  }

  console.log(
    `[exa-partition-maintenance] created=[${created.join(', ')}] errors=${errors.length}`
  );

  return NextResponse.json({
    success: errors.length === 0,
    created,
    errors,
  });
}
