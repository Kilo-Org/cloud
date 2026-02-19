import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const ConvoyBeadStatus = z.enum(['open', 'closed']);

export const TownConvoyBeadRecord = z.object({
  convoy_id: z.string(),
  bead_id: z.string(),
  rig_id: z.string(),
  status: ConvoyBeadStatus,
});

export type TownConvoyBeadRecord = z.output<typeof TownConvoyBeadRecord>;

export const town_convoy_beads = getTableFromZodSchema('town_convoy_beads', TownConvoyBeadRecord);

export function createTableTownConvoyBeads(): string {
  return getCreateTableQueryFromTable(town_convoy_beads, {
    convoy_id: `text not null`,
    bead_id: `text not null`,
    rig_id: `text not null`,
    status: `text not null check(status in ('open', 'closed')) default 'open'`,
  });
}
