import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

const ReviewStatus = z.enum(['pending', 'running', 'merged', 'failed']);

export const RigReviewQueueRecord = z.object({
  id: z.string(),
  agent_id: z.string(),
  bead_id: z.string(),
  branch: z.string(),
  pr_url: z.string().nullable(),
  status: ReviewStatus,
  summary: z.string().nullable(),
  created_at: z.string(),
  processed_at: z.string().nullable(),
});

export type RigReviewQueueRecord = z.output<typeof RigReviewQueueRecord>;

export const rig_review_queue = getTableFromZodSchema('rig_review_queue', RigReviewQueueRecord);

export function createTableRigReviewQueue(): string {
  return getCreateTableQueryFromTable(rig_review_queue, {
    id: `text primary key`,
    agent_id: `text not null references rig_agents(id)`,
    bead_id: `text not null references rig_beads(id)`,
    branch: `text not null`,
    pr_url: `text`,
    status: `text not null default 'pending' check(status in ('pending', 'running', 'merged', 'failed'))`,
    summary: `text`,
    created_at: `text not null`,
    processed_at: `text`,
  });
}
