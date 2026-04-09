import { db } from '@/lib/drizzle';
import { security_advisor_scans } from '@kilocode/db/schema';
import { and, count, eq, gte } from 'drizzle-orm';
import { RATE_LIMIT_PER_DAY } from './schemas';
import type { SecurityAdvisorRequest } from './schemas';

const WINDOW_HOURS = 24;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
}

/**
 * Check whether a user has exceeded the daily scan limit.
 * Queries the security_advisor_scans table — survives restarts, shared across replicas.
 */
export async function checkSecurityAdvisorRateLimit(userId: string): Promise<RateLimitResult> {
  const windowStart = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000);

  const usage = await db
    .select({ totalRequests: count() })
    .from(security_advisor_scans)
    .where(
      and(
        eq(security_advisor_scans.kilo_user_id, userId),
        gte(security_advisor_scans.created_at, windowStart.toISOString())
      )
    );

  const requestCount = Number(usage[0]?.totalRequests ?? 0);

  return {
    allowed: requestCount < RATE_LIMIT_PER_DAY,
    remaining: Math.max(0, RATE_LIMIT_PER_DAY - requestCount),
  };
}

/**
 * Record a security advisor scan. Called after the report is generated.
 * This row is both the rate-limit counter and the usage/analytics ledger.
 */
export async function recordSecurityAdvisorScan(
  userId: string,
  organizationId: string | undefined,
  payload: SecurityAdvisorRequest
): Promise<void> {
  await db.insert(security_advisor_scans).values({
    kilo_user_id: userId,
    organization_id: organizationId,
    source_platform: payload.source.platform,
    source_method: payload.source.method,
    plugin_version: payload.source.pluginVersion,
    openclaw_version: payload.source.openclawVersion,
    public_ip: payload.publicIp,
    findings_critical: payload.audit.summary.critical,
    findings_warn: payload.audit.summary.warn,
    findings_info: payload.audit.summary.info,
  });
}
