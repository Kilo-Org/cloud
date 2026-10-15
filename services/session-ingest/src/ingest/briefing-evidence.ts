import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getWorkerDb } from '@kilocode/db/client';
import { agent_briefing_events, cli_sessions_v2 } from '@kilocode/db/schema';
import { redactBriefingExcerpt } from '@kilocode/app-shared/agent-briefing';
import type { IngestBatch } from '../types/session-sync';
export type BriefingActivityEvent = { identity: string; occurredAt: string; excerpt?: string };
export type BriefingStatusEvent = {
  kind: 'status';
  identity: string;
  occurredAt: string;
  status: string;
  previousStatus: string | null;
  previousStatusKnown: boolean;
  transitionId?: string;
};
export type BriefingIngestEvent = BriefingActivityEvent | BriefingStatusEvent;

export function statusEvidence(items: IngestBatch): BriefingStatusEvent[] {
  return items.flatMap<BriefingStatusEvent>(item => {
    if (item.type !== 'session_status' || !item.data.occurredAt) return [];
    const status = item.data.status.trim();
    if (!status || !Number.isFinite(Date.parse(item.data.occurredAt))) return [];
    const occurredAt = new Date(item.data.occurredAt).toISOString();
    return [
      {
        kind: 'status',
        identity: `status:${item.data.transitionId ?? `${occurredAt}:${status}`}`,
        occurredAt,
        status,
        previousStatus: item.data.previousStatus ?? null,
        previousStatusKnown: typeof item.data.previousStatus === 'string',
        ...(item.data.transitionId ? { transitionId: item.data.transitionId } : {}),
      },
    ];
  });
}

const activityTimeSchema = z.object({
  created: z.unknown().optional(),
  completed: z.unknown().optional(),
  start: z.unknown().optional(),
  end: z.unknown().optional(),
});
const activityDataSchema = z.object({
  role: z.unknown().optional(),
  type: z.unknown().optional(),
  text: z.unknown().optional(),
  time: activityTimeSchema.nullish(),
  state: z
    .object({
      time: activityTimeSchema.nullish(),
      status: z.unknown().optional(),
      output: z.unknown().optional(),
      error: z.unknown().optional(),
    })
    .nullish(),
});

export function activityEvidence(items: IngestBatch, assistantMessageIds?: ReadonlySet<string>) {
  return items.flatMap(item => {
    if (item.type !== 'message' && item.type !== 'part') return [];
    const parsed = activityDataSchema.safeParse(item.data);
    if (!parsed.success) return [];
    const time = parsed.data.time;
    const stateTime = parsed.data.state?.time;
    const timestamps = [
      time?.created,
      time?.completed,
      time?.start,
      time?.end,
      stateTime?.start,
      stateTime?.end,
    ];
    const assistant =
      item.type === 'message'
        ? parsed.data.role === 'assistant'
        : assistantMessageIds?.has(item.data.messageID) === true ||
          items.some(
            message =>
              message.type === 'message' &&
              message.data.id === item.data.messageID &&
              message.data.role === 'assistant'
          );
    const state = parsed.data.state;
    const text =
      assistant && (item.type === 'message' || parsed.data.type === 'text')
        ? parsed.data.text
        : assistant &&
            parsed.data.type === 'tool' &&
            (state?.status === 'completed' || state?.status === 'error')
          ? state.status === 'error'
            ? state.error
            : state.output
          : undefined;
    const excerpt = typeof text === 'string' ? redactBriefingExcerpt(text).trim() : '';
    const excerptAt =
      item.type === 'message'
        ? time?.completed
        : parsed.data.type === 'tool'
          ? stateTime?.end
          : time?.end;
    return timestamps.flatMap(timestamp => {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return [];
      const date = new Date(timestamp);
      if (!Number.isFinite(date.getTime())) return [];
      const event: BriefingActivityEvent = {
        identity: `${item.type}:${item.data.id}:${timestamp}`,
        occurredAt: date.toISOString(),
      };
      if (excerpt && timestamp === excerptAt) event.excerpt = excerpt;
      return [event];
    });
  });
}

export async function persistBriefingEvidence(
  connectionString: string,
  userId: string,
  sessionId: string,
  events: BriefingIngestEvent[]
): Promise<void> {
  if (events.length === 0) return;
  const db = getWorkerDb(connectionString);
  await db.transaction(async tx => {
    const [session] = await tx
      .select({ organizationId: cli_sessions_v2.organization_id })
      .from(cli_sessions_v2)
      .where(
        and(eq(cli_sessions_v2.kilo_user_id, userId), eq(cli_sessions_v2.session_id, sessionId))
      )
      .for('update')
      .limit(1);
    // Ingest only runs for sessions that already have a row, so a missing row means the
    // session was deleted and its evidence cascades away; there is nothing to retry.
    if (!session) return;
    await tx
      .insert(agent_briefing_events)
      .values(
        events.map(event => ({
          id:
            'kind' in event
              ? JSON.stringify(
                  event.transitionId
                    ? [userId, sessionId, 'status', event.transitionId]
                    : [userId, sessionId, 'status', event.occurredAt, event.status]
                )
              : JSON.stringify([userId, sessionId, 'activity', event.identity]),
          kilo_user_id: userId,
          session_id: sessionId,
          organization_id: session.organizationId,
          kind: 'kind' in event ? 'status' : 'activity',
          status: 'kind' in event ? event.status : null,
          occurred_at: event.occurredAt,
          title: 'kind' in event ? null : 'Session activity',
          payload:
            'kind' in event
              ? {
                  previousStatus: event.previousStatus,
                  previousStatusKnown: event.previousStatusKnown,
                  ...(event.transitionId ? { transitionId: event.transitionId } : {}),
                }
              : event.excerpt
                ? { excerpt: redactBriefingExcerpt(event.excerpt) }
                : null,
        }))
      )
      .onConflictDoNothing();
  });
}
