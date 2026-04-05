import { db, closeAllDrizzleConnections } from '@/lib/drizzle';
import { sql } from 'drizzle-orm';

const BATCH_SIZE = 2_000;

async function run(): Promise<void> {
  console.log(`Batch size: ${BATCH_SIZE}`);

  const scriptStartTime = performance.now();
  let totalProcessed = 0;
  let totalUpdated = 0;
  let batchNumber = 0;

  let startingAt = new Date('2025-01-01');

  while (true) {
    batchNumber++;
    const batchStartTime = performance.now();

    console.log(`\nBatch ${batchNumber}: Processing...`);

    // Execute single SQL statement that:
    // 1. Selects batch of records from created_at cursor position where any of the migrated columns is NOT NULL
    // 2. Updates those records to set all migrated columns to NULL
    // 3. Returns the max created_at to use as cursor for next batch
    const result: {
      rows: Array<{ updated_count: number; batch_size: number; max_created_at: string | null }>;
    } = await db.execute(sql`
      WITH
        batch_records AS (
          SELECT max(created_at) as max_created_at, COUNT(*)::int as batch_size
          FROM (
            SELECT created_at
            FROM microdollar_usage
            WHERE created_at >= ${startingAt}
            ORDER BY created_at ASC
            LIMIT ${BATCH_SIZE}
          ) AS batch
        ),
        updated_rows AS (
          UPDATE microdollar_usage mu
          SET
            message_id = NULL,
            http_x_forwarded_for = NULL,
            http_x_vercel_ip_city = NULL,
            http_x_vercel_ip_country = NULL,
            http_x_vercel_ip_latitude = NULL,
            http_x_vercel_ip_longitude = NULL,
            http_x_vercel_ja4_digest = NULL,
            user_prompt_prefix = NULL,
            system_prompt_prefix = NULL,
            system_prompt_length = NULL,
            http_user_agent = NULL,
            max_tokens = NULL,
            has_middle_out_transform = NULL
          WHERE created_at >= ${startingAt} and created_at <= (select max_created_at from batch_records)
          and (
            message_id is not null or
            http_x_forwarded_for is not null or
            http_x_vercel_ip_city is not null or
            http_x_vercel_ip_country is not null or
            http_x_vercel_ip_latitude is not null or
            http_x_vercel_ip_longitude is not null or
            http_x_vercel_ja4_digest is not null or
            user_prompt_prefix is not null or
            system_prompt_prefix is not null or
            system_prompt_length is not null or
            http_user_agent is not null or
            max_tokens is not null or
            has_middle_out_transform is not null
          )
          RETURNING mu.id
        )
      SELECT max_created_at
        , batch_size
        , (SELECT count(*) FROM updated_rows)::int as updated_count 
      FROM batch_records
    `);
    console.log(result.rows[0]);

    const updatedRowCount = result.rows[0]?.updated_count ?? 0;
    const max_created_at_str = result.rows[0]?.max_created_at;
    const maxCreatedAt = max_created_at_str ? new Date(max_created_at_str) : null;
    const batchRowCount = result.rows[0]?.batch_size ?? 0;

    totalProcessed += batchRowCount;
    totalUpdated += updatedRowCount;

    console.log(
      `Batch ${batchNumber} (up to ${maxCreatedAt?.toISOString() ?? '?'}): Processed ${batchRowCount} records of which ${updatedRowCount} updated`
    );
    const batchElapsedMs = performance.now() - batchStartTime;
    const totalElapsedMs = performance.now() - scriptStartTime;
    const recordsPerSecond = (totalProcessed / totalElapsedMs) * 1000;
    const updatesPerSecond = (totalUpdated / totalElapsedMs) * 1000;

    console.log(`Batch ${batchNumber} completed:`);
    console.log(`  - Batch time: ${(batchElapsedMs / 1000).toFixed(2)}s`);
    console.log(`  - Total time: ${(totalElapsedMs / 1000).toFixed(1)}s`);
    console.log(`  - Total records processed: ${totalProcessed}`);
    console.log(`  - Total records updated: ${totalUpdated}`);
    console.log(`  - Records/second: ${recordsPerSecond.toFixed(1)}`);
    console.log(`  - Updates/second: ${updatesPerSecond.toFixed(1)}`);

    // If we got fewer records than batch size, we're done
    if (batchRowCount < BATCH_SIZE || maxCreatedAt === null) {
      console.log('\nReached end of data (batch smaller than batch size)');
      break;
    }
    // Update cursor for next batch
    startingAt = maxCreatedAt;
  }
}

void run()
  .then(async () => {
    console.log(`\nScript completed successfully`);
    await closeAllDrizzleConnections();
    process.exit(0);
  })
  .catch(async error => {
    console.error('Script failed:', error);
    await closeAllDrizzleConnections();
    process.exit(1);
  });
