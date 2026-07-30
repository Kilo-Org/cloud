import 'server-only';

import {
  kilo_pass_org_audit_records,
  kilo_pass_org_issuance_snapshots,
  kilo_pass_org_qualifying_spend_events,
} from '@kilocode/db/schema';
import { KiloPassOrgBonusMode } from '@kilocode/db/schema-types';
import type { DrizzleTransaction } from '@/lib/drizzle';
import { and, eq, gte, isNull, lt, sql } from 'drizzle-orm';

export async function repairExpiredOrganizationPassBonuses(
  tx: DrizzleTransaction,
  nowIso: string
): Promise<{ examined: number; recordedMisses: number }> {
  const snapshots = await tx
    .select()
    .from(kilo_pass_org_issuance_snapshots)
    .where(
      and(
        eq(kilo_pass_org_issuance_snapshots.bonus_mode, KiloPassOrgBonusMode.AfterBase),
        isNull(kilo_pass_org_issuance_snapshots.bonus_unlocked_at),
        lt(kilo_pass_org_issuance_snapshots.window_end, nowIso)
      )
    )
    .for('update');
  let recordedMisses = 0;

  for (const snapshot of snapshots) {
    const [total] = await tx
      .select({
        spent: sql<number>`coalesce(sum(${kilo_pass_org_qualifying_spend_events.spent_microdollars}), 0)`,
      })
      .from(kilo_pass_org_qualifying_spend_events)
      .where(
        and(
          eq(kilo_pass_org_qualifying_spend_events.issuance_snapshot_id, snapshot.id),
          gte(
            kilo_pass_org_qualifying_spend_events.occurred_at,
            snapshot.qualifying_spend_starts_at
          )
        )
      );
    const spent = Number(total?.spent ?? 0);
    if (spent < snapshot.unlock_spend_microdollars) continue;

    await tx
      .update(kilo_pass_org_issuance_snapshots)
      .set({ qualifying_spend_microdollars: spent })
      .where(eq(kilo_pass_org_issuance_snapshots.id, snapshot.id));
    const recorded = await tx
      .insert(kilo_pass_org_audit_records)
      .values({
        agreement_id: snapshot.agreement_id,
        action: 'bonus_missed_after_expiry',
        reason: 'qualifying_spend_repair',
        after_json: { issuanceSnapshotId: snapshot.id, qualifyingSpendMicrodollars: spent },
        idempotency_key: `kpo:expired-bonus-miss:${snapshot.id}`,
      })
      .onConflictDoNothing()
      .returning({ id: kilo_pass_org_audit_records.id });
    if (recorded[0]) recordedMisses++;
  }
  return { examined: snapshots.length, recordedMisses };
}
