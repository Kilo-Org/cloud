import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const WastelandConfigRecord = z.object({
  wasteland_id: z.string(),
  name: z.string(),
  owner_type: z.enum(['user', 'org']),
  owner_user_id: z.string().nullable(),
  organization_id: z.string().nullable(),
  dolthub_upstream: z.string().nullable(),
  visibility: z.enum(['public', 'private']),
  status: z.enum(['active', 'deleted']),
  created_at: z.string(),
  updated_at: z.string(),
});

export type WastelandConfigRecord = z.output<typeof WastelandConfigRecord>;

export const wasteland_config = getTableFromZodSchema('wasteland_config', WastelandConfigRecord);

export function createTableWastelandConfig(): string {
  return getCreateTableQueryFromTable(wasteland_config, {
    wasteland_id: `text primary key`,
    name: `text not null`,
    owner_type: `text not null check(owner_type in ('user', 'org'))`,
    owner_user_id: `text`,
    organization_id: `text`,
    dolthub_upstream: `text`,
    visibility: `text not null check(visibility in ('public', 'private'))`,
    status: `text not null check(status in ('active', 'deleted'))`,
    created_at: `text not null default (datetime('now'))`,
    updated_at: `text not null default (datetime('now'))`,
  });
}
