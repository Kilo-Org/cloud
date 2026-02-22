import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

const AgentRole = z.enum(['polecat', 'refinery', 'mayor', 'witness']);
const AgentProcessStatus = z.enum(['idle', 'working', 'stalled', 'dead']);

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
    .transform(v => (v === null ? null : JSON.parse(v)))
    .pipe(z.unknown()),
  last_activity_at: z.string().nullable(),
});

export type AgentMetadataRecord = z.output<typeof AgentMetadataRecord>;

export const agent_metadata = getTableFromZodSchema('agent_metadata', AgentMetadataRecord);

export function createTableAgentMetadata(): string {
  return getCreateTableQueryFromTable(agent_metadata, {
    bead_id: `text primary key references beads(bead_id)`,
    role: `text not null check(role in ('polecat', 'refinery', 'mayor', 'witness'))`,
    identity: `text not null unique`,
    container_process_id: `text`,
    status: `text not null default 'idle' check(status in ('idle', 'working', 'stalled', 'dead'))`,
    current_hook_bead_id: `text references beads(bead_id)`,
    dispatch_attempts: `integer not null default 0`,
    checkpoint: `text`,
    last_activity_at: `text`,
  });
}
