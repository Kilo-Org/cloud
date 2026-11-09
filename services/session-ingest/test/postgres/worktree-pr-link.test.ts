import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDrizzleClient, type DrizzleClient } from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { inheritWorktreePullRequestLink } from '../../src/services/worktree-pr-link';

const userId = 'oauth/worktree-pr-link-test';
const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
const gitUrl = 'https://github.com/acme/widgets';
const prUrl = `${gitUrl}/pull/42`;
let client: DrizzleClient;

beforeAll(async () => {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('Set POSTGRES_URL to a local test database');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
    throw new Error('Worktree PR link tests require a local PostgreSQL database');
  }
  client = createDrizzleClient({ connectionString, poolConfig: { max: 1 }, ssl: false });
  // A session-local copy of the table tests the real queries without changing shared data.
  await client.db.execute(sql`
    CREATE TEMP TABLE cli_sessions_v2 (LIKE public.cli_sessions_v2 INCLUDING DEFAULTS)
  `);
});

afterAll(async () => {
  if (client) await client.pool.end();
});

beforeEach(async () => {
  await client.db.execute(sql`TRUNCATE pg_temp.cli_sessions_v2`);
});

async function insertSession(
  sessionId: string,
  overrides: Partial<typeof cli_sessions_v2.$inferInsert> = {}
) {
  const [row] = await client.db
    .insert(cli_sessions_v2)
    .values({
      session_id: sessionId,
      kilo_user_id: userId,
      cloud_agent_worktree_id: worktreeId,
      git_url: gitUrl,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('insert failed');
  return row;
}

const verifiedLink = {
  platform: 'github',
  pr_url: prUrl,
  pr_number: 42,
  pr_head_ref: 'kilo/feature',
  pr_head_sha: null,
  pr_link_verified_at: '2026-11-01T10:00:00.000Z',
};

async function readLink(sessionId: string) {
  const [row] = await client.db
    .select({
      pr_url: cli_sessions_v2.pr_url,
      pr_number: cli_sessions_v2.pr_number,
      pr_head_ref: cli_sessions_v2.pr_head_ref,
      verified: cli_sessions_v2.pr_link_verified_at,
    })
    .from(cli_sessions_v2)
    .where(
      and(eq(cli_sessions_v2.session_id, sessionId), eq(cli_sessions_v2.kilo_user_id, userId))
    );
  return row;
}

describe('inheritWorktreePullRequestLink', () => {
  it("copies a sibling chat's verified link onto a new chat", async () => {
    await insertSession('ses_sibling', verifiedLink);
    const created = await insertSession('ses_new');

    const result = await inheritWorktreePullRequestLink(client.db, created);

    expect(result.pr_url).toBe(prUrl);
    expect(await readLink('ses_new')).toMatchObject({
      pr_url: prUrl,
      pr_number: 42,
      pr_head_ref: 'kilo/feature',
      verified: expect.any(String),
    });
  });

  it('ignores unverified links, other worktrees, other repositories and child sessions', async () => {
    await insertSession('ses_unverified', { ...verifiedLink, pr_link_verified_at: null });
    await insertSession('ses_other_worktree', {
      ...verifiedLink,
      cloud_agent_worktree_id: 'worktree_22222222-2222-4222-8222-222222222222',
    });
    await insertSession('ses_other_repo', {
      ...verifiedLink,
      git_url: 'https://github.com/acme/other',
    });
    await insertSession('ses_root');
    await insertSession('ses_child', { ...verifiedLink, parent_session_id: 'ses_root' });
    const created = await insertSession('ses_new');

    const result = await inheritWorktreePullRequestLink(client.db, created);

    expect(result).toBe(created);
    expect((await readLink('ses_new')).pr_url).toBeNull();
  });

  it('does nothing for a session outside a worktree', async () => {
    await insertSession('ses_sibling', verifiedLink);
    const created = await insertSession('ses_new', { cloud_agent_worktree_id: null });

    expect(await inheritWorktreePullRequestLink(client.db, created)).toBe(created);
    expect((await readLink('ses_new')).pr_url).toBeNull();
  });
});
