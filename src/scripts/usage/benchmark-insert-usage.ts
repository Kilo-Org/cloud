import { cpus } from 'os';
import { randomUUID } from 'crypto';
import { Worker } from 'worker_threads';
import path from 'path';
import { closeAllDrizzleConnections, db } from '@/lib/drizzle';
import { shutdownPosthog } from '@/lib/posthog';
import { sql } from 'drizzle-orm';
import type { UsageMetaData } from '@/lib/processUsage';
import type { MicrodollarUsage } from '@/db/schema';
import stats from './stats.json';

const TOTAL_RECORDS = 100_000;

type Stats = typeof stats;

function scaleUniqueCount(originalCount: number, totalRows: number): number {
  return Math.max(1, Math.round((originalCount * TOTAL_RECORDS) / totalRows));
}

function randomString(avgLen: number, minLen: number, maxLen: number): string {
  const len = Math.max(
    minLen,
    Math.min(maxLen, Math.round(avgLen + (Math.random() - 0.5) * (maxLen - minLen)))
  );
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./';
  let result = '';
  for (let i = 0; i < len; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

function maybeNull<T>(value: T, nullPct: number): T | null {
  return Math.random() * 100 < nullPct ? null : value;
}

function randomInt(avg: number, min = 0, max = avg * 3): number {
  return Math.max(min, Math.min(max, Math.round(avg + (Math.random() - 0.5) * (max - min))));
}

function pickRandom<T>(arr: T[], rand: number): T {
  return arr[Math.floor(rand * arr.length)];
}

type UniquePools = {
  userAgents: string[];
  ips: string[];
  countries: string[];
  cities: string[];
  ja4Digests: string[];
  systemPromptPrefixes: string[];
  userIds: string[];
};

function generateRandomRecord(
  stats: Stats,
  uniquePools: UniquePools
): { core: MicrodollarUsage; metadata: UsageMetaData } {
  const id = randomUUID();
  const created_at = new Date().toISOString();
  const usageStats = stats.microdollar_usage;
  const metaStats = stats.microdollar_usage_metadata;

  const core: MicrodollarUsage = {
    id,
    kilo_user_id: pickRandom(uniquePools.userIds, Math.random()),
    organization_id: maybeNull(randomUUID(), usageStats.organization_id_null_pct),
    provider: maybeNull(
      randomString(
        usageStats.provider_avg_len,
        usageStats.provider_min_len,
        usageStats.provider_max_len
      ),
      usageStats.provider_null_pct
    ),
    cost: randomInt(usageStats.cost_avg, usageStats.cost_min, usageStats.cost_max),
    input_tokens: randomInt(usageStats.input_tokens_avg),
    output_tokens: randomInt(usageStats.output_tokens_avg),
    cache_write_tokens: randomInt(usageStats.cache_write_tokens_avg),
    cache_hit_tokens: randomInt(usageStats.cache_hit_tokens_avg),
    created_at,
    model: maybeNull(
      randomString(usageStats.model_avg_len, usageStats.model_min_len, usageStats.model_max_len),
      usageStats.model_null_pct
    ),
    requested_model: maybeNull(
      randomString(
        usageStats.requested_model_avg_len,
        usageStats.requested_model_min_len,
        usageStats.requested_model_max_len
      ),
      usageStats.requested_model_null_pct
    ),
    cache_discount: maybeNull(randomInt(1000), usageStats.cache_discount_null_pct),
    has_error: Math.random() < 0.01,
    abuse_classification: 0,
    inference_provider: maybeNull(
      randomString(
        usageStats.inference_provider_avg_len,
        usageStats.inference_provider_min_len,
        usageStats.inference_provider_max_len
      ),
      usageStats.inference_provider_null_pct
    ),
    project_id: maybeNull(
      randomString(
        usageStats.project_id_avg_len,
        usageStats.project_id_min_len,
        usageStats.project_id_max_len
      ),
      usageStats.project_id_null_pct
    ),
  };

  const metadata: UsageMetaData = {
    id,
    message_id: randomString(
      metaStats.message_id_avg_len,
      metaStats.message_id_min_len,
      metaStats.message_id_max_len
    ),
    created_at,
    http_user_agent: maybeNull(
      pickRandom(uniquePools.userAgents, Math.random()),
      metaStats.http_user_agent_id_null_pct
    ),
    http_x_forwarded_for: maybeNull(
      pickRandom(uniquePools.ips, Math.random()),
      metaStats.http_ip_id_null_pct
    ),
    http_x_vercel_ip_country: maybeNull(
      pickRandom(uniquePools.countries, Math.random()),
      metaStats.vercel_ip_country_id_null_pct
    ),
    http_x_vercel_ip_city: maybeNull(
      pickRandom(uniquePools.cities, Math.random()),
      metaStats.vercel_ip_city_id_null_pct
    ),
    http_x_vercel_ip_latitude: maybeNull(
      Math.random() * 180 - 90,
      metaStats.vercel_ip_latitude_null_pct
    ),
    http_x_vercel_ip_longitude: maybeNull(
      Math.random() * 360 - 180,
      metaStats.vercel_ip_longitude_null_pct
    ),
    http_x_vercel_ja4_digest: maybeNull(
      pickRandom(uniquePools.ja4Digests, Math.random()),
      metaStats.ja4_digest_id_null_pct
    ),
    user_prompt_prefix: maybeNull(
      randomString(
        metaStats.user_prompt_prefix_avg_len,
        metaStats.user_prompt_prefix_min_len,
        metaStats.user_prompt_prefix_max_len
      ),
      metaStats.user_prompt_prefix_null_pct
    ),
    system_prompt_prefix: maybeNull(
      pickRandom(uniquePools.systemPromptPrefixes, Math.random()),
      metaStats.system_prompt_prefix_id_null_pct
    ),
    system_prompt_length: maybeNull(
      randomInt(
        metaStats.system_prompt_length_avg,
        metaStats.system_prompt_length_min,
        metaStats.system_prompt_length_max
      ),
      metaStats.system_prompt_length_null_pct
    ),
    max_tokens: maybeNull(randomInt(metaStats.max_tokens_avg), metaStats.max_tokens_null_pct),
    has_middle_out_transform: maybeNull(
      Math.random() < 0.5,
      metaStats.has_middle_out_transform_null_pct
    ),
    status_code: maybeNull(200, 10),
    upstream_id: maybeNull(randomString(20, 10, 30), 50),
    finish_reason: maybeNull('stop', 20),
    latency: maybeNull(Math.random() * 5000, 30),
    moderation_latency: maybeNull(Math.random() * 100, 50),
    generation_time: maybeNull(Math.random() * 3000, 30),
    is_byok: maybeNull(Math.random() < 0.1, 20),
    is_user_byok: Math.random() < 0.05,
    streamed: maybeNull(Math.random() < 0.8, 10),
    cancelled: maybeNull(Math.random() < 0.05, 50),
    editor_name: maybeNull(pickRandom(['vscode', 'cursor', 'windsurf', 'vim'], Math.random()), 30),
    has_tools: maybeNull(Math.random() < 0.3, 20),
    machine_id: maybeNull(`machine-${Math.random().toString(36).substring(2, 10)}`, 40),
  };

  return { core, metadata };
}

function generateStringPool(
  count: number,
  avgLen: number,
  minLen: number,
  maxLen: number,
  totalRows: number
): string[] {
  const scaledCount = scaleUniqueCount(count, totalRows);
  const pool: string[] = [];
  for (let i = 0; i < scaledCount; i++) {
    pool.push(randomString(avgLen, minLen, maxLen));
  }
  return pool;
}

async function truncateTables() {
  console.log('Truncating tables and cleaning up benchmark users...');
  await db.execute(sql`TRUNCATE TABLE microdollar_usage_metadata CASCADE`);
  await db.execute(sql`TRUNCATE TABLE microdollar_usage CASCADE`);
  await db.execute(sql`TRUNCATE TABLE http_user_agent CASCADE`);
  await db.execute(sql`TRUNCATE TABLE http_ip CASCADE`);
  await db.execute(sql`TRUNCATE TABLE vercel_ip_country CASCADE`);
  await db.execute(sql`TRUNCATE TABLE vercel_ip_city CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ja4_digest CASCADE`);
  await db.execute(sql`TRUNCATE TABLE system_prompt_prefix CASCADE`);
  await db.execute(
    sql`DELETE FROM kilocode_users WHERE google_user_email LIKE 'benchmark-%@test.local'`
  );
  console.log('Tables truncated and benchmark users deleted.');
}

async function createTestUser(): Promise<string> {
  const userId = randomUUID();
  await db.execute(sql`
    INSERT INTO kilocode_users (id, google_user_email, google_user_name, google_user_image_url, stripe_customer_id, orb_customer_id, microdollars_used)
    VALUES (${userId}, ${`benchmark-${userId}@test.local`}, ${'Benchmark User'}, ${''}, ${`stripe-test-${userId}`}, ${`orb-test-${userId}`}, 0)
  `);
  return userId;
}

async function createTestUsers(count: number): Promise<string[]> {
  console.log(`Creating ${count} test users...`);
  const userIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const userId = await createTestUser();
    userIds.push(userId);
    if ((i + 1) % 50 === 0) {
      console.log(`  Created ${i + 1}/${count} users`);
    }
  }
  return userIds;
}

type RecordPair = { core: MicrodollarUsage; metadata: UsageMetaData };

type WorkerResult = { inserted: number; elapsedMs: number };

type WorkerMessage =
  | { type: 'progress'; workerId: number; inserted: number; total: number; rate: string }
  | { type: 'done'; workerId: number; inserted: number; elapsedMs: number }
  | { type: 'error'; workerId: number; error: string };

function runWorker(records: RecordPair[], workerId: number): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, 'benchmark-worker.ts');
    const worker = new Worker(workerPath, {
      workerData: { records, workerId },
      execArgv: ['--require', 'tsx/cjs'],
    });

    worker.on('message', (msg: WorkerMessage) => {
      if (msg.type === 'progress') {
        console.log(
          `Worker ${msg.workerId}: ${msg.inserted}/${msg.total} records (${msg.rate} rec/s)`
        );
      } else if (msg.type === 'done') {
        resolve({ inserted: msg.inserted, elapsedMs: msg.elapsedMs });
      } else if (msg.type === 'error') {
        reject(new Error(`Worker ${msg.workerId} error: ${msg.error}`));
      }
    });

    worker.on('error', reject);
    worker.on('exit', code => {
      if (code !== 0) reject(new Error(`Worker ${workerId} exited with code ${code}`));
    });
  });
}

