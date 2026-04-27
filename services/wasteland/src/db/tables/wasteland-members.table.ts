import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const WastelandMemberRecord = z.object({
  member_id: z.string(),
  wasteland_id: z.string(),
  user_id: z.string(),
  role: z.enum(['contributor', 'maintainer', 'owner']),
  trust_level: z.number().int().min(1).max(3),
  joined_at: z.string(),
});

export type WastelandMemberRecord = z.output<typeof WastelandMemberRecord>;

export const wasteland_members = getTableFromZodSchema('wasteland_members', WastelandMemberRecord);

export function createTableWastelandMembers(): string {
  return getCreateTableQueryFromTable(wasteland_members, {
    member_id: `text primary key`,
    wasteland_id: `text not null`,
    user_id: `text not null`,
    role: `text not null check(role in ('contributor', 'maintainer', 'owner'))`,
    trust_level: `integer not null check(trust_level between 1 and 3)`,
    joined_at: `text not null default (datetime('now'))`,
  });
}
