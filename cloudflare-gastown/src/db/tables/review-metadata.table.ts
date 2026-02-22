import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const ReviewMetadataRecord = z.object({
  bead_id: z.string(),
  branch: z.string(),
  target_branch: z.string(),
  merge_commit: z.string().nullable(),
  pr_url: z.string().nullable(),
  retry_count: z.number(),
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
  });
}
