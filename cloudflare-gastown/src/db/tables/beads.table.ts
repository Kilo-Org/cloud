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

export const BeadStatus = z.enum(['open', 'in_progress', 'in_review', 'closed', 'failed']);
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
    .transform((v, ctx): string[] => {
      try {
        return JSON.parse(v) as string[];
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid JSON in labels' });
        return [];
      }
    })
    .pipe(z.array(z.string())),
  metadata: z
    .string()
    .transform((v, ctx): Record<string, unknown> => {
      try {
        return JSON.parse(v) as Record<string, unknown>;
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid JSON in metadata' });
        return {};
      }
    })
    .pipe(z.record(z.string(), z.any())), // z.any() needed for Rpc.Serializable compatibility
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable(),
});

export type BeadRecord = z.output<typeof BeadRecord>;

// ── Per-type bead + metadata schemas ────────────────────────────────
// Each narrows the `type` discriminant to a literal and extends with
// the satellite metadata columns. Use these to parse JOIN query results.

export const IssueBeadRecord = BeadRecord.extend({ type: z.literal('issue') });
export type IssueBeadRecord = z.output<typeof IssueBeadRecord>;

export const MessageBeadRecord = BeadRecord.extend({ type: z.literal('message') });
export type MessageBeadRecord = z.output<typeof MessageBeadRecord>;

export const MoleculeBeadRecord = BeadRecord.extend({ type: z.literal('molecule') });
export type MoleculeBeadRecord = z.output<typeof MoleculeBeadRecord>;

export const AgentBeadRecord = BeadRecord.extend({
  type: z.literal('agent'),
  ...AgentMetadataRecord.shape,
});
export type AgentBeadRecord = z.output<typeof AgentBeadRecord>;

export const MergeRequestBeadRecord = BeadRecord.extend({
  type: z.literal('merge_request'),
  ...ReviewMetadataRecord.shape,
});
export type MergeRequestBeadRecord = z.output<typeof MergeRequestBeadRecord>;

export const EscalationBeadRecord = BeadRecord.extend({
  type: z.literal('escalation'),
  ...EscalationMetadataRecord.shape,
});
export type EscalationBeadRecord = z.output<typeof EscalationBeadRecord>;

export const ConvoyBeadRecord = BeadRecord.extend({
  type: z.literal('convoy'),
  ...ConvoyMetadataRecord.shape,
});
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

// CHECK constraints are intentionally omitted — Cloudflare DO SQLite
// provides no way to alter CHECK constraints on existing tables, and
// Zod validates all values at the application layer. See #442.
export function createTableBeads(): string {
  return getCreateTableQueryFromTable(beads, {
    bead_id: `text primary key`,
    type: `text not null`,
    status: `text not null default 'open'`,
    title: `text not null`,
    body: `text`,
    rig_id: `text`,
    parent_bead_id: `text references beads(bead_id)`,
    assignee_agent_bead_id: `text`,
    priority: `text default 'medium'`,
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
