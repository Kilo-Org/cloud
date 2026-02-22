import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const BeadType = z.enum([
  'issue',
  'message',
  'escalation',
  'merge_request',
  'convoy',
  'molecule',
  'agent',
]);

export const BeadStatus = z.enum(['open', 'in_progress', 'closed', 'failed']);
export const BeadPriority = z.enum(['low', 'medium', 'high', 'critical']);

export const BeadRecord = z.object({
  bead_id: z.string(),
  type: BeadType,
  status: BeadStatus,
  title: z.string(),
  body: z.string().nullable(),
  rig_id: z.string().nullable(),
  parent_bead_id: z.string().nullable(),
  assignee_agent_bead_id: z.string().nullable(),
  priority: BeadPriority,
  labels: z.string().transform(v => JSON.parse(v) as string[]),
  metadata: z.string().transform(v => JSON.parse(v) as Record<string, unknown>),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable(),
});

export type BeadRecord = z.output<typeof BeadRecord>;

export const beads = getTableFromZodSchema('beads', BeadRecord);

export function createTableBeads(): string {
  return getCreateTableQueryFromTable(beads, {
    bead_id: `text primary key`,
    type: `text not null check(type in ('issue', 'message', 'escalation', 'merge_request', 'convoy', 'molecule', 'agent'))`,
    status: `text not null default 'open' check(status in ('open', 'in_progress', 'closed', 'failed'))`,
    title: `text not null`,
    body: `text`,
    rig_id: `text`,
    parent_bead_id: `text references beads(bead_id)`,
    assignee_agent_bead_id: `text`,
    priority: `text default 'medium' check(priority in ('low', 'medium', 'high', 'critical'))`,
    labels: `text default '[]'`,
    metadata: `text default '{}'`,
    created_by: `text`,
    created_at: `text not null`,
    updated_at: `text not null`,
    closed_at: `text`,
  });
}

export function getIndexesBeads(): string[] {
  return [
    `CREATE INDEX IF NOT EXISTS idx_beads_type_status ON ${beads}(${beads.columns.type}, ${beads.columns.status})`,
    `CREATE INDEX IF NOT EXISTS idx_beads_parent ON ${beads}(${beads.columns.parent_bead_id})`,
    `CREATE INDEX IF NOT EXISTS idx_beads_rig_status ON ${beads}(${beads.columns.rig_id}, ${beads.columns.status})`,
    `CREATE INDEX IF NOT EXISTS idx_beads_assignee ON ${beads}(${beads.columns.assignee_agent_bead_id}, ${beads.columns.type}, ${beads.columns.status})`,
  ];
}
