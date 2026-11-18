import 'server-only';
import * as z from 'zod';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { agent_briefing_snapshots } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import type { UsageAccountingResult } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';

export const BRIEFING_SETTLEMENT_HEADER = 'X-Kilo-Briefing-Settlement';

/**
 * What the gateway reported for a generation's usage write. `committed` means the
 * row was written before the response; `queued` means only queue acceptance is
 * known.
 */
export const briefingChargeDeliverySchema = z.enum(['committed', 'queued']);

export const briefingChargeAccountingSchema = z.object({
  baselineCostMicrodollars: z.number().nonnegative(),
  generations: z.array(
    z.object({
      id: z.string(),
      settlementToken: z.string().optional(),
      usageId: z.uuid().nullable(),
      deadlineAt: z.string().datetime().optional(),
      deliveryAt: z.string().datetime().optional(),
      delivery: briefingChargeDeliverySchema.optional(),
    })
  ),
});

export async function recordBriefingUsage(input: {
  kiloUserId: string;
  organizationId?: string;
  generationId: string;
  settlementToken: string;
  usage: UsageAccountingResult | null;
}): Promise<void> {
  const usage = input.usage;
  if (!usage || !input.settlementToken || !z.uuid().safeParse(usage.usageId).success) return;
  const delivery = usage.status === 'queued' ? 'queued' : 'committed';
  // Queue acceptance precedes this receipt, so it anchors a full retention window.
  const deliveryAt = new Date().toISOString();

  // The gateway runs in sfo1 while db is the Frankfurt primary: this is the rare
  // post-response write for a briefing request, and it takes a row lock so the
  // receipt cannot land on a report whose generation has already moved on.
  await db.transaction(async tx => {
    const [report] = await tx
      .select({ id: agent_briefing_snapshots.id, summary: agent_briefing_snapshots.summary })
      .from(agent_briefing_snapshots)
      .where(
        and(
          eq(agent_briefing_snapshots.generation_id, input.generationId),
          eq(agent_briefing_snapshots.kilo_user_id, input.kiloUserId),
          input.organizationId === undefined
            ? isNull(agent_briefing_snapshots.organization_id)
            : eq(agent_briefing_snapshots.organization_id, input.organizationId)
        )
      )
      .for('update');
    if (!report) return;

    const accounting = briefingChargeAccountingSchema.safeParse(report.summary.chargeAccounting);
    if (!accounting.success) return;
    // Repeated generation IDs are distinct charged attempts, keeping deployed readers compatible.
    let emptyIndex = -1;
    let deadlineAt: string | undefined;
    let matched = false;
    for (const [index, entry] of accounting.data.generations.entries()) {
      if (entry.id !== input.generationId) continue;
      if (entry.settlementToken !== input.settlementToken) return;
      if (entry.usageId === usage.usageId) return;
      matched = true;
      deadlineAt ??= entry.deadlineAt;
      if (entry.usageId === null) {
        if (emptyIndex !== -1) return;
        emptyIndex = index;
      }
    }
    if (!matched) return;

    const receipt = { usageId: usage.usageId, delivery, deliveryAt };
    if (emptyIndex !== -1) {
      const path = sql`ARRAY['chargeAccounting', 'generations', ${String(emptyIndex)}]::text[]`;
      await tx
        .update(agent_briefing_snapshots)
        .set({
          next_charge_check_at: deliveryAt,
          summary: sql`jsonb_set(${agent_briefing_snapshots.summary} || '{"chargeStatus":"pending"}'::jsonb, ${path}, coalesce(${agent_briefing_snapshots.summary} #> ${path}, '{}'::jsonb) || ${JSON.stringify(receipt)}::jsonb)`,
        })
        .where(eq(agent_briefing_snapshots.id, report.id));
      return;
    }
    const path = sql`ARRAY['chargeAccounting', 'generations']::text[]`;
    const entry = JSON.stringify([
      {
        id: input.generationId,
        settlementToken: input.settlementToken,
        deadlineAt,
        ...receipt,
      },
    ]);
    await tx
      .update(agent_briefing_snapshots)
      .set({
        next_charge_check_at: deliveryAt,
        summary: sql`jsonb_set(${agent_briefing_snapshots.summary} || '{"chargeStatus":"pending"}'::jsonb, ${path}, coalesce(${agent_briefing_snapshots.summary} #> ${path}, '[]'::jsonb) || ${entry}::jsonb)`,
      })
      .where(eq(agent_briefing_snapshots.id, report.id));
  });
}