async function runBenchmark() {
  const numWorkers = Math.max(1, Math.floor(cpus().length / 2));
  const totalRows = stats.microdollar_usage.total_rows;
  const dedup = stats.deduplication_tables;

  console.log(
    `Starting benchmark with ${numWorkers} worker threads, ${TOTAL_RECORDS} total records`
  );
  console.log(`Each worker will insert ~${Math.floor(TOTAL_RECORDS / numWorkers)} records`);

  // Truncate tables before benchmark
  await truncateTables();

  // Calculate scaled user count
  const scaledUserCount = scaleUniqueCount(stats.microdollar_usage.unique_user_count, totalRows);
  console.log(
    `Scaled user count: ${scaledUserCount} (from ${stats.microdollar_usage.unique_user_count} unique users in ${totalRows} rows)`
  );

  // Create test users
  const userIds = await createTestUsers(scaledUserCount);

  // Generate unique pools
  console.log('Generating unique value pools...');
  const uniquePools: UniquePools = {
    userAgents: generateStringPool(
      dedup.http_user_agent_count,
      dedup.http_user_agent_avg_len,
      dedup.http_user_agent_min_len,
      dedup.http_user_agent_max_len,
      totalRows
    ),
    ips: generateStringPool(
      dedup.http_ip_count,
      dedup.http_ip_avg_len,
      dedup.http_ip_min_len,
      dedup.http_ip_max_len,
      totalRows
    ),
    countries: generateStringPool(
      dedup.vercel_ip_country_count,
      dedup.vercel_ip_country_avg_len,
      dedup.vercel_ip_country_min_len,
      dedup.vercel_ip_country_max_len,
      totalRows
    ),
    cities: generateStringPool(
      dedup.vercel_ip_city_count,
      dedup.vercel_ip_city_avg_len,
      dedup.vercel_ip_city_min_len,
      dedup.vercel_ip_city_max_len,
      totalRows
    ),
    ja4Digests: generateStringPool(
      dedup.ja4_digest_count,
      dedup.ja4_digest_avg_len,
      dedup.ja4_digest_min_len,
      dedup.ja4_digest_max_len,
      totalRows
    ),
    systemPromptPrefixes: generateStringPool(
      dedup.system_prompt_prefix_count,
      dedup.system_prompt_prefix_avg_len,
      dedup.system_prompt_prefix_min_len,
      dedup.system_prompt_prefix_max_len,
      totalRows
    ),
    userIds,
  };
  console.log(
    `Generated pools: ${uniquePools.userAgents.length} user agents, ${uniquePools.ips.length} IPs, ${uniquePools.cities.length} cities, ${uniquePools.userIds.length} users`
  );

  // Pre-generate records for each worker
  console.log(`Pre-generating ${TOTAL_RECORDS} records...`);
  const workerRecords: RecordPair[][] = Array.from({ length: numWorkers }, (_, i) => {
    const count =
      Math.floor((TOTAL_RECORDS * (i + 1)) / numWorkers) -
      Math.floor((TOTAL_RECORDS * i) / numWorkers);
    return Array.from({ length: count }, () => generateRandomRecord(stats, uniquePools));
  });
  console.log(`Pre-generated records for ${numWorkers} workers`);

  const startTime = performance.now();
  const cpuStart = process.cpuUsage();

  // Run workers in parallel
  const results = await Promise.all(workerRecords.map((records, i) => runWorker(records, i)));

  const elapsed = (performance.now() - startTime) / 1000;
  const cpuEnd = process.cpuUsage(cpuStart);
  const memUsage = process.memoryUsage();
  const totalInserted = results.reduce((a, r) => a + r.inserted, 0);
  const avgWorkerElapseMs = results.reduce((a, r) => a + r.elapsedMs, 0) / results.length;
  const workerRatePerS = (totalInserted / avgWorkerElapseMs) * 1000;
  const rate = totalInserted / elapsed;

  console.log(`\nBenchmark complete:`);
  console.log(`  Total records: ${totalInserted}`);
  console.log(`  Wall time: ${elapsed.toFixed(2)}s`);
  console.log(`  Rate (wall): ${rate.toFixed(1)} records/second`);
  console.log(`  Rate (sum of workers): ${workerRatePerS.toFixed(1)} records/second`);
  console.log(
    `  Harness overhead: ${(((workerRatePerS - rate) / workerRatePerS) * 100).toFixed(1)}%`
  );
  console.log(
    `  Process CPU time: user=${(cpuEnd.user / 1_000_000).toFixed(2)}s, system=${(cpuEnd.system / 1_000_000).toFixed(2)}s`
  );
  console.log(
    `  Memory: heap=${(memUsage.heapUsed / 1024 / 1024).toFixed(1)}MB, rss=${(memUsage.rss / 1024 / 1024).toFixed(1)}MB`
  );
  console.log(`  Workers: ${numWorkers}`);

  await truncateTables();
}

runBenchmark()
  .catch(err => {
    console.error('Fatal error:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await closeAllDrizzleConnections();
      await shutdownPosthog();
    } catch (err) {
      console.error('Error during cleanup:', err);
    }
  });
