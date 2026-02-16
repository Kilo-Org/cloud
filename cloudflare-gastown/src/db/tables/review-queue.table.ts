import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const ReviewQueueRecord = z.object({
  id: z.string(),
  agent_id: z.string(),
  bead_id: z.string(),
  branch: z.string(),
  pr_url: z.string().nullable(),
  status: z.string(),
  summary: z.string().nullable(),
  created_at: z.string(),
  processed_at: z.string().nullable(),
});

export type ReviewQueueRecord = z.infer<typeof ReviewQueueRecord>;

export const reviewQueue = getTableFromZodSchema('review_queue', ReviewQueueRecord);

export function createTableReviewQueue(): string {
  return getCreateTableQueryFromTable(reviewQueue, {
    id: `text primary key`,
    agent_id: `text not null references agents(id)`,
    bead_id: `text not null references beads(id)`,
    branch: `text not null`,
    pr_url: `text`,
    status: `text not null default 'pending' check(status in ('pending', 'running', 'merged', 'failed'))`,
    summary: `text`,
    created_at: `text not null`,
    processed_at: `text`,
  });
}
