import { sql } from 'drizzle-orm';
import type { WorkerDb } from '../lib/db.js';

const FREE_MODEL_RATE_LIMIT_WINDOW_HOURS = 1;
const FREE_MODEL_MAX_REQUESTS_PER_WINDOW = 200;

export async function checkFreeModelRateLimit(
  ipAddress: string,
  db: WorkerDb
): Promise<{ allowed: boolean; requestCount: number }> {
  const result = await db.execute<{ count: string }>(sql`
    SELECT COUNT(*) as count
    FROM free_model_usage
    WHERE ip_address = ${ipAddress}
      AND created_at > NOW() - INTERVAL '${sql.raw(String(FREE_MODEL_RATE_LIMIT_WINDOW_HOURS))} hours'
  `);

  const requestCount = Number(result.rows[0]?.count ?? 0);
  return {
    allowed: requestCount < FREE_MODEL_MAX_REQUESTS_PER_WINDOW,
    requestCount,
  };
}

export async function logFreeModelRequest(
  ipAddress: string,
  model: string,
  userId: string | undefined,
  db: WorkerDb
): Promise<void> {
  await db.execute(sql`
    INSERT INTO free_model_usage (ip_address, model, kilo_user_id)
    VALUES (${ipAddress}, ${model}, ${userId ?? null})
  `);
}

export async function checkPromotionLimit(
  ipAddress: string,
  maxRequests: number,
  windowHours: number,
  db: WorkerDb
): Promise<{ allowed: boolean; requestCount: number }> {
  const result = await db.execute<{ count: string }>(sql`
    SELECT COUNT(*) as count
    FROM free_model_usage
    WHERE ip_address = ${ipAddress}
      AND created_at > NOW() - INTERVAL '${sql.raw(String(windowHours))} hours'
  `);

  const requestCount = Number(result.rows[0]?.count ?? 0);
  return {
    allowed: requestCount < maxRequests,
    requestCount,
  };
}
