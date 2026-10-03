import { pool } from '@/lib/drizzle';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

const INTERVAL_MS = 5_000; // 30 seconds
const LOG_DIR = 'dev-debug-request-logs/pg_stat_activity';
const SOUND_FILE = '/System/Library/Sounds/Sosumi.aiff';
const ALERT_THRESHOLD = 100;

async function ensureLogDirectory(): Promise<void> {
  if (!existsSync(LOG_DIR)) {
    await mkdir(LOG_DIR, { recursive: true });
    console.log(`📁 Created log directory: ${LOG_DIR}`);
  }
}

async function playAlertSound(): Promise<void> {
  try {
    await execAsync(`afplay ${SOUND_FILE}`);
    console.log('🔊 Alert sound played');
  } catch (error) {
    console.error('❌ Failed to play alert sound:', error);
  }
}

let iter = 0;

async function monitorActivity(): Promise<void> {
  try {
    iter++;
    const result = await pool.query('SELECT * FROM pg_stat_activity');
    const rows = result.rows;
    const rowCount = rows.length;
    if (rowCount < ALERT_THRESHOLD && iter % 12 !== 0) {
      return;
    }
    // Create filename with ISO timestamp (path-safe) and row count
    const isoTimestamp = new Date().toISOString().replace(/:/g, '-');
    const filename = `log_${isoTimestamp}__${rowCount}.json`;
    const filepath = path.join(LOG_DIR, filename);

    // Write to file (with BigInt serialization support)
    await writeFile(
      filepath,
      JSON.stringify(
        rows,
        (_, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
        2
      )
    );

    const now = new Date().toISOString();
    console.log(`[${now}] 📊 Logged ${rowCount} active connections to ${filename}`);

    // Play alert if threshold exceeded
    if (rowCount >= ALERT_THRESHOLD) {
      console.log(
        `⚠️  WARNING: Connection count (${rowCount}) reached threshold (${ALERT_THRESHOLD})`
      );
      await playAlertSound();
    }
  } catch (error) {
    console.error('❌ Error monitoring pg_stat_activity:', error);
  }
}

async function run(): Promise<void> {
  console.log('🚀 Starting PostgreSQL activity monitor');
  console.log(`📍 Log directory: ${LOG_DIR}`);
  console.log(`⏱️  Interval: ${INTERVAL_MS / 1000} seconds`);
  console.log(`🔔 Alert threshold: ${ALERT_THRESHOLD} connections`);
  console.log(`🎵 Alert sound: ${SOUND_FILE}`);
  console.log('Press Ctrl+C to stop\n');

  await ensureLogDirectory();

  // Run immediately
  await monitorActivity();

  // Then run every 30 seconds
  const intervalId = setInterval(monitorActivity, INTERVAL_MS);

  process.on('SIGINT', async () => {
    console.log('\n\n🛑 Received SIGINT, shutting down...');
    clearInterval(intervalId);
    await pool.end();
    console.log('✅ Connection pool closed');
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n\n🛑 Received SIGTERM, shutting down...');
    clearInterval(intervalId);
    await pool.end();
    console.log('✅ Connection pool closed');
    process.exit(0);
  });
}

run().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
