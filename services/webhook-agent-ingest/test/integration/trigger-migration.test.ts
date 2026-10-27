import { env, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { describe, expect, it } from 'vitest';
import migrations from '../../drizzle/migrations';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { requests } from '../../src/db/sqlite-schema';

const legacyTriggerConfig = sqliteTable('trigger_config', {
  trigger_id: text('trigger_id'),
  namespace: text('namespace'),
  user_id: text('user_id'),
  created_at: text('created_at'),
  prompt_template: text('prompt_template'),
  github_repo: text('github_repo'),
  profile_id: text('profile_id'),
  mode: text('mode'),
  model: text('model'),
});

describe('trigger body schema migration', () => {
  it('preserves saved configuration and captured requests and defaults validation off', async () => {
    const stub = env.TRIGGER_DO.get(env.TRIGGER_DO.idFromName('user/migration/preservation'));
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.deleteAll();
      const db = drizzle(state.storage);
      await migrate(db, {
        ...migrations,
        journal: { ...migrations.journal, entries: migrations.journal.entries.slice(0, -1) },
      });
      db.insert(legacyTriggerConfig)
        .values({
          trigger_id: 'preserved',
          namespace: 'user/migration',
          user_id: 'migration',
          created_at: '2026-10-22T12:00:00Z',
          prompt_template: '{{body}}',
          github_repo: 'owner/repo',
          profile_id: 'saved-profile',
          mode: 'code',
          model: 'model',
        })
        .run();
      db.insert(requests)
        .values({
          id: 'saved-request',
          timestamp: '2026-10-22T12:00:00Z',
          method: 'POST',
          path: '/',
          headers: '{}',
          body: ' preserved body ',
        })
        .run();
      await migrate(db, migrations);
      expect(await instance.getConfig()).toMatchObject({
        triggerId: 'preserved',
        profileId: 'saved-profile',
        bodySchema: null,
        githubRepo: 'owner/repo',
      });
      expect(await instance.getRequest('saved-request')).toMatchObject({
        body: ' preserved body ',
        processStatus: 'captured',
      });
    });
  });
});
