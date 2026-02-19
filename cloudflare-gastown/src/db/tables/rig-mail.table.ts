import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const RigMailRecord = z.object({
  id: z.string(),
  from_agent_id: z.string(),
  to_agent_id: z.string(),
  subject: z.string(),
  body: z.string(),
  delivered: z.number().transform(v => Boolean(v)),
  created_at: z.string(),
  delivered_at: z.string().nullable(),
});

export type RigMailRecord = z.output<typeof RigMailRecord>;

export const rig_mail = getTableFromZodSchema('rig_mail', RigMailRecord);

export function createTableRigMail(): string {
  return getCreateTableQueryFromTable(rig_mail, {
    id: `text primary key`,
    from_agent_id: `text not null references rig_agents(id)`,
    to_agent_id: `text not null references rig_agents(id)`,
    subject: `text not null`,
    body: `text not null`,
    delivered: `integer not null default 0`,
    created_at: `text not null`,
    delivered_at: `text`,
  });
}

export function getIndexesRigMail(): string[] {
  return [
    `CREATE INDEX IF NOT EXISTS idx_rig_mail_undelivered ON ${rig_mail}(${rig_mail.columns.to_agent_id}) WHERE ${rig_mail.columns.delivered} = 0`,
  ];
}
