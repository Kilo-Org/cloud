import type * as DbClient from '@kilocode/db/client';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('@kilocode/db/client', async importOriginal => {
  const actual = await importOriginal<typeof DbClient>();
  return { ...actual, getWorkerDb: vi.fn() };
});
vi.mock('../../src/dos/SessionIngestDO', () => ({ getSessionIngestDO: vi.fn() }));
vi.mock('../../src/dos/SessionAccessCacheDO', () => ({ getSessionAccessCacheDO: vi.fn() }));
vi.mock('../../src/dos/UserConnectionDO', () => ({ getUserConnectionDO: vi.fn() }));

import { createDrizzleClient, getWorkerDb } from '@kilocode/db/client';
import {
  WORKTREE_UNREGISTERED_CHILD_SESSIONS,
  type CloudAgentWorktreeDeletionParams,
} from '@kilocode/session-ingest-contracts';
import { getSessionIngestDO } from '../../src/dos/SessionIngestDO';
import { getSessionAccessCacheDO } from '../../src/dos/SessionAccessCacheDO';
import { getUserConnectionDO } from '../../src/dos/UserConnectionDO';
import type { Env } from '../../src/env';
import { beginWorktreeDeletion } from '../../src/services/worktree-deletion';

const userId = 'oauth/worktree-delete-owner';
const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
const rootSessionId = 'ses_11111111111111111111111111';
const rootCloudSessionId = 'workspace_11111111-1111-4111-8111-111111111111';
const registeredChildId = 'ses_22222222222222222222222222';
const omittedChildId = 'ses_33333333333333333333333333';
const params = { worktreeId, kiloUserId: userId } satisfies CloudAgentWorktreeDeletionParams;
const env = { HYPERDRIVE: { connectionString: 'postgres://unused' } } as Env;
let client: ReturnType<typeof createDrizzleClient>;

beforeAll(async () => {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('Set POSTGRES_URL to a local test database');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
    throw new Error('The worktree deletion tests require a local PostgreSQL database');
  }
  client = createDrizzleClient({ connectionString, poolConfig: { max: 1 }, ssl: false });
  vi.mocked(getWorkerDb).mockReturnValue(client.db);
  await client.db.execute(sql`
    CREATE TEMP TABLE cloud_agent_worktrees (
      worktree_id text PRIMARY KEY,
      kilo_user_id text NOT NULL,
      organization_id uuid,
      folder_id uuid,
      name text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deletion_started_at timestamptz,
      deletion_completed_at timestamptz,
      runtime_locations jsonb NOT NULL DEFAULT '[]'::jsonb,
      deletion_manifest jsonb,
      deleted_session_ids text[] NOT NULL DEFAULT '{}'
    );
    CREATE TEMP TABLE cli_sessions_v2 (
      session_id text NOT NULL,
      kilo_user_id text NOT NULL,
      organization_id uuid,
      parent_session_id text,
      cloud_agent_session_id text,
      cloud_agent_session_scope_id text,
      cloud_agent_worktree_id text,
      PRIMARY KEY (session_id, kilo_user_id),
      CONSTRAINT cli_sessions_v2_parent_session_id_kilo_user_id_fk
        FOREIGN KEY (parent_session_id, kilo_user_id)
        REFERENCES pg_temp.cli_sessions_v2 (session_id, kilo_user_id)
        ON DELETE RESTRICT
    );
    CREATE INDEX "IDX_cli_sessions_v2_parent_session_id_kilo_user_id"
      ON pg_temp.cli_sessions_v2 (parent_session_id, kilo_user_id)
  `);
});

afterAll(async () => {
  if (client) await client.pool.end();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await client.db.execute(sql`
    TRUNCATE pg_temp.cli_sessions_v2, pg_temp.cloud_agent_worktrees
  `);
  await client.db.execute(sql`
    INSERT INTO pg_temp.cloud_agent_worktrees (worktree_id, kilo_user_id)
    VALUES (${worktreeId}, ${userId})
  `);
  await client.db.execute(sql`
    INSERT INTO pg_temp.cli_sessions_v2 (
      session_id, kilo_user_id, parent_session_id, cloud_agent_session_id,
      cloud_agent_session_scope_id, cloud_agent_worktree_id
    ) VALUES
      (${rootSessionId}, ${userId}, NULL, ${rootCloudSessionId}, NULL, ${worktreeId}),
      (${registeredChildId}, ${userId}, ${rootSessionId}, NULL, ${rootCloudSessionId}, ${worktreeId})
  `);
});

async function readState() {
  const sessions = await client.db.execute(sql`
    SELECT * FROM pg_temp.cli_sessions_v2 ORDER BY session_id
  `);
  const worktrees = await client.db.execute(sql`
    SELECT * FROM pg_temp.cloud_agent_worktrees ORDER BY worktree_id
  `);
  return { sessions: sessions.rows, worktrees: worktrees.rows };
}

describe('worktree deletion PostgreSQL membership boundary', () => {
  it.each([
    { parent: 'root', parentSessionId: rootSessionId },
    { parent: 'registered descendant', parentSessionId: registeredChildId },
  ])('rejects an omitted child of $parent until it is removed', async ({ parentSessionId }) => {
    await client.db.execute(sql`
      INSERT INTO pg_temp.cli_sessions_v2 (
        session_id, kilo_user_id, parent_session_id, cloud_agent_session_scope_id,
        cloud_agent_worktree_id
      ) VALUES (${omittedChildId}, ${userId}, ${parentSessionId}, ${rootCloudSessionId}, NULL)
    `);
    const before = await readState();

    await expect(
      client.db.transaction(tx =>
        tx.execute(sql`
          DELETE FROM pg_temp.cli_sessions_v2
          WHERE kilo_user_id = ${userId} AND cloud_agent_worktree_id = ${worktreeId}
        `)
      )
    ).rejects.toMatchObject({
      cause: {
        // PostgreSQL 18 separates RESTRICT from the earlier foreign-key error.
        code: expect.stringMatching(/^(23001|23503)$/),
        constraint: 'cli_sessions_v2_parent_session_id_kilo_user_id_fk',
      },
    });
    await expect(beginWorktreeDeletion(env, params)).rejects.toThrow(
      WORKTREE_UNREGISTERED_CHILD_SESSIONS
    );
    expect(await readState()).toEqual(before);
    expect(getSessionIngestDO).not.toHaveBeenCalled();
    expect(getSessionAccessCacheDO).not.toHaveBeenCalled();
    expect(getUserConnectionDO).not.toHaveBeenCalled();

    await client.db.execute(sql`
      DELETE FROM pg_temp.cli_sessions_v2
      WHERE session_id = ${omittedChildId} AND kilo_user_id = ${userId}
    `);
    await expect(beginWorktreeDeletion(env, params)).resolves.toEqual({
      completed: false,
      manifest: {
        version: 1,
        sessions: [
          { sessionId: rootSessionId, cloudAgentSessionId: rootCloudSessionId },
          { sessionId: registeredChildId, cloudAgentSessionId: null },
        ],
      },
      runtimeLocations: [],
    });
  });
});
