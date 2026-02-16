import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const MoleculeRecord = z.object({
  id: z.string(),
  bead_id: z.string(),
  formula: z.string(),
  current_step: z.number(),
  status: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type MoleculeRecord = z.infer<typeof MoleculeRecord>;

export const molecules = getTableFromZodSchema('molecules', MoleculeRecord);

export function createTableMolecules(): string {
  return getCreateTableQueryFromTable(molecules, {
    id: `text primary key`,
    bead_id: `text not null references beads(id)`,
    formula: `text not null`,
    current_step: `integer not null default 0`,
    status: `text not null default 'active' check(status in ('active', 'completed', 'failed'))`,
    created_at: `text not null`,
    updated_at: `text not null`,
  });
}
