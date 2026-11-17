import type * as DbClient from '@kilocode/db/client';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {},
  WorkerEntrypoint: class WorkerEntrypoint {
    env: unknown;
    ctx: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock('@kilocode/db/client', async importOriginal => {
  const actual = await importOriginal<typeof DbClient>();
  return { ...actual, getWorkerDb: vi.fn() };
});

vi.mock('../../src/dos/UserConnectionDO', () => ({
  getUserConnectionDO: vi.fn(() => ({ notifySessionEvent: async () => undefined })),
}));

// Local DO and R2 cleanup is a side-effect boundary of these routes; the
// Postgres state is what this suite verifies.
vi.mock('../../src/services/session-local-state', () => ({
  clearSessionLocalState: vi.fn(async () => undefined),
}));

import { createDrizzleClient, getWorkerDb } from '@kilocode/db/client';
import type { Env } from '../../src/env';
import { api } from '../../src/routes/api';
import { clearSessionLocalState } from '../../src/services/session-local-state';
import { beforeEach as clearCounters } from 'vitest';

const owner = 'oauth/user-delete-audience-owner';
const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
const secondWorktreeId = 'worktree_22222222-2222-4222-8222-222222222222';
const rootSessionId = 'ses_rootrootrootrootrootroot01';
const scopedChildSessionId = 'ses_childchildchildchildchildc';
const unscopedFallbackChildSessionId = 'ses_childfallbackfallbackfallx';
const rootLeafSessionId = 'ses_leafleafleafleafleafleafle';
const rootCloudSessionId = 'workspace_11111111-1111-4111-8111-111111111111';

let client: ReturnType<typeof createDrizzleClient>;

beforeAll(async () => {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('Set POSTGRES_URL to a local test database');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
    throw new Error('The user-deletion session delete tests require a local PostgreSQL database');
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
      deleted_session_ids text[] NOT NULL DEFAULT '{}'::text[]
    );
    CREATE TEMP TABLE cli_sessions_v2 (
      session_id text NOT NULL,
      kilo_user_id text NOT NULL,
      version integer NOT NULL DEFAULT 0,
      title text,
      public_id uuid,
      parent_session_id text,
      organization_id uuid,
      profile_id uuid,
      cloud_agent_session_id text,
      cloud_agent_session_scope_id text,
      cloud_agent_worktree_id text,
      created_on_platform text NOT NULL DEFAULT 'unknown',
      git_url text,
      git_branch text,
      platform text,
      pr_url text,
      pr_number integer,
      pr_head_ref text,
      pr_head_sha text,
      pr_link_verified_at timestamptz,
      status text,
      status_updated_at timestamptz,
      status_transition_id text,
      last_activity_at timestamptz,
      total_cost_microdollars bigint,
      live_summary jsonb,
      briefing_excerpt jsonb,
      briefing_excerpt_scope_changed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (session_id, kilo_user_id)
    );
  `);
});

afterAll(async () => {
  if (client) await client.pool.end();
});

clearCounters(() => {
  vi.mocked(clearSessionLocalState).mockClear();
});

beforeEach(async () => {
  await client.db.execute(sql`
    TRUNCATE pg_temp.cli_sessions_v2, pg_temp.cloud_agent_worktrees
  `);
  await client.db.execute(sql`
    INSERT INTO pg_temp.cloud_agent_worktrees (worktree_id, kilo_user_id)
    VALUES (${worktreeId}, ${owner}), (${secondWorktreeId}, ${owner})
  `);
  await client.db.execute(sql`
    INSERT INTO pg_temp.cli_sessions_v2 (
      session_id, kilo_user_id, cloud_agent_session_id, cloud_agent_session_scope_id,
      cloud_agent_worktree_id, parent_session_id
    ) VALUES
      (${rootSessionId}, ${owner}, ${rootCloudSessionId}, NULL, ${worktreeId}, NULL),
      (${scopedChildSessionId}, ${owner}, NULL, ${rootCloudSessionId}, ${worktreeId}, ${rootSessionId}),
      (${unscopedFallbackChildSessionId}, ${owner}, NULL, ${rootCloudSessionId}, NULL, ${rootSessionId}),
      (${rootLeafSessionId}, ${owner}, NULL, NULL, ${secondWorktreeId}, NULL)
  `);
});

function makeApp() {
  const app = new Hono<{
    Bindings: Env;
    Variables: { user_id: string; deletionAudience?: boolean };
  }>();
  // Reproduces what kilo-jwt-auth sets for a user-deletion audience token.
  app.use('*', async (c, next) => {
    c.set('user_id', owner);
    c.set('deletionAudience', true);
    await next();
  });
  app.route('/api', api);
  return app;
}

function boundEnv(): Env {
  return { HYPERDRIVE: { connectionString: 'postgres://unused' } } as unknown as Env;
}

async function sessionIds(): Promise<string[]> {
  const result = await client.db.execute<{ session_id: string }>(sql`
    SELECT session_id FROM pg_temp.cli_sessions_v2
  `);
  return result.rows.map(row => row.session_id);
}

async function sessionCount(): Promise<number> {
  const result = await client.db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM pg_temp.cli_sessions_v2
  `);
  return Number(result.rows[0]?.n ?? 0);
}

