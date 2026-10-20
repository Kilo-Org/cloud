import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import migrations from './drizzle/migrations.js';
import {
  controlPlaneMessages,
  eventMutationCursor,
  events,
  historyImport,
} from './sqlite-schema.js';

const tableSchema = z
  .object({
    name: z.string(),
    columns: z.record(z.string(), z.unknown()),
    indexes: z.record(z.string(), z.unknown()),
  })
  .passthrough();
const snapshotSchema = z.object({
  id: z.string(),
  prevId: z.string(),
  tables: z.record(z.string(), tableSchema),
});
const snapshots = ['0001', '0002', '0003', '0004'].map(version =>
  snapshotSchema.parse(
    JSON.parse(
      readFileSync(new URL(`./drizzle/meta/${version}_snapshot.json`, import.meta.url), 'utf8')
    )
  )
);

describe('restored history migration bundle', () => {
  it('preserves the existing coordinator schema and the complete snapshot ancestry', () => {
    const baseline = snapshots[0];
    for (let index = 1; index < snapshots.length; index += 1) {
      expect(snapshots[index].prevId).toBe(snapshots[index - 1].id);
      expect(snapshots[index].tables.control_plane_messages).toEqual(
        baseline.tables.control_plane_messages
      );
      expect(snapshots[index].tables.events.columns).toEqual({
        ...baseline.tables.events.columns,
        mutation_cursor: {
          name: 'mutation_cursor',
          type: 'integer',
          primaryKey: false,
          notNull: true,
          autoincrement: false,
          default: 0,
        },
      });
      expect(snapshots[index].tables.events.indexes).toEqual({
        ...baseline.tables.events.indexes,
        idx_events_mutation_cursor: {
          name: 'idx_events_mutation_cursor',
          columns: ['mutation_cursor'],
          isUnique: false,
        },
      });
    }
  });

  it('matches the final Drizzle table and column identities', () => {
    const final = snapshots.at(-1);
    if (final === undefined) throw new Error('Missing final snapshot');
    const tables = [events, eventMutationCursor, historyImport, controlPlaneMessages].map(
      getTableConfig
    );
    expect(Object.keys(final.tables).sort()).toEqual(tables.map(table => table.name).sort());
    for (const table of tables)
      expect(Object.keys(final.tables[table.name].columns).sort()).toEqual(
        table.columns.map(column => column.name).sort()
      );
  });

  it('bundles every journal entry and backfills the replay watermark without rewriting event identities', () => {
    expect(migrations.journal.entries.map(entry => entry.tag)).toEqual([
      '0000_open_union_jack',
      '0001_medical_thunderbolt',
      '0002_session_mutation_cursor',
      '0003_history_hydration_stage',
      '0004_native_history_scope',
    ]);
    expect(Object.keys(migrations.migrations)).toEqual([
      'm0000',
      'm0001',
      'm0002',
      'm0003',
      'm0004',
    ]);
    expect(migrations.migrations.m0002).toContain('UPDATE `events` SET `mutation_cursor` = `id`');
    expect(migrations.migrations.m0002).toContain('coalesce(max(`mutation_cursor`), 0)');
    expect(migrations.migrations.m0002).not.toMatch(/SET\s+`id`/);
  });

  it('indexes scoped chronological hydration batches in the schema, snapshot and migration', () => {
    const name = 'idx_history_import_scope_timestamp_entity';
    const columns = ['kilo_session_id', 'timestamp', 'entity_id'];
    const table = getTableConfig(historyImport);
    expect(table.indexes.map(index => index.config.name)).toEqual([name]);
    expect(table.indexes[0].config.columns).toEqual([
      historyImport.kilo_session_id,
      historyImport.timestamp,
      historyImport.entity_id,
    ]);
    expect(snapshots.at(-1)?.tables.history_import.indexes).toEqual({
      [name]: { name, columns, isUnique: false },
    });
    expect(migrations.migrations.m0004).toContain(
      `CREATE INDEX \`${name}\` ON \`history_import\` (\`kilo_session_id\`,\`timestamp\`,\`entity_id\`)`
    );
  });
});
