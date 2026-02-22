import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';
import { AgentMetadataRecord } from './agent-metadata.table';
import { ReviewMetadataRecord } from './review-metadata.table';
import { EscalationMetadataRecord } from './escalation-metadata.table';
import { ConvoyMetadataRecord } from './convoy-metadata.table';

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
  labels: z
    .string()
    .transform(v => JSON.parse(v))
    .pipe(z.array(z.string())),
  metadata: z
    .string()
    .transform(v => JSON.parse(v))
    .pipe(z.record(z.string(), z.unknown())),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable(),
});

export type BeadRecord = z.output<typeof BeadRecord>;

// ── Per-type bead + metadata schemas ────────────────────────────────
// Each narrows the `type` discriminant to a literal and merges the
// satellite metadata columns. Use these to parse JOIN query results.
//
// The metadata tables share `bead_id` with beads, so we omit the
// duplicate key from the metadata side when merging.

export const IssueBeadRecord = BeadRecord.extend({ type: z.literal('issue') });
export type IssueBeadRecord = z.output<typeof IssueBeadRecord>;

export const MessageBeadRecord = BeadRecord.extend({ type: z.literal('message') });
export type MessageBeadRecord = z.output<typeof MessageBeadRecord>;

export const MoleculeBeadRecord = BeadRecord.extend({ type: z.literal('molecule') });
export type MoleculeBeadRecord = z.output<typeof MoleculeBeadRecord>;

export const AgentBeadRecord = BeadRecord.extend({ type: z.literal('agent') }).merge(
  AgentMetadataRecord.omit({ bead_id: true })
);
export type AgentBeadRecord = z.output<typeof AgentBeadRecord>;

export const MergeRequestBeadRecord = BeadRecord.extend({ type: z.literal('merge_request') }).merge(
  ReviewMetadataRecord.omit({ bead_id: true })
);
export type MergeRequestBeadRecord = z.output<typeof MergeRequestBeadRecord>;

export const EscalationBeadRecord = BeadRecord.extend({ type: z.literal('escalation') }).merge(
  EscalationMetadataRecord.omit({ bead_id: true })
);
export type EscalationBeadRecord = z.output<typeof EscalationBeadRecord>;

export const ConvoyBeadRecord = BeadRecord.extend({ type: z.literal('convoy') }).merge(
  ConvoyMetadataRecord.omit({ bead_id: true })
);
export type ConvoyBeadRecord = z.output<typeof ConvoyBeadRecord>;

export const BeadRecordWithMetadata = z.discriminatedUnion('type', [
  IssueBeadRecord,
  MessageBeadRecord,
  MoleculeBeadRecord,
  AgentBeadRecord,
  MergeRequestBeadRecord,
  EscalationBeadRecord,
  ConvoyBeadRecord,
]);
export type BeadRecordWithMetadata = z.output<typeof BeadRecordWithMetadata>;

// ── Table definition ────────────────────────────────────────────────

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
