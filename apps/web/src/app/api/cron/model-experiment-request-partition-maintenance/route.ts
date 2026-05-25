import { NextResponse } from 'next/server';
import { captureException, captureMessage } from '@sentry/nextjs';
import { db } from '@/lib/drizzle';
import { CRON_SECRET } from '@/lib/config.server';
import { sql } from 'drizzle-orm';
import { format } from 'date-fns';

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

/**
 * Provisions the next monthly partitions. The default partition retains rows
 * when maintenance is missed; this job reports any fallback rows for repair.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();
  const created: string[] = [];
  const errors: string[] = [];

  for (let offset = 0; offset <= 2; offset++) {
    const target = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const nextMonth = new Date(target.getFullYear(), target.getMonth() + 1, 1);
    const name = `model_experiment_request_${format(target, 'yyyy_MM')}`;

    try {
      await db.execute(
        sql.raw(
          `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "model_experiment_request" FOR VALUES FROM ('${format(target, 'yyyy-MM-dd')}') TO ('${format(nextMonth, 'yyyy-MM-dd')}')`
        )
      );
      created.push(name);
    } catch (error) {
      const message = `Failed to create partition ${name}: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`[model-experiment-request-partition-maintenance] ${message}`);
      captureException(error, {
        tags: { source: 'model-experiment-request-partition-maintenance', partition: name },
      });
      errors.push(message);
    }
  }

  try {
    const { rows: fallbackRows } = await db.execute<{ has_rows: boolean }>(
      sql`SELECT EXISTS (SELECT 1 FROM "model_experiment_request_default" LIMIT 1) AS "has_rows"`
    );
    if (fallbackRows[0]?.has_rows) {
      const message = 'Default partition contains request rows that require reassignment';
      console.error(`[model-experiment-request-partition-maintenance] ${message}`);
      captureMessage(message, {
        tags: { source: 'model-experiment-request-partition-maintenance' },
      });
      errors.push(message);
    }
  } catch (error) {
    const message = `Failed to check default partition: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`[model-experiment-request-partition-maintenance] ${message}`);
    captureException(error, { tags: { source: 'model-experiment-request-partition-maintenance' } });
    errors.push(message);
  }

  console.log(
    `[model-experiment-request-partition-maintenance] created=[${created.join(', ')}] errors=${errors.length}`
  );

  return NextResponse.json({
    success: errors.length === 0,
    created,
    errors,
  });
}
