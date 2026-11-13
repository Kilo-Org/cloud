import 'server-only';
import { and, eq, lt } from 'drizzle-orm';
import { cloud_agent_pr_maintenance_attempts, cloud_agent_pr_watches } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { liveAttemptCondition } from './watch-pr-maintenance-store';
import { scheduleWatchPr } from './watch-pr-maintenance-client';

export async function scheduleMaintenanceTimer(watchId: string, dueAt: string) {
  try {
    await scheduleWatchPr(watchId, dueAt);
  } catch {
    /* The runtime cron recovers persisted due work. */
  }
}

export async function normalizeMaintenanceDue(watchId: string): Promise<string | null> {
  const watch = await db.query.cloud_agent_pr_watches.findFirst({
    where: eq(cloud_agent_pr_watches.id, watchId),
  });
  if (!watch) return null;
  const now = new Date();
  const retryAt = new Date(now.getTime() + 30_000).toISOString();
  const attempt = await db.query.cloud_agent_pr_maintenance_attempts.findFirst({
    where: and(eq(cloud_agent_pr_maintenance_attempts.watch_id, watchId), liveAttemptCondition),
  });
  if (attempt) {
    const dueAt =
      attempt.next_run_at && Date.parse(attempt.next_run_at) > now.getTime()
        ? new Date(attempt.next_run_at).toISOString()
        : retryAt;
    if (dueAt !== attempt.next_run_at)
      await db
        .update(cloud_agent_pr_maintenance_attempts)
        .set({ next_run_at: dueAt })
        .where(and(eq(cloud_agent_pr_maintenance_attempts.id, attempt.id), liveAttemptCondition));
    const nextRunAt = watch.status === 'watching' ? dueAt : null;
    await db
      .update(cloud_agent_pr_watches)
      .set({ next_run_at: nextRunAt })
      .where(
        and(
          eq(cloud_agent_pr_watches.id, watchId),
          eq(cloud_agent_pr_watches.generation, watch.generation)
        )
      );
    return nextRunAt;
  }
  if (watch.status !== 'watching') {
    await db
      .update(cloud_agent_pr_watches)
      .set({ next_run_at: null })
      .where(
        and(
          eq(cloud_agent_pr_watches.id, watchId),
          eq(cloud_agent_pr_watches.generation, watch.generation)
        )
      );
    return null;
  }
  if (!watch.next_run_at || Date.parse(watch.next_run_at) >= now.getTime())
    return watch.next_run_at;
  await db
    .update(cloud_agent_pr_watches)
    .set({ next_run_at: retryAt })
    .where(
      and(
        eq(cloud_agent_pr_watches.id, watchId),
        lt(cloud_agent_pr_watches.next_run_at, now.toISOString()),
        eq(cloud_agent_pr_watches.generation, watch.generation)
      )
    );
  return retryAt;
}
