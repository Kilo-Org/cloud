import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { describe, expect, it } from 'vitest';
import { triggerConfig } from './sqlite-schema';

type Row = Record<string, unknown>;

async function executeMigration(db: DatabaseSync, filename: string): Promise<void> {
  const sql = await readFile(resolve(import.meta.dirname, '../../drizzle', filename), 'utf8');
  for (const statement of sql.split('--> statement-breakpoint')) {
    db.exec(statement);
  }
}

describe('trigger config variant migration', () => {
  it('preserves legacy webhook and scheduled rows and leaves variants unset', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      await executeMigration(db, '0000_lumpy_loners.sql');
      await executeMigration(db, '0001_dear_tombstone.sql');
      await executeMigration(db, '0002_first_mephisto.sql');
      const insert = db.prepare(
        `INSERT INTO trigger_config (
          trigger_id, namespace, user_id, created_at, is_active, target_type, github_repo,
          mode, model, prompt_template, profile_id, auto_commit, condense_on_complete,
          activation_mode, cron_expression, cron_timezone, last_scheduled_at, next_scheduled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const [triggerId, activationMode, cronExpression] of [
        ['legacy-scheduled', 'scheduled', '* * * * *'],
        ['legacy-webhook', 'webhook', null],
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
      const before = db.prepare('SELECT * FROM trigger_config ORDER BY trigger_id').all() as Row[];

      await executeMigration(db, '0003_sparkling_kate_bishop.sql');

      const orm = drizzle(
        async (query, params, method) => {
          const statement = db.prepare(query);
          if (method === 'run') {
            statement.run(...params);
            return { rows: [] };
          }
          if (method === 'get') {
            const row = statement.get(...params) as Row | undefined;
            return { rows: row ? [Object.values(row)] : [] };
          }
          return { rows: (statement.all(...params) as Row[]).map(row => Object.values(row)) };
        },
        { schema: { triggerConfig } }
      );
      const after = await orm.select().from(triggerConfig).orderBy(triggerConfig.trigger_id);

      expect(after).toEqual(before.map(row => ({ ...row, variant: null })));
    } finally {
      db.close();
    }
  });
});
