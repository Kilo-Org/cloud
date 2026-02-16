import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

const AgentRole = z.enum(['polecat', 'refinery', 'mayor', 'witness']);
const AgentStatus = z.enum(['idle', 'working', 'blocked', 'dead']);

export const AgentRecord = z.object({
  id: z.string(),
  role: AgentRole,
  name: z.string(),
  identity: z.string(),
  cloud_agent_session_id: z.string().nullable(),
  status: AgentStatus,
  current_hook_bead_id: z.string().nullable(),
  last_activity_at: z.string().nullable(),
  checkpoint: z
    .string()
    .nullable()
    .transform(v => (v === null ? null : (JSON.parse(v) as unknown))),
  created_at: z.string(),
});

export type AgentRecord = z.output<typeof AgentRecord>;

export const agents = getTableFromZodSchema('agents', AgentRecord);

export function createTableAgents(): string {
  return getCreateTableQueryFromTable(agents, {
    id: `text primary key`,
    role: `text not null check(role in ('polecat', 'refinery', 'mayor', 'witness'))`,
    name: `text not null`,
    identity: `text not null unique`,
    cloud_agent_session_id: `text`,
    status: `text not null default 'idle' check(status in ('idle', 'working', 'blocked', 'dead'))`,
    current_hook_bead_id: `text references beads(id)`,
    last_activity_at: `text`,
    checkpoint: `text`,
    created_at: `text not null`,
  });
}
