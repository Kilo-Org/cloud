import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const TownRecord = z.object({
  id: z.string(),
  name: z.string(),
  owner_user_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type TownRecord = z.output<typeof TownRecord>;

export const towns = getTableFromZodSchema('towns', TownRecord);

export function createTableTowns(): string {
  return getCreateTableQueryFromTable(towns, {
    id: `text primary key`,
    name: `text not null`,
    owner_user_id: `text not null`,
    created_at: `text not null`,
    updated_at: `text not null`,
  });
}
