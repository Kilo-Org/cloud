import { db, closeAllDrizzleConnections } from '@/lib/drizzle';
import { sql } from 'drizzle-orm';

const BATCH_SIZE = 10_000;

async function run(): Promise<void> {
  console.log(`Batch size: ${BATCH_SIZE}`);

  const scriptStartTime = performance.now();
  let totalProcessed = 0;
  let totalInserted = 0;
  let batchNumber = 0;

  let startingAt: Date | null = null;

  while (true) {
    batchNumber++;
    const batchStartTime = performance.now();

    console.log(`\nBatch ${batchNumber}: Processing...`);

    // Execute single SQL statement that does everything:
    // 1. Select batch of records from created_at cursor position
    // 2. Upsert unique values into lookup tables
    // 3. Insert into metadata table with joins to lookup tables
    // 4. Return the max created_at to use as cursor for next batch
    const result: {
      rows: Array<{ inserted_count: number; batch_size: number; max_created_at: string | null }>;
    } = await db.execute(sql`
      WITH
        batch_records AS (
          SELECT mu.*
          FROM microdollar_usage mu
          WHERE ${startingAt === null ? sql`TRUE` : sql`mu.created_at >= ${startingAt}`}
          ORDER BY mu.created_at ASC
          LIMIT ${BATCH_SIZE}
        ),
        http_user_agent_upsert AS (
          INSERT INTO http_user_agent (http_user_agent)
          SELECT DISTINCT http_user_agent
          FROM batch_records
          WHERE http_user_agent IS NOT NULL
          ON CONFLICT (http_user_agent) DO NOTHING
          RETURNING http_user_agent_id, http_user_agent
        ),
        http_user_agent_lookup AS (
          SELECT http_user_agent_id, http_user_agent
          FROM http_user_agent
          WHERE http_user_agent IN (SELECT DISTINCT http_user_agent FROM batch_records WHERE http_user_agent IS NOT NULL)
        ),
        http_ip_upsert AS (
          INSERT INTO http_ip (http_ip)
          SELECT DISTINCT http_x_forwarded_for
          FROM batch_records
          WHERE http_x_forwarded_for IS NOT NULL
          ON CONFLICT (http_ip) DO NOTHING
          RETURNING http_ip_id, http_ip
        ),
        http_ip_lookup AS (
          SELECT http_ip_id, http_ip
          FROM http_ip
          WHERE http_ip IN (SELECT DISTINCT http_x_forwarded_for FROM batch_records WHERE http_x_forwarded_for IS NOT NULL)
        ),
        vercel_ip_country_upsert AS (
          INSERT INTO vercel_ip_country (vercel_ip_country)
          SELECT DISTINCT http_x_vercel_ip_country
          FROM batch_records
          WHERE http_x_vercel_ip_country IS NOT NULL
          ON CONFLICT (vercel_ip_country) DO NOTHING
          RETURNING vercel_ip_country_id, vercel_ip_country
        ),
        vercel_ip_country_lookup AS (
          SELECT vercel_ip_country_id, vercel_ip_country
          FROM vercel_ip_country
          WHERE vercel_ip_country IN (SELECT DISTINCT http_x_vercel_ip_country FROM batch_records WHERE http_x_vercel_ip_country IS NOT NULL)
        ),
        vercel_ip_city_upsert AS (
          INSERT INTO vercel_ip_city (vercel_ip_city)
          SELECT DISTINCT http_x_vercel_ip_city
          FROM batch_records
          WHERE http_x_vercel_ip_city IS NOT NULL
          ON CONFLICT (vercel_ip_city) DO NOTHING
          RETURNING vercel_ip_city_id, vercel_ip_city
        ),
        vercel_ip_city_lookup AS (
          SELECT vercel_ip_city_id, vercel_ip_city
          FROM vercel_ip_city
          WHERE vercel_ip_city IN (SELECT DISTINCT http_x_vercel_ip_city FROM batch_records WHERE http_x_vercel_ip_city IS NOT NULL)
        ),
        ja4_digest_upsert AS (
          INSERT INTO ja4_digest (ja4_digest)
          SELECT DISTINCT http_x_vercel_ja4_digest
          FROM batch_records
          WHERE http_x_vercel_ja4_digest IS NOT NULL
          ON CONFLICT (ja4_digest) DO NOTHING
          RETURNING ja4_digest_id, ja4_digest
        ),
        ja4_digest_lookup AS (
          SELECT ja4_digest_id, ja4_digest
          FROM ja4_digest
          WHERE ja4_digest IN (SELECT DISTINCT http_x_vercel_ja4_digest FROM batch_records WHERE http_x_vercel_ja4_digest IS NOT NULL)
        ),
        system_prompt_prefix_upsert AS (
          INSERT INTO system_prompt_prefix (system_prompt_prefix)
          SELECT DISTINCT system_prompt_prefix
          FROM batch_records
          WHERE system_prompt_prefix IS NOT NULL
          ON CONFLICT (system_prompt_prefix) DO NOTHING
          RETURNING system_prompt_prefix_id, system_prompt_prefix
        ),
        system_prompt_prefix_lookup AS (
          SELECT system_prompt_prefix_id, system_prompt_prefix
          FROM system_prompt_prefix
          WHERE system_prompt_prefix IN (SELECT DISTINCT system_prompt_prefix FROM batch_records WHERE system_prompt_prefix IS NOT NULL)
        ),
        inserted_rows AS (
          INSERT INTO microdollar_usage_metadata (
            id, message_id, user_prompt_prefix, vercel_ip_latitude, vercel_ip_longitude,
            system_prompt_length, max_tokens, has_middle_out_transform,
            http_user_agent_id, http_ip_id, vercel_ip_country_id, vercel_ip_city_id,
            ja4_digest_id, system_prompt_prefix_id
          )
          SELECT
            br.id,
            COALESCE(br.message_id, '<missing>'),
            br.user_prompt_prefix,
            br.http_x_vercel_ip_latitude,
            br.http_x_vercel_ip_longitude,
            br.system_prompt_length,
            br.max_tokens,
            br.has_middle_out_transform,
            hua.http_user_agent_id,
            hip.http_ip_id,
            vic.vercel_ip_country_id,
            vicity.vercel_ip_city_id,
            ja4.ja4_digest_id,
            spp.system_prompt_prefix_id
          FROM batch_records br
          LEFT JOIN http_user_agent_lookup hua ON br.http_user_agent = hua.http_user_agent
          LEFT JOIN http_ip_lookup hip ON br.http_x_forwarded_for = hip.http_ip
          LEFT JOIN vercel_ip_country_lookup vic ON br.http_x_vercel_ip_country = vic.vercel_ip_country
          LEFT JOIN vercel_ip_city_lookup vicity ON br.http_x_vercel_ip_city = vicity.vercel_ip_city
          LEFT JOIN ja4_digest_lookup ja4 ON br.http_x_vercel_ja4_digest = ja4.ja4_digest
          LEFT JOIN system_prompt_prefix_lookup spp ON br.system_prompt_prefix = spp.system_prompt_prefix
          ON CONFLICT (id) DO NOTHING
          RETURNING id
        )
      SELECT MAX(created_at)  as max_created_at
        , COUNT(*)::int as batch_size
        , (SELECT count(*) FROM inserted_rows)::int as inserted_count 
      FROM batch_records
    `);
    console.log(result.rows[0]);

    const insertedRowCount = result.rows[0]?.inserted_count ?? 0;
    const max_created_at_str = result.rows[0]?.max_created_at;
    const maxCreatedAt = max_created_at_str ? new Date(max_created_at_str) : null;
    const batchRowCount = result.rows[0]?.batch_size ?? 0;

    totalProcessed += batchRowCount;
    totalInserted += insertedRowCount;

    // Update cursor for next batch (inclusive lower bound is safe due to ON CONFLICT DO NOTHING)
    startingAt = maxCreatedAt;

    console.log(
      `Batch ${batchNumber} (up to ${maxCreatedAt?.toISOString() ?? '?'}): Processed ${batchRowCount} records of which ${insertedRowCount} inserted`
    );
    const batchElapsedMs = performance.now() - batchStartTime;
    const totalElapsedMs = performance.now() - scriptStartTime;
    const recordsPerSecond = (totalProcessed / totalElapsedMs) * 1000;
    const insertsPerSecond = (totalInserted / totalElapsedMs) * 1000;

    console.log(`Batch ${batchNumber} completed:`);
    console.log(`  - Batch time: ${(batchElapsedMs / 1000).toFixed(2)}s`);
    console.log(`  - Total time: ${(totalElapsedMs / 1000).toFixed(1)}s`);
    console.log(`  - Total records processed: ${totalProcessed}`);
    console.log(`  - Total records inserted: ${totalInserted}`);
    console.log(`  - Records/second: ${recordsPerSecond.toFixed(1)}`);
    console.log(`  - Inserts/second: ${insertsPerSecond.toFixed(1)}`);

    // If we got fewer records than batch size, we're done
    if (batchRowCount < BATCH_SIZE) {
      console.log('\nReached end of data (batch smaller than batch size)');
      break;
    }
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
