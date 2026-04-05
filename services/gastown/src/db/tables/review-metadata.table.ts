import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const ReviewMetadataRecord = z.object({
  bead_id: z.string(),
  branch: z.string(),
  target_branch: z.string(),
  merge_commit: z.string().nullable(),
  pr_url: z.string().nullable(),
  retry_count: z.number(),
  /** Timestamp when all CI checks passed and all review threads were resolved.
   *  Used by the auto-merge timer to track grace period start. */
  auto_merge_ready_since: z.string().nullable(),
  /** Timestamp of the last feedback detection check to prevent duplicate dispatches. */
  last_feedback_check_at: z.string().nullable(),
});

export type ReviewMetadataRecord = z.output<typeof ReviewMetadataRecord>;

export const review_metadata = getTableFromZodSchema('review_metadata', ReviewMetadataRecord);

export function createTableReviewMetadata(): string {
  return getCreateTableQueryFromTable(review_metadata, {
    bead_id: `text primary key references beads(bead_id)`,
    branch: `text not null`,
    target_branch: `text not null default 'main'`,
    merge_commit: `text`,
    pr_url: `text`,
    retry_count: `integer default 0`,
    auto_merge_ready_since: `text`,
    last_feedback_check_at: `text`,
  });
}

/** Idempotent ALTER statements for existing databases. */
export function migrateReviewMetadata(): string[] {
  return [
    `ALTER TABLE review_metadata ADD COLUMN auto_merge_ready_since text`,
    `ALTER TABLE review_metadata ADD COLUMN last_feedback_check_at text`,
  ];
}
