import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const EscalationSeverity = z.enum(['low', 'medium', 'high']);

export const EscalationRecord = z.object({
  id: z.string(),
  source_rig_id: z.string(),
  source_agent_id: z.string().nullable(),
  severity: EscalationSeverity,
  category: z.string().nullable(),
  message: z.string(),
  acknowledged: z.number(),
  re_escalation_count: z.number(),
  created_at: z.string(),
  acknowledged_at: z.string().nullable(),
});

export type EscalationRecord = z.output<typeof EscalationRecord>;

export const escalations = getTableFromZodSchema('escalations', EscalationRecord);

export function createTableEscalations(): string {
  return getCreateTableQueryFromTable(escalations, {
    id: `text primary key`,
    source_rig_id: `text not null`,
    source_agent_id: `text`,
    severity: `text not null check(severity in ('low', 'medium', 'high'))`,
    category: `text`,
    message: `text not null`,
    acknowledged: `integer not null default 0`,
    re_escalation_count: `integer not null default 0`,
    created_at: `text not null`,
    acknowledged_at: `text`,
  });
}
