import { expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/pg-proxy';

const { getPgDb } = vi.hoisted(() => ({ getPgDb: vi.fn() }));
vi.mock('../../db/pg.js', () => ({ getPgDb }));
import { readOwnedHistoryLineage } from './history-lineage.js';

it('looks up child history through its user and Cloud session scope', async () => {
  const statements: { sql: string; params: unknown[] }[] = [];
  getPgDb.mockReturnValue(
    drizzle(async (sql, params) => {
      statements.push({ sql, params });
      return { rows: [['ses_root']] };
    })
  );
  expect(
    await readOwnedHistoryLineage({
      env: {} as Env,
      userId: 'oauth/history-user',
      sessionId: 'workspace_history',
      rootKiloSessionId: 'ses_root',
      kiloSessionId: 'ses_child',
    })
  ).toEqual({ parentID: 'ses_root' });
  expect(statements).toHaveLength(1);
  expect(statements[0].sql).toContain('"cloud_agent_session_scope_id" =');
  expect(statements[0].sql).not.toContain('"cloud_agent_session_id" =');
  expect(statements[0].params).toEqual(['oauth/history-user', 'ses_child', 'workspace_history', 1]);
});
