import { describe, expect, it } from 'vitest';
import { createTableUserRigs, migrateUserRigs } from './user-rigs.table';

function fakeSql(columns: string[]) {
  const statements: string[] = [];
  const sql = {
    exec(query: string) {
      statements.push(query);
      if (query.startsWith('PRAGMA')) return columns.map(name => ({ name }));
      if (query.startsWith('ALTER TABLE')) columns.push('platform_integration_id');
      return [];
    },
  } as unknown as SqlStorage;
  return { sql, statements };
}

describe('user_rigs platform integration migration', () => {
  it('adds the identity column to legacy owner storage and is idempotent', () => {
    const { sql, statements } = fakeSql([
      'id',
      'town_id',
      'name',
      'git_url',
      'default_branch',
      'created_at',
      'updated_at',
    ]);

    migrateUserRigs(sql);
    migrateUserRigs(sql);

    expect(statements.filter(statement => statement.startsWith('ALTER TABLE'))).toHaveLength(1);
  });

  it('declares platform_integration_id for newly created owner storage', () => {
    expect(createTableUserRigs()).toContain('"platform_integration_id" text');
  });
});
