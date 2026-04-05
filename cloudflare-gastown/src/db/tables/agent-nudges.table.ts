import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const NudgeMode = z.enum(['wait-idle', 'immediate', 'queue']);
export type NudgeMode = z.output<typeof NudgeMode>;

export const NudgePriority = z.enum(['normal', 'urgent']);
export type NudgePriority = z.output<typeof NudgePriority>;

export const AgentNudgeRecord = z.object({
  nudge_id: z.string(),
  agent_bead_id: z.string(),
  message: z.string(),
  mode: NudgeMode,
  priority: NudgePriority,
  source: z.string(),
  created_at: z.string(),
  delivered_at: z.string().nullable(),
  expires_at: z.string().nullable(),
});

export type AgentNudgeRecord = z.output<typeof AgentNudgeRecord>;

export const agent_nudges = getTableFromZodSchema('agent_nudges', AgentNudgeRecord);

export function createTableAgentNudges(): string {
  return getCreateTableQueryFromTable(agent_nudges, {
    nudge_id: `text primary key`,
    agent_bead_id: `text not null`,
    message: `text not null`,
    mode: `text not null default 'wait-idle' check(mode in ('wait-idle', 'immediate', 'queue'))`,
    priority: `text not null default 'normal' check(priority in ('normal', 'urgent'))`,
    source: `text not null default 'system'`,
    created_at: `text not null default (datetime('now'))`,
    delivered_at: `text`,
    expires_at: `text`,
  });
}

export function getIndexesAgentNudges(): string[] {
  return [
    `CREATE INDEX IF NOT EXISTS idx_agent_nudges_pending ON ${agent_nudges}(${agent_nudges.columns.agent_bead_id}) WHERE ${agent_nudges.columns.delivered_at} IS NULL`,
  ];
}
