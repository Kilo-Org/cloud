import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

const BeadType = z.enum(['issue', 'message', 'escalation', 'merge_request']);
const BeadStatus = z.enum(['open', 'in_progress', 'closed', 'failed']);
const BeadPriority = z.enum(['low', 'medium', 'high', 'critical']);

export const RigBeadRecord = z.object({
  id: z.string(),
  type: BeadType,
  status: BeadStatus,
  title: z.string(),
  body: z.string().nullable(),
  assignee_agent_id: z.string().nullable(),
  convoy_id: z.string().nullable(),
  molecule_id: z.string().nullable(),
  priority: BeadPriority,
  labels: z.string().transform(v => JSON.parse(v) as string[]),
  metadata: z.string().transform(v => JSON.parse(v) as Record<string, unknown>),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable(),
});

export type RigBeadRecord = z.output<typeof RigBeadRecord>;

export const rig_beads = getTableFromZodSchema('rig_beads', RigBeadRecord);

export function createTableRigBeads(): string {
  return getCreateTableQueryFromTable(rig_beads, {
    id: `text primary key`,
    type: `text not null check(type in ('issue', 'message', 'escalation', 'merge_request'))`,
    status: `text not null default 'open' check(status in ('open', 'in_progress', 'closed', 'failed'))`,
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

export function getIndexesRigBeads(): string[] {
  return [
    `CREATE INDEX IF NOT EXISTS idx_rig_beads_status ON ${rig_beads}(${rig_beads.columns.status})`,
    `CREATE INDEX IF NOT EXISTS idx_rig_beads_type ON ${rig_beads}(${rig_beads.columns.type})`,
    `CREATE INDEX IF NOT EXISTS idx_rig_beads_assignee ON ${rig_beads}(${rig_beads.columns.assignee_agent_id})`,
    `CREATE INDEX IF NOT EXISTS idx_rig_beads_convoy ON ${rig_beads}(${rig_beads.columns.convoy_id})`,
  ];
}
