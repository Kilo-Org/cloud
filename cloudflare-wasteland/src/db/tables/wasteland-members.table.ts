import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const WastelandMemberRecord = z.object({
  member_id: z.string(),
  user_id: z.string(),
  trust_level: z.coerce.number(),
  role: z.enum(['contributor', 'maintainer', 'owner']),
  joined_at: z.string(),
});

export type WastelandMemberRecord = z.output<typeof WastelandMemberRecord>;

export const wasteland_members = getTableFromZodSchema('wasteland_members', WastelandMemberRecord);

export function createTableWastelandMembers(): string {
  return getCreateTableQueryFromTable(wasteland_members, {
    member_id: `text primary key`,
    user_id: `text not null`,
    trust_level: `integer not null default 1`,
    role: `text not null default 'contributor' check(role in ('contributor', 'maintainer', 'owner'))`,
    joined_at: `text not null default (datetime('now'))`,
  });
}
