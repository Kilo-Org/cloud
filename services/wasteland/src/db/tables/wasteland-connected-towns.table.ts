import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const WastelandConnectedTownRecord = z.object({
  town_id: z.string(),
  wasteland_id: z.string(),
  connected_by: z.string(),
  connected_at: z.string(),
});

export type WastelandConnectedTownRecord = z.output<typeof WastelandConnectedTownRecord>;

export const wasteland_connected_towns = getTableFromZodSchema(
  'wasteland_connected_towns',
  WastelandConnectedTownRecord
);

export function createTableWastelandConnectedTowns(): string {
  return getCreateTableQueryFromTable(wasteland_connected_towns, {
    town_id: `text primary key`,
    wasteland_id: `text not null`,
    connected_by: `text not null`,
    connected_at: `text not null default (datetime('now'))`,
  });
}
