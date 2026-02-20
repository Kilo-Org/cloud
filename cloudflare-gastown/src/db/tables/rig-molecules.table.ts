import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

const MoleculeStatus = z.enum(['active', 'completed', 'failed']);

export const RigMoleculeRecord = z.object({
  id: z.string(),
  bead_id: z.string(),
  formula: z.string().transform(v => JSON.parse(v) as unknown),
  current_step: z.number(),
  status: MoleculeStatus,
  created_at: z.string(),
  updated_at: z.string(),
});

export type RigMoleculeRecord = z.output<typeof RigMoleculeRecord>;

export const rig_molecules = getTableFromZodSchema('rig_molecules', RigMoleculeRecord);

export function createTableRigMolecules(): string {
  return getCreateTableQueryFromTable(rig_molecules, {
    id: `text primary key`,
    bead_id: `text not null references rig_beads(id)`,
    formula: `text not null`,
    current_step: `integer not null default 0`,
    status: `text not null default 'active' check(status in ('active', 'completed', 'failed'))`,
    created_at: `text not null`,
    updated_at: `text not null`,
  });
}
