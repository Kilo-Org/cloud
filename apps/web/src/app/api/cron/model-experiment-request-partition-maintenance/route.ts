import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { db } from '@/lib/drizzle';
import { CRON_SECRET } from '@/lib/config.server';
import { provisionModelExperimentRequestPartitions } from '@/lib/model-experiment-request-partitions';

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

/**
 * Provisions the current month and two months ahead so inserts route into a
 * bounded monthly partition window.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { created, errors: partitionErrors } = await provisionModelExperimentRequestPartitions(db);
  const errors = partitionErrors.map(({ name, error }) => {
    const message = `Failed to create partition ${name}: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`[model-experiment-request-partition-maintenance] ${message}`);
    captureException(error, {
      tags: { source: 'model-experiment-request-partition-maintenance', partition: name },
    });
    return message;
  });

  console.log(
    `[model-experiment-request-partition-maintenance] created=[${created.join(', ')}] errors=${errors.length}`
  );

  return NextResponse.json({
    success: errors.length === 0,
    created,
    errors,
  });
}
