import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const ConvoyStatus = z.enum(['active', 'landed']);

export const TownConvoyRecord = z.object({
  id: z.string(),
  title: z.string(),
  status: ConvoyStatus,
  total_beads: z.number(),
  closed_beads: z.number(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  landed_at: z.string().nullable(),
});

export type TownConvoyRecord = z.output<typeof TownConvoyRecord>;

export const town_convoys = getTableFromZodSchema('town_convoys', TownConvoyRecord);

export function createTableTownConvoys(): string {
  return getCreateTableQueryFromTable(town_convoys, {
    id: `text primary key`,
    title: `text not null`,
    status: `text not null check(status in ('active', 'landed')) default 'active'`,
    total_beads: `integer not null default 0`,
    closed_beads: `integer not null default 0`,
    created_by: `text`,
    created_at: `text not null`,
    landed_at: `text`,
  });
}
