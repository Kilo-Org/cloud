import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const ConvoyBeadStatus = z.enum(['open', 'closed']);

export const ConvoyBeadRecord = z.object({
  convoy_id: z.string(),
  bead_id: z.string(),
  rig_id: z.string(),
  status: ConvoyBeadStatus,
});

export type ConvoyBeadRecord = z.output<typeof ConvoyBeadRecord>;

export const convoyBeads = getTableFromZodSchema('convoy_beads', ConvoyBeadRecord);

export function createTableConvoyBeads(): string {
  return getCreateTableQueryFromTable(convoyBeads, {
    convoy_id: `text not null`,
    bead_id: `text not null`,
    rig_id: `text not null`,
    status: `text not null check(status in ('open', 'closed')) default 'open'`,
  });
}
