import { describe, expect, it } from '@jest/globals';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import * as fs from 'fs';
import * as path from 'path';
import {
  spend_alert_deliveries,
  spend_alert_hourly,
  spend_alert_rule_state,
  spend_alert_rules,
  spend_alert_settings,
  user_notification_preferences,
} from './schema';

type IndexSnapshot = { name: string | undefined; columns: (string | undefined)[] };

type TableSnapshot = {
  name: string;
  columns: Map<string, ReturnType<typeof getTableConfig>['columns'][number]>;
  uniqueIndexes: IndexSnapshot[];
  indexes: IndexSnapshot[];
  uniqueConstraints: IndexSnapshot[];
  checks: string[];
};

function snapshot(table: PgTable): TableSnapshot {
  const config = getTableConfig(table);
  const indexColumns = (index: { config: { columns: unknown[] } }): (string | undefined)[] =>
    index.config.columns.map(column => (column as { name?: string }).name);

  return {
    name: config.name,
    columns: new Map(config.columns.map(column => [column.name, column])),
    uniqueIndexes: config.indexes
      .filter(index => index.config.unique)
      .map(index => ({ name: index.config.name, columns: indexColumns(index) })),
    indexes: config.indexes
      .filter(index => !index.config.unique)
      .map(index => ({ name: index.config.name, columns: indexColumns(index) })),
    uniqueConstraints: config.uniqueConstraints.map(constraint => ({
      name: constraint.getName(),
      columns: constraint.columns.map(column => column.name),
    })),
    checks: config.checks.map(check => check.name),
  };
}

describe('spend alert schema', () => {
  it('stores the per-owner spend alert settings with exactly one scope column', () => {
    const table = snapshot(spend_alert_settings);

    expect(table.name).toBe('spend_alert_settings');
    expect([...table.columns.keys()]).toEqual(
      expect.arrayContaining([
        'id',
        'scope_key',
        'kilo_user_id',
        'organization_id',
        'enabled',
        'created_at',
        'updated_at',
      ])
    );
    expect(table.uniqueIndexes).toEqual([
      { name: 'uq_spend_alert_settings_scope', columns: ['scope_key'] },
    ]);
    expect(table.checks).toEqual(['spend_alert_settings_scope_check']);
    expect(table.columns.get('scope_key')?.notNull).toBe(true);
    expect(table.columns.get('enabled')?.notNull).toBe(true);
    expect(table.columns.get('enabled')?.default).toBe(false);
  });

  it('keeps one rule per kind per settings row', () => {
    const table = snapshot(spend_alert_rules);

    expect(table.name).toBe('spend_alert_rules');
    expect(table.uniqueIndexes).toEqual([
      { name: 'uq_spend_alert_rules_kind', columns: ['settings_id', 'kind'] },
    ]);
    expect(table.columns.get('settings_id')?.notNull).toBe(true);
    expect([...table.columns.keys()]).toEqual(
      expect.arrayContaining([
        'threshold_microdollars',
        'window_hours',
        'multiplier_basis_points',
        'email_enabled',
        'push_enabled',
      ])
    );
  });

  it('keeps one firing state row per rule', () => {
    const table = snapshot(spend_alert_rule_state);

    expect(table.name).toBe('spend_alert_rule_state');
    expect(table.columns.get('rule_id')?.primary).toBe(true);
    expect(table.columns.get('rule_id')?.notNull).toBe(true);
    expect(table.columns.get('firing')?.default).toBe(false);
    expect(table.columns.get('firing')?.notNull).toBe(true);
  });

  it('keys the hourly counter by scope and hour for the sweep upsert', () => {
    const table = snapshot(spend_alert_hourly);

    expect(table.name).toBe('spend_alert_hourly');
    expect(table.uniqueIndexes).toEqual([
      { name: 'uq_spend_alert_hourly_scope_hour', columns: ['scope_key', 'hour_start'] },
    ]);
    expect(table.indexes).toEqual([
      { name: 'IDX_spend_alert_hourly_hour_start', columns: ['hour_start'] },
    ]);
  });

  it('deduplicates deliveries and orders the pending queue', () => {
    const table = snapshot(spend_alert_deliveries);

    expect(table.name).toBe('spend_alert_deliveries');
    expect(table.columns.get('dedupe_key')?.notNull).toBe(true);
    expect(table.uniqueConstraints).toEqual([
      { name: 'UQ_spend_alert_deliveries_dedupe_key', columns: ['dedupe_key'] },
    ]);
    expect(table.indexes).toEqual([
      {
        name: 'IDX_spend_alert_deliveries_pending',
        columns: ['status', 'next_attempt_at', 'attempt_count', 'id'],
      },
    ]);
    expect([...table.columns.keys()]).toEqual(
      expect.arrayContaining(['rule_id', 'kind', 'channel', 'fired_at', 'recipients', 'payload'])
    );
  });

  it('adds the spend alerts notification category beside the existing ones', () => {
    const column = snapshot(user_notification_preferences).columns.get('spend_alerts_enabled');

    expect(column).toBeDefined();
    expect(column?.dataType).toBe('boolean');
    expect(column?.notNull).toBe(true);
    expect(column?.default).toBe(true);
  });

  it('generates a migration that creates every spend alert table', () => {
    const migrationsDir = path.join(__dirname, 'migrations');
    const sqlFiles = fs.readdirSync(migrationsDir).filter(file => file.endsWith('.sql'));
    expect(sqlFiles.length).toBeGreaterThan(0);

    const tables = [
      'spend_alert_settings',
      'spend_alert_rules',
      'spend_alert_rule_state',
      'spend_alert_hourly',
      'spend_alert_deliveries',
    ];

    for (const table of tables) {
      const matchingFiles = sqlFiles.filter(file =>
        fs.readFileSync(path.join(migrationsDir, file), 'utf8').includes(`CREATE TABLE "${table}"`)
      );
      expect(matchingFiles).not.toHaveLength(0);
    }
  });
});
