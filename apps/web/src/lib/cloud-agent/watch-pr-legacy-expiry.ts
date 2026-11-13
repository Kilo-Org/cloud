import 'server-only';
import { and, eq, ne, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import {
  cloud_agent_pr_watch_activity,
  cloud_agent_pr_watches,
  type CloudAgentPrWatch,
} from '@kilocode/db/schema';
import type { WatchPrPolicy } from '@kilocode/db/cloud-agent-pr-maintenance';
import { db } from '@kilocode/web-shared/lib/drizzle';

export const expiredLegacyWatchCondition = sql`${cloud_agent_pr_watches.policy}->>'version' = '1' AND (${cloud_agent_pr_watches.expires_at} IS NULL OR ${cloud_agent_pr_watches.expires_at} <= now())`;
export const unexpiredWatchConsentCondition = sql`NOT (${expiredLegacyWatchCondition})`;

export function isLegacyWatchExpired(
  watch: Pick<CloudAgentPrWatch, 'policy' | 'expires_at'>,
  now = Date.now()
) {
  return watch.policy.version === 1 && (!watch.expires_at || Date.parse(watch.expires_at) <= now);
}

export function watchPrConsentExpiry(policy: WatchPrPolicy, expiresAt?: string, now = Date.now()) {
  if (policy.version === 2) return null;
  const expiry = expiresAt ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 86_400_000)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Observation-only consent must expire within the next 24 hours',
    });
  return new Date(expiry).toISOString();
}

export async function finishExpiredLegacyWatches(watchId?: string) {
  await db.transaction(async tx => {
    const rows = await tx
      .select()
      .from(cloud_agent_pr_watches)
      .where(
        and(
          ne(cloud_agent_pr_watches.status, 'finished'),
          expiredLegacyWatchCondition,
          watchId ? eq(cloud_agent_pr_watches.id, watchId) : undefined
        )
      )
      .limit(20)
      .for('update', { skipLocked: true });
    for (const watch of rows) {
      const now = new Date().toISOString();
      await tx
        .update(cloud_agent_pr_watches)
        .set({
          status: 'finished',
          generation: watch.generation + 1,
          lifecycle_reason: 'expired',
          finished_at: now,
          next_run_at: null,
          pending_since: null,
          updated_at: now,
          projection: sql`jsonb_set(jsonb_set(${cloud_agent_pr_watches.projection}, '{pending}', '[]'::jsonb), '{needsAttention}', 'false'::jsonb)`,
        })
        .where(eq(cloud_agent_pr_watches.id, watch.id));
      await tx.insert(cloud_agent_pr_watch_activity).values({
        watch_id: watch.id,
        generation: watch.generation + 1,
        kind: 'finished',
        reason: 'expired',
      });
    }
  });
}
