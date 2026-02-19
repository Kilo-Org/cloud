import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const RigAgentEventRecord = z.object({
  id: z.number(),
  agent_id: z.string(),
  event_type: z.string(),
  data: z
    .string()
    .transform(v => JSON.parse(v))
    .pipe(z.record(z.string(), z.unknown())),
  created_at: z.string(),
});

export type RigAgentEventRecord = z.output<typeof RigAgentEventRecord>;

export const rig_agent_events = getTableFromZodSchema('rig_agent_events', RigAgentEventRecord);

export function createTableRigAgentEvents(): string {
  return getCreateTableQueryFromTable(rig_agent_events, {
    id: `integer primary key autoincrement`,
    agent_id: `text not null`,
    event_type: `text not null`,
    data: `text not null default '{}'`,
    created_at: `text not null`,
  });
}

export function getIndexesRigAgentEvents(): string[] {
  return [
    `CREATE INDEX IF NOT EXISTS idx_rig_agent_events_agent_id ON ${rig_agent_events}(${rig_agent_events.columns.agent_id})`,
    `CREATE INDEX IF NOT EXISTS idx_rig_agent_events_agent_created ON ${rig_agent_events}(${rig_agent_events.columns.agent_id}, ${rig_agent_events.columns.id})`,
  ];
}