async function startWorktreeDeletion(sessionIds: string[]): Promise<void> {
  await client.db.execute(sql`
    UPDATE pg_temp.cloud_agent_worktrees
    SET deletion_started_at = now(),
        deletion_manifest = ${JSON.stringify({
          version: 1,
          sessions: sessionIds.map(sessionId => ({ sessionId, cloudAgentSessionId: null })),
        })}::jsonb
    WHERE worktree_id = ${worktreeId}
  `);
}

// Mirrors the worktree deletion's content stage, which removes the member rows,
// and its finalize stage, which keeps the start marker and completes the fence.
async function finishWorktreeDeletion(sessionIds: string[]): Promise<void> {
  const inList = sql.join(
    sessionIds.map(sessionId => sql`${sessionId}`),
    sql`, `
  );
  await client.db.execute(sql`
    DELETE FROM pg_temp.cli_sessions_v2
    WHERE kilo_user_id = ${owner} AND session_id IN (${inList})
  `);
  await client.db.execute(sql`
    UPDATE pg_temp.cloud_agent_worktrees
    SET deletion_completed_at = now(),
        deletion_manifest = NULL,
        deleted_session_ids = ARRAY[${inList}]::text[]
    WHERE worktree_id = ${worktreeId}
  `);
}

describe('DELETE /session/:sessionId with a user-deletion audience', () => {
  it('refuses leaf deletes while the worktree deletion runs', async () => {
    const app = makeApp();
    const env = boundEnv();
    await startWorktreeDeletion([
      rootSessionId,
      scopedChildSessionId,
      unscopedFallbackChildSessionId,
    ]);

    for (const sessionId of [rootSessionId, scopedChildSessionId, unscopedFallbackChildSessionId]) {
      const res = await app.request(`/api/session/${sessionId}`, { method: 'DELETE' }, env);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ success: false, error: 'worktree_deleting' });
    }

    expect(await sessionCount()).toBe(4);
    expect(await sessionIds()).toEqual(
      expect.arrayContaining([
        rootSessionId,
        scopedChildSessionId,
        unscopedFallbackChildSessionId,
        rootLeafSessionId,
      ])
    );
    expect(clearSessionLocalState).not.toHaveBeenCalled();
  });

  it('continues the account-deletion delete after the worktree deletion removes the rows', async () => {
    const app = makeApp();
    const env = boundEnv();
    const deletedDuringWorktreeDeletion = [
      rootSessionId,
      scopedChildSessionId,
      unscopedFallbackChildSessionId,
    ];
    await startWorktreeDeletion(deletedDuringWorktreeDeletion);

    const blocked = await app.request(`/api/session/${rootSessionId}`, { method: 'DELETE' }, env);
    expect(blocked.status).toBe(409);

    await finishWorktreeDeletion(deletedDuringWorktreeDeletion);

    const afterRoot = await app.request(`/api/session/${rootSessionId}`, { method: 'DELETE' }, env);
    expect(afterRoot.status).toBe(404);
    expect(await afterRoot.json()).toEqual({
      success: false,
      error: 'session_not_found',
      cleanup: 'done',
    });
    const afterChild = await app.request(
      `/api/session/${scopedChildSessionId}`,
      { method: 'DELETE' },
      env
    );
    expect(afterChild.status).toBe(404);
    expect(clearSessionLocalState).toHaveBeenCalledTimes(2);
    expect(await sessionIds()).toEqual([rootLeafSessionId]);
  });

  it('deletes a leaf whose worktree is not deleting', async () => {
    const app = makeApp();
    const env = boundEnv();

    const res = await app.request(`/api/session/${rootLeafSessionId}`, { method: 'DELETE' }, env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(await sessionCount()).toBe(3);
    expect(await sessionIds()).not.toContain(rootLeafSessionId);
    expect(clearSessionLocalState).toHaveBeenCalledTimes(1);
  });

  it('still clears local state when the owned row is already gone', async () => {
    await client.db.execute(sql`
      DELETE FROM pg_temp.cli_sessions_v2 WHERE session_id = ${rootLeafSessionId}
    `);
    const app = makeApp();

    const res = await app.request(
      `/api/session/${rootLeafSessionId}`,
      { method: 'DELETE' },
      boundEnv()
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      success: false,
      error: 'session_not_found',
      cleanup: 'done',
    });
    expect(clearSessionLocalState).toHaveBeenCalledTimes(1);
  });
});
