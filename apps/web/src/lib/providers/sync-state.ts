import 'server-only';

import { ai_gateway_sync_providers_state } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { eq } from 'drizzle-orm';

// The sync crons run every 5 minutes, so an hour without a completed run means a dozen missed runs.
export const SYNC_JOB_STALE_AFTER_MS = 60 * 60 * 1000;

const LAST_COMPLETED_COLUMNS = {
  providers: 'last_completed_at',
  direct_byok: 'direct_byok_last_completed_at',
} as const satisfies Record<string, keyof typeof ai_gateway_sync_providers_state.$inferSelect>;

export type SyncJobId = keyof typeof LAST_COMPLETED_COLUMNS;

export function parseIsoTimestamp(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function isSyncStale(lastCompletedAt: Date | null, now: Date): boolean {
  return (
    lastCompletedAt !== null && now.getTime() - lastCompletedAt.getTime() >= SYNC_JOB_STALE_AFTER_MS
  );
}

async function writeLatestTimestamp(
  column: (typeof LAST_COMPLETED_COLUMNS)[SyncJobId],
  iso: string
) {
  return db.transaction(async tx => {
    await tx.insert(ai_gateway_sync_providers_state).values({ id: 1 }).onConflictDoNothing();
    const [row] = await tx
      .select({ value: ai_gateway_sync_providers_state[column] })
      .from(ai_gateway_sync_providers_state)
      .where(eq(ai_gateway_sync_providers_state.id, 1))
      .for('update');
    if (!row) throw new Error('Sync-providers state row is missing');

    const current = parseIsoTimestamp(row.value);
    const requested = new Date(iso);
    const latestIso = current && current > requested ? current.toISOString() : iso;
    await tx
      .update(ai_gateway_sync_providers_state)
      .set({ [column]: latestIso })
      .where(eq(ai_gateway_sync_providers_state.id, 1));
    return latestIso;
  });
}

export async function recordSyncCompleted(jobId: SyncJobId): Promise<string> {
  const completedAt = new Date().toISOString();
  await writeLatestTimestamp(LAST_COMPLETED_COLUMNS[jobId], completedAt);
  return completedAt;
}
