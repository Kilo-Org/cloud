import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { hasSurvivingHostedRoot, hostedRootIdentity } from './hosted-root-guard';

function fakeDb(rows: { sessionId: string }[]) {
  let whereCondition: SQL | undefined;
  const select = {
    from: vi.fn(() => select),
    where: vi.fn((condition: SQL) => {
      whereCondition = condition;
      return select;
    }),
    limit: vi.fn(async () => rows),
  };
  return {
    db: { select: vi.fn(() => select) },
    condition: () => {
      if (!whereCondition) throw new Error('Expected a where condition');
      return new PgDialect().sqlToQuery(whereCondition);
    },
  };
}

describe('hosted root guard', () => {
  it('ignores rows without a Cloud Agent session identity', () => {
    expect(
      hostedRootIdentity({
        cloud_agent_session_id: null,
        cloud_agent_worktree_id: null,
        cloud_agent_session_scope_id: null,
      })
    ).toBeNull();
  });

  it('matches surviving siblings by scope root and workspace, excluding the target root', async () => {
    const { db, condition } = fakeDb([{ sessionId: 'ses_sibling' }]);

    await expect(
      hasSurvivingHostedRoot(
        db as never,
        'usr_owner',
        hostedRootIdentity({
          cloud_agent_session_id: 'workspace_root_a',
          cloud_agent_worktree_id: 'worktree_11111111-1111-4111-8111-111111111111',
          cloud_agent_session_scope_id: null,
        })!
      )
    ).resolves.toBe(true);

    const query = condition();
    expect(query.sql).toContain('"cli_sessions_v2"."kilo_user_id" = $1');
    expect(query.sql).toContain('"cli_sessions_v2"."parent_session_id" is null');
    expect(query.sql).toContain('"cli_sessions_v2"."cloud_agent_session_id" is not null');
    expect(query.sql).toContain('"cli_sessions_v2"."cloud_agent_session_id" <> $');
    expect(query.sql).toContain('"cli_sessions_v2"."cloud_agent_worktree_id" = $');
    expect(query.params).toEqual([
      'usr_owner',
      'workspace_root_a',
      'workspace_root_a',
      'worktree_11111111-1111-4111-8111-111111111111',
    ]);
  });

  it('omits the workspace predicate when the root has no workspace ID', async () => {
    const { db, condition } = fakeDb([]);

    await expect(
      hasSurvivingHostedRoot(db as never, 'usr_owner', {
        cloudAgentSessionId: 'workspace_root_a',
        worktreeId: null,
        scopeId: 'workspace_scope_a',
      })
    ).resolves.toBe(false);

    const query = condition();
    expect(query.sql).not.toContain('cloud_agent_worktree_id');
    expect(query.params).toEqual(['usr_owner', 'workspace_scope_a', 'workspace_scope_a']);
  });
});
