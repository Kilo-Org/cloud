import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const UserTownRecord = z.object({
  id: z.string(),
  name: z.string(),
  owner_user_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type UserTownRecord = z.output<typeof UserTownRecord>;

export const user_towns = getTableFromZodSchema('user_towns', UserTownRecord);

export function createTableUserTowns(): string {
  return getCreateTableQueryFromTable(user_towns, {
    id: `text primary key`,
    name: `text not null`,
    owner_user_id: `text not null`,
    created_at: `text not null`,
    updated_at: `text not null`,
  });
}
