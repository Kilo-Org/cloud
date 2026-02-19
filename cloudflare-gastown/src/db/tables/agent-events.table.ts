import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const AgentEventRecord = z.object({
  id: z.number(),
  agent_id: z.string(),
  event_type: z.string(),
  data: z.string().transform(v => JSON.parse(v) as Record<string, unknown>),
  created_at: z.string(),
});

export type AgentEventRecord = z.output<typeof AgentEventRecord>;

export const agentEvents = getTableFromZodSchema('agent_events', AgentEventRecord);

export function createTableAgentEvents(): string {
  return getCreateTableQueryFromTable(agentEvents, {
    id: `integer primary key autoincrement`,
    agent_id: `text not null`,
    event_type: `text not null`,
    data: `text not null default '{}'`,
    created_at: `text not null`,
  });
}

export function getIndexesAgentEvents(): string[] {
  return [
    `CREATE INDEX IF NOT EXISTS idx_agent_events_agent_id ON ${agentEvents}(${agentEvents.columns.agent_id})`,
    `CREATE INDEX IF NOT EXISTS idx_agent_events_agent_created ON ${agentEvents}(${agentEvents.columns.agent_id}, ${agentEvents.columns.id})`,
  ];
}
