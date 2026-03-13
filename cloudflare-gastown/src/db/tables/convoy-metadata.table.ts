import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const ConvoyMergeMode = z.enum(['review-then-land', 'review-and-merge']);
export type ConvoyMergeMode = z.output<typeof ConvoyMergeMode>;

export const ConvoyMetadataRecord = z.object({
  bead_id: z.string(),
  total_beads: z.number(),
  closed_beads: z.number(),
  landed_at: z.string().nullable(),
  /** The long-lived feature branch for this convoy. Sub-beads branch from and merge into this. */
  feature_branch: z.string().nullable(),
  /**
   * Controls how the refinery handles bead completions within a convoy:
   * - 'review-then-land': Refinery reviews each bead on the feature branch; only at the
   *   end of the convoy does a PR or merge into main occur. (Default)
   * - 'review-and-merge': Refinery reviews AND merges/creates PR for each bead
   *   individually, like standalone beads.
   */
  merge_mode: ConvoyMergeMode.nullable(),
});

export type ConvoyMetadataRecord = z.output<typeof ConvoyMetadataRecord>;

export const convoy_metadata = getTableFromZodSchema('convoy_metadata', ConvoyMetadataRecord);

export function createTableConvoyMetadata(): string {
  return getCreateTableQueryFromTable(convoy_metadata, {
    bead_id: `text primary key references beads(bead_id)`,
    total_beads: `integer not null default 0`,
    closed_beads: `integer not null default 0`,
    landed_at: `text`,
    feature_branch: `text`,
    merge_mode: `text`,
  });
}

/** Idempotent ALTER statements for existing databases. */
export function migrateConvoyMetadata(): string[] {
  return [
    `ALTER TABLE convoy_metadata ADD COLUMN feature_branch text`,
    `ALTER TABLE convoy_metadata ADD COLUMN merge_mode text`,
  ];
}
