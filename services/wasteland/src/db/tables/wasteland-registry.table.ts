import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const WastelandRegistryRecord = z.object({
  wasteland_id: z.string(),
  owner_type: z.enum(['user', 'org']),
  owner_user_id: z.string().nullable(),
  organization_id: z.string().nullable(),
  name: z.string(),
  created_at: z.string(),
});

export type WastelandRegistryRecord = z.output<typeof WastelandRegistryRecord>;

export const wasteland_registry = getTableFromZodSchema(
  'wasteland_registry',
  WastelandRegistryRecord
);

export function createTableWastelandRegistry(): string {
  return getCreateTableQueryFromTable(wasteland_registry, {
    wasteland_id: `text primary key`,
    owner_type: `text not null check(owner_type in ('user', 'org'))`,
    owner_user_id: `text`,
    organization_id: `text`,
    name: `text not null`,
    created_at: `text not null default (datetime('now'))`,
  });
}
