import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const BeadRecord = z.object({
  id: z.string(),
  type: z.string(),
  status: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  assignee_agent_id: z.string().nullable(),
  convoy_id: z.string().nullable(),
  molecule_id: z.string().nullable(),
  priority: z.string(),
  labels: z.string(),
  metadata: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable(),
});

export type BeadRecord = z.infer<typeof BeadRecord>;

export const beads = getTableFromZodSchema('beads', BeadRecord);

export function createTableBeads(): string {
  return getCreateTableQueryFromTable(beads, {
    id: `text primary key`,
    type: `text not null check(type in ('issue', 'message', 'escalation', 'merge_request'))`,
    status: `text not null default 'open' check(status in ('open', 'in_progress', 'closed'))`,
    title: `text not null`,
    body: `text`,
    assignee_agent_id: `text`,
    convoy_id: `text`,
    molecule_id: `text`,
    priority: `text default 'medium' check(priority in ('low', 'medium', 'high', 'critical'))`,
    labels: `text default '[]'`,
    metadata: `text default '{}'`,
    created_at: `text not null`,
    updated_at: `text not null`,
    closed_at: `text`,
  });
}

export function getIndexesBeads(): string[] {
  return [
    `CREATE INDEX IF NOT EXISTS idx_beads_status ON ${beads}(${beads.columns.status})`,
    `CREATE INDEX IF NOT EXISTS idx_beads_type ON ${beads}(${beads.columns.type})`,
    `CREATE INDEX IF NOT EXISTS idx_beads_assignee ON ${beads}(${beads.columns.assignee_agent_id})`,
    `CREATE INDEX IF NOT EXISTS idx_beads_convoy ON ${beads}(${beads.columns.convoy_id})`,
  ];
}
