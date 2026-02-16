import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const MailRecord = z.object({
  id: z.string(),
  from_agent_id: z.string(),
  to_agent_id: z.string(),
  subject: z.string(),
  body: z.string(),
  delivered: z.number(),
  created_at: z.string(),
  delivered_at: z.string().nullable(),
});

export type MailRecord = z.infer<typeof MailRecord>;

export const mail = getTableFromZodSchema('mail', MailRecord);

export function createTableMail(): string {
  return getCreateTableQueryFromTable(mail, {
    id: `text primary key`,
    from_agent_id: `text not null references agents(id)`,
    to_agent_id: `text not null references agents(id)`,
    subject: `text not null`,
    body: `text not null`,
    delivered: `integer not null default 0`,
    created_at: `text not null`,
    delivered_at: `text`,
  });
}

export function getIndexesMail(): string[] {
  return [
    `CREATE INDEX IF NOT EXISTS idx_mail_undelivered ON ${mail}(${mail.columns.to_agent_id}) WHERE ${mail.columns.delivered} = 0`,
  ];
}
