import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const BeadEventType = z.enum([
  'created',
  'assigned',
  'hooked',
  'unhooked',
  'status_changed',
  'closed',
  'escalated',
  'mail_sent',
  'review_submitted',
  'review_completed',
  'agent_spawned',
  'agent_exited',
]);

export type BeadEventType = z.infer<typeof BeadEventType>;

export const BeadEventRecord = z.object({
  id: z.string(),
  bead_id: z.string(),
  agent_id: z.string().nullable(),
  event_type: BeadEventType,
  old_value: z.string().nullable(),
  new_value: z.string().nullable(),
  metadata: z.string().transform((v, ctx): Record<string, unknown> => {
    try {
      return JSON.parse(v);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid JSON in metadata' });
      return {};
    }
  }),
  created_at: z.string(),
});

export type BeadEventRecord = z.output<typeof BeadEventRecord>;

export const beadEvents = getTableFromZodSchema('bead_events', BeadEventRecord);

export function createTableBeadEvents(): string {
  return getCreateTableQueryFromTable(beadEvents, {
    id: `text primary key`,
    bead_id: `text not null`,
    agent_id: `text`,
    event_type: `text not null`,
    old_value: `text`,
    new_value: `text`,
    metadata: `text default '{}'`,
    created_at: `text not null`,
  });
}

export function getIndexesBeadEvents(): string[] {
  return [
    `CREATE INDEX IF NOT EXISTS idx_bead_events_bead ON ${beadEvents}(${beadEvents.columns.bead_id})`,
    `CREATE INDEX IF NOT EXISTS idx_bead_events_created ON ${beadEvents}(${beadEvents.columns.created_at})`,
    `CREATE INDEX IF NOT EXISTS idx_bead_events_type ON ${beadEvents}(${beadEvents.columns.event_type})`,
  ];
}
