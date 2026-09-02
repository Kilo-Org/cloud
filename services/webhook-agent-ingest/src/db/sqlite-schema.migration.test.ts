import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

type Row = Record<string, unknown>;

async function executeMigration(db: DatabaseSync, filename: string): Promise<void> {
  const sql = await readFile(resolve(import.meta.dirname, '../../drizzle', filename), 'utf8');
  for (const statement of sql.split('--> statement-breakpoint')) {
    db.exec(statement);
  }
}

function insertLegacyRows(db: DatabaseSync, includeVariant: boolean): void {
  const insert = db.prepare(
    `INSERT INTO trigger_config (
      trigger_id, namespace, user_id, created_at, is_active, target_type, github_repo,
      mode, model, ${includeVariant ? 'variant, ' : ''}prompt_template, profile_id, auto_commit,
      condense_on_complete, activation_mode, cron_expression, cron_timezone, last_scheduled_at,
      next_scheduled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${includeVariant ? '?, ' : ''}?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const [triggerId, activationMode, cronExpression, variant] of [
    ['legacy-scheduled', 'scheduled', '* * * * *', 'high'],
    ['legacy-webhook', 'webhook', null, null],
  ] as const) {
    insert.run(
      triggerId,
      'user/user-1',
      'user-1',
      '2026-01-01T00:00:00.000Z',
      1,
      'cloud_agent',
      'owner/repo',
      'code',
      'openai/gpt-4.1',
      ...(includeVariant ? [variant] : []),
      'Process {{body}}',
      'profile-1',
      1,
      0,
      activationMode,
      cronExpression,
      'UTC',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:01:00.000Z'
    );
  }
}

describe('trigger config sandbox allocation migration', () => {
  it('preserves legacy webhook and scheduled rows when migrating from 0002 to 0003', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      await executeMigration(db, '0000_lumpy_loners.sql');
      await executeMigration(db, '0001_dear_tombstone.sql');
      await executeMigration(db, '0002_first_mephisto.sql');
      insertLegacyRows(db, false);
      const before = db.prepare('SELECT * FROM trigger_config ORDER BY trigger_id').all() as Row[];

      await executeMigration(db, '0003_sparkling_kate_bishop.sql');
      const after = db.prepare('SELECT * FROM trigger_config ORDER BY trigger_id').all() as Row[];

      expect(after).toEqual(before.map(row => ({ ...row, variant: null })));
    } finally {
      db.close();
    }
  });

  it('preserves existing configurations and variants from 0003 to 0004', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      await executeMigration(db, '0000_lumpy_loners.sql');
      await executeMigration(db, '0001_dear_tombstone.sql');
      await executeMigration(db, '0002_first_mephisto.sql');
      await executeMigration(db, '0003_sparkling_kate_bishop.sql');
      insertLegacyRows(db, true);
      const before = db.prepare('SELECT * FROM trigger_config ORDER BY trigger_id').all() as Row[];

      await executeMigration(db, '0004_bumpy_firebird.sql');
      const after = db.prepare('SELECT * FROM trigger_config ORDER BY trigger_id').all() as Row[];

      expect(after).toEqual(before.map(row => ({ ...row, sandbox_allocation: null })));
    } finally {
      db.close();
    }
  });
});
