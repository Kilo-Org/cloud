import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const ConvoyMetadataRecord = z.object({
  bead_id: z.string(),
  total_beads: z.number(),
  closed_beads: z.number(),
  landed_at: z.string().nullable(),
});

export type ConvoyMetadataRecord = z.output<typeof ConvoyMetadataRecord>;

export const convoy_metadata = getTableFromZodSchema('convoy_metadata', ConvoyMetadataRecord);

export function createTableConvoyMetadata(): string {
  return getCreateTableQueryFromTable(convoy_metadata, {
    bead_id: `text primary key references beads(bead_id)`,
    total_beads: `integer not null default 0`,
    closed_beads: `integer not null default 0`,
    landed_at: `text`,
  });
}
