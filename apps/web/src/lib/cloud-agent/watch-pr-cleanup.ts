import 'server-only';

import { and, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import {
  cli_sessions_v2,
  cloud_agent_pr_watch_activity,
  cloud_agent_pr_watches,
} from '@kilocode/db/schema';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';

export const watchPrRetentionDays = 30;

export async function deleteWatchPrRecords(tx: DrizzleTransaction, condition: SQL | undefined) {
  if (!condition) throw new Error('A watch deletion condition is required');
  const deleted = await tx
    .delete(cloud_agent_pr_watches)
    .where(condition)
    .returning({ id: cloud_agent_pr_watches.id });
  if (deleted.length)
    await tx
      .update(cli_sessions_v2)
      .set({
        maintenance_watch_id: null,
        maintenance_attempt_id: null,
        updated_at: cli_sessions_v2.updated_at,
      })
      .where(
        inArray(
          cli_sessions_v2.maintenance_watch_id,
          deleted.map(watch => watch.id)
        )
      );
  return deleted.length;
}

export async function cleanupWatchPrData(now = new Date()) {
  const cutoff = new Date(
    now.getTime() - watchPrRetentionDays * 24 * 60 * 60 * 1_000
  ).toISOString();

  const activity = await db
    .delete(cloud_agent_pr_watch_activity)
    .where(
      and(
        lt(cloud_agent_pr_watch_activity.created_at, cutoff),
        sql`NOT (${cloud_agent_pr_watch_activity.kind} = 'reply' AND EXISTS (SELECT 1 FROM ${cloud_agent_pr_watches} WHERE ${cloud_agent_pr_watches.id} = ${cloud_agent_pr_watch_activity.watch_id} AND ${cloud_agent_pr_watches.status} <> 'finished'))`
      )
    );
  const deletedWatchCount = await db.transaction(tx =>
    deleteWatchPrRecords(
      tx,
      and(
        eq(cloud_agent_pr_watches.status, 'finished'),
        lt(
          sql`coalesce(${cloud_agent_pr_watches.finished_at}, ${cloud_agent_pr_watches.updated_at})`,
          cutoff
        )
      )
    )
  );

  return {
    cutoff,
    deletedActivityCount: activity.rowCount ?? 0,
    deletedWatchCount,
  };
}
