import type { WorkerDb } from '@kilocode/db/client';
import {
  agent_briefing_preferences,
  agent_briefing_context_preferences,
  agent_briefing_snapshots,
  organization_memberships,
} from '@kilocode/db/schema';
import {
  agentBriefingDispatchWindowSchema,
  type DispatchPushInput,
  type DispatchPushOutcome,
} from '@kilocode/notifications';
import { and, eq, gt, isNotNull, isNull, lte, ne, or } from 'drizzle-orm';
import { z } from 'zod';

const activeReportFactsSchema = z.object({
  scorecard: z.object({ sessions: z.number().int().positive() }),
});

export async function agentBriefingDispatchGate(
  db: WorkerDb,
  input: DispatchPushInput,
  now: () => number = Date.now
): Promise<DispatchPushOutcome | null> {
  if (input.push.data.type !== 'agent_briefing') return null;
  const window = agentBriefingDispatchWindowSchema.safeParse(input.agentBriefing);
  if (!window.success || Date.parse(window.data.expiresAt) <= now()) {
    return { kind: 'suppressed_expired' };
  }

  try {
    const [preference] = await db
      .select({ enabled: agent_briefing_preferences.notifications_enabled })
      .from(agent_briefing_preferences)
      .where(eq(agent_briefing_preferences.kilo_user_id, input.userId))
      .limit(1);
    if (preference?.enabled !== true) return { kind: 'suppressed_preference' };

    const currentTime = new Date(now()).toISOString();
    const reports = await db
      .select({
        facts: agent_briefing_snapshots.facts,
        morningEndAt: agent_briefing_snapshots.morning_end_at,
      })
      .from(agent_briefing_snapshots)
      .innerJoin(
        agent_briefing_context_preferences,
        and(
          eq(
            agent_briefing_context_preferences.kilo_user_id,
            agent_briefing_snapshots.kilo_user_id
          ),
          eq(agent_briefing_context_preferences.context_key, agent_briefing_snapshots.context_key),
          eq(agent_briefing_context_preferences.enabled, true)
        )
      )
      .leftJoin(
        organization_memberships,
        and(
          eq(organization_memberships.organization_id, agent_briefing_snapshots.organization_id),
          eq(organization_memberships.kilo_user_id, input.userId),
          ne(organization_memberships.role, 'billing_manager')
        )
      )
      .where(
        and(
          eq(agent_briefing_snapshots.kilo_user_id, input.userId),
          eq(agent_briefing_snapshots.local_date, window.data.localDate),
          isNotNull(agent_briefing_snapshots.published_at),
          isNull(agent_briefing_snapshots.dismissed_at),
          lte(agent_briefing_snapshots.cutoff_at, currentTime),
          gt(agent_briefing_snapshots.morning_end_at, currentTime),
          or(
            isNull(agent_briefing_snapshots.organization_id),
            isNotNull(organization_memberships.kilo_user_id)
          )
        )
      );
    if (Date.parse(window.data.expiresAt) <= now()) return { kind: 'suppressed_expired' };
    if (
      !reports.some(
        report =>
          Date.parse(report.morningEndAt) > now() &&
          activeReportFactsSchema.safeParse(report.facts).success
      )
    ) {
      return { kind: 'suppressed_access' };
    }
    return null;
  } catch {
    return { kind: 'failed', error: 'Briefing eligibility read failed' };
  }
}

// A morning can outlive the channel's ordinary one-hour idempotency retention.
export function pushIdempotencyTtlMs(storageKey: string): number {
  return storageKey.startsWith('idem:agent-briefing:') ? 48 * 60 * 60 * 1000 : 60 * 60 * 1000;
}
