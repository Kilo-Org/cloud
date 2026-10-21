import 'server-only';

import { lt } from 'drizzle-orm';
import { cloud_agent_pr_watch_activity, cloud_agent_pr_watches } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';

export const watchPrRetentionDays = 30;

export async function cleanupWatchPrData(now = new Date()) {
  const cutoff = new Date(
    now.getTime() - watchPrRetentionDays * 24 * 60 * 60 * 1_000
  ).toISOString();

  const activity = await db
    .delete(cloud_agent_pr_watch_activity)
    .where(lt(cloud_agent_pr_watch_activity.created_at, cutoff));
  const watches = await db
    .delete(cloud_agent_pr_watches)
    .where(lt(cloud_agent_pr_watches.updated_at, cutoff));

  return {
    cutoff,
    deletedActivityCount: activity.rowCount ?? 0,
    deletedWatchCount: watches.rowCount ?? 0,
  };
}
