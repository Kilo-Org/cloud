import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const WastelandWantedItemRecord = z.object({
  item_id: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(['open', 'claimed', 'done']),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  type: z.enum(['feature', 'bug', 'docs', 'other']),
  claimed_by: z.string().nullable(),
  evidence: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type WastelandWantedItemRecord = z.output<typeof WastelandWantedItemRecord>;

export const wasteland_wanted_items = getTableFromZodSchema(
  'wasteland_wanted_items',
  WastelandWantedItemRecord
);

export function createTableWastelandWantedItems(): string {
  return getCreateTableQueryFromTable(wasteland_wanted_items, {
    item_id: `text primary key`,
    title: `text not null`,
    description: `text not null default ''`,
    status: `text not null default 'open' check(status in ('open', 'claimed', 'done'))`,
    priority: `text not null default 'medium' check(priority in ('low', 'medium', 'high', 'critical'))`,
    type: `text not null default 'other' check(type in ('feature', 'bug', 'docs', 'other'))`,
    claimed_by: `text`,
    evidence: `text`,
    created_at: `text not null default (datetime('now'))`,
    updated_at: `text not null default (datetime('now'))`,
  });
}
