import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const WantedCacheRecord = z.object({
  item_id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  bounty: z.coerce.number().nullable(),
  status: z.enum(['open', 'claimed', 'done']),
  claimed_by: z.string().nullable(),
  claim_id: z.string().nullable(),
  evidence: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  cached_at: z.string(),
});

export type WantedCacheRecord = z.output<typeof WantedCacheRecord>;

export const wasteland_wanted_cache = getTableFromZodSchema(
  'wasteland_wanted_cache',
  WantedCacheRecord
);

export function createTableWantedCache(): string {
  return getCreateTableQueryFromTable(wasteland_wanted_cache, {
    item_id: `text primary key`,
    title: `text not null`,
    description: `text`,
    bounty: `integer`,
    status: `text not null check(status in ('open', 'claimed', 'done')) default 'open'`,
    claimed_by: `text`,
    claim_id: `text`,
    evidence: `text`,
    created_at: `text`,
    updated_at: `text`,
    cached_at: `text not null default (datetime('now'))`,
  });
}
