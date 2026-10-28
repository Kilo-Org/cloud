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
    const index = accounting.data.generations.findIndex(entry => entry.id === input.generationId);
    const generation = accounting.data.generations[index];
    if (
      !generation ||
      generation.settlementToken !== input.settlementToken ||
      generation.usageId !== null ||
      accounting.data.generations.some(
        (entry, otherIndex) => otherIndex !== index && entry.id === input.generationId
      )
    ) {
      return;
    }

    const path = sql`ARRAY['chargeAccounting', 'generations', ${String(index)}]::text[]`;
    const receipt = JSON.stringify({ usageId: usage.usageId, delivery, deliveryAt });
    await tx
      .update(agent_briefing_snapshots)
      .set({
        summary: sql`jsonb_set(${agent_briefing_snapshots.summary}, ${path}, coalesce(${agent_briefing_snapshots.summary} #> ${path}, '{}'::jsonb) || ${receipt}::jsonb)`,
      })
      .where(eq(agent_briefing_snapshots.id, report.id));
  });
}
