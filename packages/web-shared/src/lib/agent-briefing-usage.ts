import 'server-only';
import * as z from 'zod';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { agent_briefing_reports } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import type { UsageAccountingResult } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';

export const BRIEFING_SETTLEMENT_HEADER = 'X-Kilo-Briefing-Settlement';

export const briefingChargeAccountingSchema = z.object({
  baselineCostMicrodollars: z.number().nonnegative(),
  generations: z.array(
    z.object({
      id: z.string(),
      settlementToken: z.string().optional(),
      usageId: z.uuid().nullable(),
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

  await db.transaction(async tx => {
    const [report] = await tx
      .select({ id: agent_briefing_reports.id, summary: agent_briefing_reports.summary })
      .from(agent_briefing_reports)
      .where(
        and(
          eq(agent_briefing_reports.generation_id, input.generationId),
          eq(agent_briefing_reports.kilo_user_id, input.kiloUserId),
          input.organizationId === undefined
            ? isNull(agent_briefing_reports.organization_id)
            : eq(agent_briefing_reports.organization_id, input.organizationId)
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

    await tx
      .update(agent_briefing_reports)
      .set({
        summary: sql`jsonb_set(${agent_briefing_reports.summary}, ARRAY['chargeAccounting', 'generations', ${String(index)}, 'usageId']::text[], ${JSON.stringify(usage.usageId)}::jsonb)`,
      })
      .where(eq(agent_briefing_reports.id, report.id));
  });
}
