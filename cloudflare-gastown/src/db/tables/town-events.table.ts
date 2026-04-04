import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const TownEventType = z.enum([
  'agent_done',
  'agent_completed',
  'container_status',
  'container_eviction',
  'pr_status_changed',
  'bead_created',
  'bead_cancelled',
  'convoy_started',
  'nudge_timeout',
  'pr_feedback_detected',
  'pr_auto_merge',
]);

export type TownEventType = z.output<typeof TownEventType>;

export const TownEventRecord = z.object({
  event_id: z.string(),
  event_type: TownEventType,
  agent_id: z.string().nullable(),
  bead_id: z.string().nullable(),
  payload: z
    .string()
    .transform((v, ctx): Record<string, unknown> => {
      try {
        return JSON.parse(v) as Record<string, unknown>;
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid JSON in payload' });
        return {};
      }
    })
    .pipe(z.record(z.string(), z.unknown())),
  created_at: z.string(),
  processed_at: z.string().nullable(),
});

export type TownEventRecord = z.output<typeof TownEventRecord>;

export const town_events = getTableFromZodSchema('town_events', TownEventRecord);

export function createTableTownEvents(): string {
  return getCreateTableQueryFromTable(town_events, {
    event_id: `text primary key`,
    event_type: `text not null`,
    agent_id: `text`,
    bead_id: `text`,
    payload: `text not null default '{}'`,
    created_at: `text not null`,
    processed_at: `text`,
  });
}

export function getIndexesTownEvents(): string[] {
  return [
    `CREATE INDEX IF NOT EXISTS idx_town_events_pending ON ${town_events}(${town_events.columns.created_at}) WHERE ${town_events.columns.processed_at} IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_town_events_type ON ${town_events}(${town_events.columns.event_type})`,
  ];
}
