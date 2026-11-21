/* eslint-disable drizzle/enforce-delete-with-where */
import { Client, db } from '@kilocode/web-shared/lib/drizzle';
import { computeDatabaseUrl } from '@kilocode/db';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { agent_configs, kilocode_users } from '@kilocode/db/schema';
import type { Client as PgClient } from 'pg';
import { and, eq } from 'drizzle-orm';

import {
  getReviewMemoryEnabledFromConfig,
  isReviewMemoryEnabled,
  setReviewMemoryEnabled,
} from './settings';

/**
 * Counts backends waiting on a lock for a statement that touches `agent_configs`.
 * The observation runs on its own connection, and `pg_backend_pid()` keeps the
 * counter from matching the observation statement itself.
 */
const AGENT_CONFIG_LOCK_WAITERS = `
  SELECT count(*)::int AS blocked
  FROM pg_stat_activity
  WHERE datname = current_database()
    AND pid <> pg_backend_pid()
    AND state = 'active'
    AND wait_event_type = 'Lock'
    AND query ILIKE '%agent_configs%'
`;

/**
 * Poll pacing for the lock wait below. The awaited condition is the Postgres lock,
 * which no fake timer can drive; 50 ms only bounds how often the monitor looks.
 */
async function pollDelay(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 50);
  return promise;
}

/**
 * Waits until the config write is queued behind the held row lock. The wait is a
 * Postgres lock, not a timer, so it is polled on a connection of its own.
 */
async function waitForAgentConfigLockWaiters(monitor: PgClient): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { rows } = await monitor.query<{ blocked: number }>(AGENT_CONFIG_LOCK_WAITERS);
    if ((rows[0]?.blocked ?? 0) > 0) {
      return;
    }
    await pollDelay();
  }
  throw new Error('expected the config write to wait on the held agent_configs row lock');
}

describe('review memory settings', () => {
  afterEach(async () => {
    await db.delete(agent_configs);
    await db.delete(kilocode_users);
  });

  it('defaults missing values to disabled and persists enabled settings', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };

    await expect(isReviewMemoryEnabled({ owner, platform: 'github' })).resolves.toBe(false);
    expect(getReviewMemoryEnabledFromConfig({ disable_review_md: true })).toBe(false);

    await setReviewMemoryEnabled({ owner, platform: 'github', enabled: true, createdBy: user.id });

    await expect(isReviewMemoryEnabled({ owner, platform: 'github' })).resolves.toBe(true);
    const config = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.agent_type, 'code_review'),
        eq(agent_configs.platform, 'github'),
        eq(agent_configs.owned_by_user_id, user.id)
      ),
    });
    expect(config?.is_enabled).toBe(false);
    expect(config?.config).toEqual(expect.objectContaining({ review_memory_enabled: true }));
  });

  it('keeps a key another writer saved while the toggle waits on the row', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };

    await db.insert(agent_configs).values({
      owned_by_user_id: user.id,
      agent_type: 'code_review',
      platform: 'github',
      config: { custom_instructions: 'before' },
      is_enabled: true,
      created_by: user.id,
    });

    const blocker = new Client({ connectionString: computeDatabaseUrl() });
    const monitor = new Client({ connectionString: computeDatabaseUrl() });
    let pending: Promise<boolean> | undefined;
    await blocker.connect();
    await monitor.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        `UPDATE agent_configs
            SET config = config || '{"custom_instructions":"concurrent save"}'::jsonb,
                is_enabled = is_enabled
          WHERE owned_by_user_id = $1
            AND agent_type = 'code_review'
            AND platform = 'github'`,
        [user.id]
      );

      pending = setReviewMemoryEnabled({
        owner,
        platform: 'github',
        enabled: true,
        createdBy: user.id,
      });

      await waitForAgentConfigLockWaiters(monitor);
      await blocker.query('COMMIT');
      await expect(pending).resolves.toBe(true);
    } finally {
      await blocker.end();
      await monitor.end();
      if (pending) {
        await pending.catch(() => undefined);
      }
    }

    const row = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.agent_type, 'code_review'),
        eq(agent_configs.platform, 'github'),
        eq(agent_configs.owned_by_user_id, user.id)
      ),
    });
    expect(row?.config).toEqual(
      expect.objectContaining({
        custom_instructions: 'concurrent save',
        review_memory_enabled: true,
      })
    );
    expect(row?.is_enabled).toBe(true);
  });
});
