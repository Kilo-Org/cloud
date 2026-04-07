import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const WastelandWantedBoardRecord = z.object({
  item_id: z.string(),
  wasteland_id: z.string(),
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

export type WastelandWantedBoardRecord = z.output<typeof WastelandWantedBoardRecord>;

export const wasteland_wanted_board = getTableFromZodSchema(
  'wasteland_wanted_board',
  WastelandWantedBoardRecord
);

export function createTableWastelandWantedBoard(): string {
  return getCreateTableQueryFromTable(wasteland_wanted_board, {
    item_id: `text primary key`,
    wasteland_id: `text not null`,
    title: `text not null`,
    description: `text not null`,
    status: `text not null check(status in ('open', 'claimed', 'done'))`,
    priority: `text not null check(priority in ('low', 'medium', 'high', 'critical'))`,
    type: `text not null check(type in ('feature', 'bug', 'docs', 'other'))`,
    claimed_by: `text`,
    evidence: `text`,
    created_at: `text not null default (datetime('now'))`,
    updated_at: `text not null default (datetime('now'))`,
  });
}
