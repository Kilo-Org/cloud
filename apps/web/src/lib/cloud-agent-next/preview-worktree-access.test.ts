import { describe, expect, it, jest } from '@jest/globals';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { db } from '@kilocode/web-shared/lib/drizzle';
import {
  verifyOrgOwnsPreviewWorktree,
  verifyUserOwnsPreviewWorktree,
} from './preview-worktree-access';

const USER_ID = 'oauth/github|preview-worktree-owner';
const OTHER_USER_ID = 'oauth/github|preview-worktree-other-owner';
const ORGANIZATION_ID = '3c384401-b75d-4375-a1ba-e319a02e18b7';
const WORKTREE_ID = 'worktree_1a345678-1234-4234-9234-123456789abc';

function compileCondition(condition: SQL | undefined) {
  if (!condition) throw new Error('Expected a SQL condition');
  return new PgDialect().sqlToQuery(condition);
}

function fakeDb(rows: unknown[]) {
  const mockLimit = jest.fn(async (_limit: number) => rows);
  let where: SQL | undefined;
  let join: SQL | undefined;

  const fake = {
    select: () => ({
      from: () => ({
        leftJoin: (_table: unknown, condition: SQL) => {
          join = condition;
          return {
            where: (condition: SQL) => {
              where = condition;
              return { limit: mockLimit };
            },
          };
        },
      }),
    }),
  } as unknown as typeof db;

  return {
    db: fake,
    limit: mockLimit,
    where: () => where,
    join: () => join,
  };
}

describe('personal preview worktree access query', () => {
  it('allows an ordinary root with no sparse side-table row', async () => {
    const fake = fakeDb([{ worktreeId: WORKTREE_ID }]);

    await expect(verifyUserOwnsPreviewWorktree(fake.db, USER_ID, WORKTREE_ID)).resolves.toBe(true);
    expect(fake.limit).toHaveBeenCalledWith(1);

    const { sql } = compileCondition(fake.where());
    expect(sql).toContain('"cli_sessions_v2"."cloud_agent_worktree_id" =');
    expect(sql).toContain('"cli_sessions_v2"."kilo_user_id" =');
    expect(sql).toContain('"cli_sessions_v2"."organization_id" is null');
    expect(sql).toContain('"cli_sessions_v2"."parent_session_id" is null');
    expect(sql).toContain('"cli_sessions_v2"."cloud_agent_session_id" is not null');
    expect(sql).toContain('"cloud_agent_worktrees"."worktree_id" is null');
  });

  it('requires the exact owner and accepts only an absent or matching side table', async () => {
    const fake = fakeDb([{ worktreeId: WORKTREE_ID }]);

    await verifyUserOwnsPreviewWorktree(fake.db, USER_ID, WORKTREE_ID);

    const { sql, params } = compileCondition(fake.where());
    expect(params).toContain(USER_ID);
    expect(sql).toContain('"cloud_agent_worktrees"."kilo_user_id" =');
    expect(sql).toContain('"cloud_agent_worktrees"."organization_id" is null');
  });

  it('denies a deleting or deleted side-table row', async () => {
    const fake = fakeDb([{ worktreeId: WORKTREE_ID }]);

    await verifyUserOwnsPreviewWorktree(fake.db, USER_ID, WORKTREE_ID);

    const { sql } = compileCondition(fake.where());
    expect(sql).toContain('"cloud_agent_worktrees"."deletion_started_at" is null');
    expect(sql).toContain('"cloud_agent_worktrees"."deletion_completed_at" is null');
  });

  it('joins a conflicting side table by worktree only, so it cannot hide another owner', async () => {
    const fake = fakeDb([{ worktreeId: WORKTREE_ID }]);

    await verifyUserOwnsPreviewWorktree(fake.db, USER_ID, WORKTREE_ID);

    const { sql } = compileCondition(fake.join());
    expect(sql).toContain('"cloud_agent_worktrees"."worktree_id"');
    expect(sql).toContain('"cli_sessions_v2"."cloud_agent_worktree_id"');
    expect(sql).not.toContain('kilo_user_id');
    expect(sql).not.toContain('organization_id');
  });

  it('returns false when the query finds no matching root', async () => {
    const fake = fakeDb([]);

    await expect(verifyUserOwnsPreviewWorktree(fake.db, USER_ID, WORKTREE_ID)).resolves.toBe(false);
  });
});

describe('organization preview worktree access query', () => {
  it('requires the exact organization on both the root session and a present side table', async () => {
    const fake = fakeDb([{ worktreeId: WORKTREE_ID }]);

    await expect(
      verifyOrgOwnsPreviewWorktree(fake.db, ORGANIZATION_ID, USER_ID, WORKTREE_ID)
    ).resolves.toBe(true);

    const { sql, params } = compileCondition(fake.where());
    expect(params).toContain(ORGANIZATION_ID);
    expect(sql).toContain('"cli_sessions_v2"."organization_id" =');
    expect(sql).toContain('"cloud_agent_worktrees"."organization_id" =');
  });

  it('uses the same root and side-table deletion authority as the personal query', async () => {
    const fake = fakeDb([{ worktreeId: WORKTREE_ID }]);

    await verifyOrgOwnsPreviewWorktree(fake.db, ORGANIZATION_ID, USER_ID, WORKTREE_ID);

    const { sql, params } = compileCondition(fake.where());
    expect(params).toContain(USER_ID);
    expect(sql).toContain('"cli_sessions_v2"."parent_session_id" is null');
    expect(sql).toContain('"cli_sessions_v2"."cloud_agent_session_id" is not null');
    expect(sql).toContain('"cloud_agent_worktrees"."deletion_started_at" is null');
    expect(sql).toContain('"cloud_agent_worktrees"."deletion_completed_at" is null');
    expect(sql).not.toContain(OTHER_USER_ID);
  });
});
