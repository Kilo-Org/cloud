import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const UserRigRecord = z.object({
  id: z.string(),
  town_id: z.string(),
  name: z.string(),
  git_url: z.string(),
  default_branch: z.string(),
  // nullable + optional: existing rows won't have this column at all (undefined),
  // new rows will have it as null or a string.
  platform_integration_id: z.string().nullable().optional().default(null),
  created_at: z.string(),
  updated_at: z.string(),
});

export type UserRigRecord = z.output<typeof UserRigRecord>;

export const user_rigs = getTableFromZodSchema('user_rigs', UserRigRecord);

export function createTableUserRigs(): string {
  return getCreateTableQueryFromTable(user_rigs, {
    id: `text primary key`,
    town_id: `text not null`,
    name: `text not null`,
    git_url: `text not null`,
    default_branch: `text not null default 'main'`,
    platform_integration_id: `text`,
    created_at: `text not null`,
    updated_at: `text not null`,
  });
}
