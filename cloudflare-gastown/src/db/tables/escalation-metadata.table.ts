import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const EscalationSeverity = z.enum(['low', 'medium', 'high', 'critical']);

export const EscalationMetadataRecord = z.object({
  bead_id: z.string(),
  severity: EscalationSeverity,
  category: z.string().nullable(),
  acknowledged: z.number(),
  re_escalation_count: z.number(),
  acknowledged_at: z.string().nullable(),
});

export type EscalationMetadataRecord = z.output<typeof EscalationMetadataRecord>;

export const escalation_metadata = getTableFromZodSchema(
  'escalation_metadata',
  EscalationMetadataRecord
);

export function createTableEscalationMetadata(): string {
  return getCreateTableQueryFromTable(escalation_metadata, {
    bead_id: `text primary key references beads(bead_id)`,
    severity: `text not null check(severity in ('low', 'medium', 'high', 'critical'))`,
    category: `text`,
    acknowledged: `integer not null default 0`,
    re_escalation_count: `integer not null default 0`,
    acknowledged_at: `text`,
  });
}
