import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const RigRecord = z.object({
  id: z.string(),
  town_id: z.string(),
  name: z.string(),
  git_url: z.string(),
  default_branch: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type RigRecord = z.output<typeof RigRecord>;

export const rigs = getTableFromZodSchema('rigs', RigRecord);

export function createTableRigs(): string {
  return getCreateTableQueryFromTable(rigs, {
    id: `text primary key`,
    town_id: `text not null`,
    name: `text not null`,
    git_url: `text not null`,
    default_branch: `text not null default 'main'`,
    created_at: `text not null`,
    updated_at: `text not null`,
  });
}
