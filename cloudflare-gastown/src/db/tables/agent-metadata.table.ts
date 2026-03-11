import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

// Accept legacy role values (e.g. 'witness' from pre-#442 towns) so that
// queries parsing through AgentMetadataRecord don't throw on old rows.
// Application code should only create the known roles below.
const AgentRole = z.enum(['polecat', 'refinery', 'mayor']).or(z.string());
const AgentProcessStatus = z.enum(['idle', 'working', 'stalled', 'dead']).or(z.string());

export const AgentMetadataRecord = z.object({
  bead_id: z.string(),
  role: AgentRole,
  identity: z.string(),
  container_process_id: z.string().nullable(),
  status: AgentProcessStatus,
  current_hook_bead_id: z.string().nullable(),
  dispatch_attempts: z.number().default(0),
  checkpoint: z
    .string()
    .nullable()
    .transform((v, ctx): unknown => {
      if (v === null) return null;
      try {
        return JSON.parse(v) as unknown;
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid JSON in checkpoint' });
        return null;
      }
    })
    .pipe(z.unknown()),
  last_activity_at: z.string().nullable(),
  agent_status_message: z.string().nullable(),
  agent_status_updated_at: z.string().nullable(),
});

export type AgentMetadataRecord = z.output<typeof AgentMetadataRecord>;

export const agent_metadata = getTableFromZodSchema('agent_metadata', AgentMetadataRecord);

// CHECK constraints are intentionally omitted — Cloudflare DO SQLite
// provides no way to alter CHECK constraints on existing tables, and
// Zod validates all values at the application layer. See #442.
export function createTableAgentMetadata(): string {
  return getCreateTableQueryFromTable(agent_metadata, {
    bead_id: `text primary key references beads(bead_id)`,
    role: `text not null`,
    identity: `text not null unique`,
    container_process_id: `text`,
    status: `text not null default 'idle'`,
    current_hook_bead_id: `text references beads(bead_id)`,
    dispatch_attempts: `integer not null default 0`,
    checkpoint: `text`,
    last_activity_at: `text`,
    agent_status_message: `text`,
    agent_status_updated_at: `text`,
  });
}

/** Idempotent ALTER statements for existing databases. */
export function migrateAgentMetadata(): string[] {
  return [
    `ALTER TABLE agent_metadata ADD COLUMN agent_status_message text`,
    `ALTER TABLE agent_metadata ADD COLUMN agent_status_updated_at text`,
  ];
}
