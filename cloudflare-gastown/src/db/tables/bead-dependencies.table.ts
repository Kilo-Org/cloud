import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const DependencyType = z.enum(['blocks', 'tracks', 'parent-child']);

export const BeadDependencyRecord = z.object({
  bead_id: z.string(),
  depends_on_bead_id: z.string(),
  dependency_type: DependencyType,
});

export type BeadDependencyRecord = z.output<typeof BeadDependencyRecord>;

export const bead_dependencies = getTableFromZodSchema('bead_dependencies', BeadDependencyRecord);

export function createTableBeadDependencies(): string {
  return getCreateTableQueryFromTable(bead_dependencies, {
    bead_id: `text not null references beads(bead_id)`,
    depends_on_bead_id: `text not null references beads(bead_id)`,
    dependency_type: `text not null default 'blocks' check(dependency_type in ('blocks', 'tracks', 'parent-child'))`,
  });
}

export function getIndexesBeadDependencies(): string[] {
  return [
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_bead_deps_pk ON ${bead_dependencies}(${bead_dependencies.columns.bead_id}, ${bead_dependencies.columns.depends_on_bead_id})`,
    `CREATE INDEX IF NOT EXISTS idx_bead_deps_depends_on ON ${bead_dependencies}(${bead_dependencies.columns.depends_on_bead_id})`,
  ];
}
