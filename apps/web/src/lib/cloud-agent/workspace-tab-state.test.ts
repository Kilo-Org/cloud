import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from '@jest/globals';
import {
  cli_sessions_v2,
  cloud_agent_worktrees,
  organization_memberships,
  organizations,
  type User,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  createCallerFactory,
  createTRPCRouter,
  type TRPCContext,
} from '@kilocode/web-shared/lib/trpc/init';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { eq, sql } from 'drizzle-orm';
import { queueWorkspaceUpdates } from './session-events';
import {
  closeWorkspaceTab,
  importWorkspaceTabs,
  importWorkspaceTabsInputSchema,
  reopenWorkspaceTab,
  reorderWorkspaceTab,
  replaceWorkspaceTab,
  workspaceTabProcedures,
  type WorkspaceTabScope,
} from './workspace-tab-state';

jest.mock('./session-events', () => ({ queueWorkspaceUpdates: jest.fn() }));

const scope: WorkspaceTabScope = {
  userId: 'oauth/github|workspace-tab-owner',
  organizationId: null,
};
let user: User;

beforeAll(async () => {
  user = await insertTestUser({ id: scope.userId, is_admin: false });
});

async function workspace(count = 4, organizationId: string | null = null) {
  const worktreeId: `worktree_${string}` = `worktree_${randomUUID()}`;
  const sessionIds = Array.from({ length: count }, () => `ses_${randomUUID()}`);
  await db.insert(cloud_agent_worktrees).values({
    worktree_id: worktreeId,
    kilo_user_id: scope.userId,
    organization_id: organizationId,
  });
  await db.insert(cli_sessions_v2).values(
    sessionIds.map((sessionId, index) => ({
      session_id: sessionId,
      kilo_user_id: scope.userId,
      organization_id: organizationId,
      cloud_agent_worktree_id: worktreeId,
      created_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      updated_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    }))
  );
  return { worktreeId, sessionIds };
}

async function state(worktreeId: string) {
  const [row] = await db
    .select({
      closed: cloud_agent_worktrees.closed_session_ids,
      order: cloud_agent_worktrees.tab_order,
    })
    .from(cloud_agent_worktrees)
    .where(eq(cloud_agent_worktrees.worktree_id, worktreeId));
  return row;
}

function input(worktreeId: `worktree_${string}`, sessionId: string) {
  return { organizationId: null, worktreeId, sessionId };
}

describe('workspace tab persistence', () => {
  it('closes newest first, deduplicates repeated closes, and reopens without deleting chats', async () => {
    const {
      worktreeId,
      sessionIds: [a, b],
    } = await workspace(2);
    await closeWorkspaceTab(scope, input(worktreeId, a));
    await closeWorkspaceTab(scope, input(worktreeId, b));
    await closeWorkspaceTab(scope, input(worktreeId, a));
    expect((await state(worktreeId)).closed).toEqual([a, b]);
    await reopenWorkspaceTab(scope, input(worktreeId, a));
    expect(await state(worktreeId)).toEqual({ closed: [b], order: [a] });
    expect(
      await db
        .select()
        .from(cli_sessions_v2)
        .where(eq(cli_sessions_v2.cloud_agent_worktree_id, worktreeId))
    ).toHaveLength(2);
  });

  it('does not reorder an implicitly open chat when its address opens', async () => {
    const { worktreeId, sessionIds } = await workspace();
    await reopenWorkspaceTab(scope, input(worktreeId, sessionIds[1]));
    expect((await state(worktreeId)).order).toEqual(sessionIds);
  });

  it('appends a reopened chat consistently after an explicit tab order', async () => {
    const {
      worktreeId,
      sessionIds: [a, b, c],
    } = await workspace(3);
    await reorderWorkspaceTab(scope, { ...input(worktreeId, b), beforeSessionId: a });
    await closeWorkspaceTab(scope, input(worktreeId, b));
    expect((await state(worktreeId)).order).toEqual([a, c]);
    await reopenWorkspaceTab(scope, input(worktreeId, b));
    expect((await state(worktreeId)).order).toEqual([a, c, b]);
  });

  it('keeps independent concurrent closes instead of replacing another window’s array', async () => {
    const { worktreeId, sessionIds } = await workspace(20);
    await Promise.all(
      sessionIds.map(sessionId => closeWorkspaceTab(scope, input(worktreeId, sessionId)))
    );
    const result = await state(worktreeId);
    expect(result.closed).toHaveLength(sessionIds.length);
    expect(new Set(result.closed)).toEqual(new Set(sessionIds));
  });

  it('applies concurrent relative movements to the current SQL order', async () => {
    const {
      worktreeId,
      sessionIds: [a, b, c, d],
    } = await workspace();
    await Promise.all([
      reorderWorkspaceTab(scope, { ...input(worktreeId, b), beforeSessionId: a }),
      reorderWorkspaceTab(scope, { ...input(worktreeId, d), beforeSessionId: c }),
    ]);
    expect((await state(worktreeId)).order).toEqual([b, a, d, c]);
    await reorderWorkspaceTab(scope, { ...input(worktreeId, b), beforeSessionId: null });
    expect((await state(worktreeId)).order).toEqual([a, d, c, b]);
  });

  it('replaces a tab in place and keeps a concurrent close', async () => {
    const {
      worktreeId,
      sessionIds: [a, b, c, d],
    } = await workspace();
    await Promise.all([
      replaceWorkspaceTab(scope, {
        organizationId: null,
        worktreeId,
        oldSessionId: b,
        newSessionId: d,
      }),
      closeWorkspaceTab(scope, input(worktreeId, c)),
    ]);
    const result = await state(worktreeId);
    expect(new Set(result.closed)).toEqual(new Set([b, c]));
    expect(result.order.filter(id => !result.closed.includes(id))).toEqual([a, d]);
  });

  it('imports oldest-first legacy tabs once, with current closed and open state winning', async () => {
    const {
      worktreeId,
      sessionIds: [a, b, c, d],
    } = await workspace();
    await db
      .update(cloud_agent_worktrees)
      .set({ closed_session_ids: [c], tab_order: [a] })
      .where(eq(cloud_agent_worktrees.worktree_id, worktreeId));
    const legacy = {
      organizationId: null,
      closedSessionIds: [b, a, c, d],
      sessionOrderByWorktree: { [worktreeId]: [d, b, a, c] },
    };
    await importWorkspaceTabs(scope, legacy);
    expect(await state(worktreeId)).toEqual({ closed: [c, d, b], order: [a] });
    await reopenWorkspaceTab(scope, input(worktreeId, d));
    await importWorkspaceTabs(scope, legacy);
    expect((await state(worktreeId)).closed).toEqual([c, b]);
  });

  it('keeps concurrent current edits during import', async () => {
    const {
      worktreeId,
      sessionIds: [a, b, c],
    } = await workspace(3);
    await Promise.all([
      closeWorkspaceTab(scope, input(worktreeId, c)),
      importWorkspaceTabs(scope, {
        organizationId: null,
        closedSessionIds: [a],
        sessionOrderByWorktree: { [worktreeId]: [b, a] },
      }),
    ]);
    const result = await state(worktreeId);
    expect(result.closed).toEqual(expect.arrayContaining([a, c]));
    expect(result.order).toEqual([b]);
  });

  it('imports a bounded legacy history across more than 500 workspaces', async () => {
    const fixtures = Array.from({ length: 501 }, () => ({
      worktreeId: `worktree_${randomUUID()}`,
      sessionId: `ses_${randomUUID()}`,
    }));
    await db
      .insert(cloud_agent_worktrees)
      .values(fixtures.map(row => ({ worktree_id: row.worktreeId, kilo_user_id: scope.userId })));
    await db.insert(cli_sessions_v2).values(
      fixtures.map(row => ({
        session_id: row.sessionId,
        cloud_agent_worktree_id: row.worktreeId,
        kilo_user_id: scope.userId,
      }))
    );
    const result = await importWorkspaceTabs(scope, {
      organizationId: null,
      closedSessionIds: fixtures.map(row => row.sessionId),
      sessionOrderByWorktree: {},
    });
    expect(result.worktreeIds).toHaveLength(fixtures.length);
    expect((await state(fixtures[0].worktreeId)).closed).toEqual([fixtures[0].sessionId]);
    expect((await state(fixtures[500].worktreeId)).closed).toEqual([fixtures[500].sessionId]);
  });

  it('does not restore a deleted chat when a tab write waits for workspace deletion locking', async () => {
    const {
      worktreeId,
      sessionIds: [a],
    } = await workspace(2);
    let locked: () => void = () => undefined;
    let release: () => void = () => undefined;
    const lockAcquired = new Promise<void>(resolve => {
      locked = resolve;
    });
    const canCommit = new Promise<void>(resolve => {
      release = resolve;
    });
    const deletion = db.transaction(async tx => {
      await tx
        .select()
        .from(cloud_agent_worktrees)
        .where(eq(cloud_agent_worktrees.worktree_id, worktreeId))
        .for('update');
      await tx.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, a));
      locked();
      await canCommit;
    });
    await lockAcquired;
    const closing = closeWorkspaceTab(scope, input(worktreeId, a)).then(
      value => ({ ok: true, value }),
      (error: unknown) => ({ ok: false, error })
    );
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const result = await db.execute<{ waiting: boolean }>(sql`select exists (
          select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'
        ) as waiting`);
        if (result.rows[0]?.waiting) {
          waiting = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
    } finally {
      release();
    }
    await deletion;
    expect(await closing).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect((await state(worktreeId)).closed).toEqual([]);
  });
});

describe('workspace tab access boundaries', () => {
  it('requires exact workspace ownership, organization scope, and root chat membership', async () => {
    const first = await workspace(2);
    const second = await workspace(1);
    const sessionId = first.sessionIds[0];
    await expect(
      closeWorkspaceTab(scope, input(second.worktreeId, sessionId))
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      closeWorkspaceTab({ ...scope, userId: 'another-owner' }, input(first.worktreeId, sessionId))
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await db
      .update(cli_sessions_v2)
      .set({ parent_session_id: first.sessionIds[1] })
      .where(eq(cli_sessions_v2.session_id, sessionId));
    await expect(
      closeWorkspaceTab(scope, input(first.worktreeId, sessionId))
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await state(first.worktreeId)).closed).toEqual([]);
  });

  it('checks both replacement IDs and the reorder anchor', async () => {
    const first = await workspace(1);
    const second = await workspace(1);
    await expect(
      replaceWorkspaceTab(scope, {
        organizationId: null,
        worktreeId: first.worktreeId,
        oldSessionId: first.sessionIds[0],
        newSessionId: second.sessionIds[0],
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      reorderWorkspaceTab(scope, {
        ...input(first.worktreeId, first.sessionIds[0]),
        beforeSessionId: second.sessionIds[0],
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects mutations after workspace deletion starts', async () => {
    const {
      worktreeId,
      sessionIds: [sessionId],
    } = await workspace(1);
    await db
      .update(cloud_agent_worktrees)
      .set({ deletion_started_at: new Date().toISOString() })
      .where(eq(cloud_agent_worktrees.worktree_id, worktreeId));
    await expect(closeWorkspaceTab(scope, input(worktreeId, sessionId))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('ignores unknown and child session IDs during import', async () => {
    const {
      worktreeId,
      sessionIds: [a, b],
    } = await workspace(2);
    await db
      .update(cli_sessions_v2)
      .set({ parent_session_id: a })
      .where(eq(cli_sessions_v2.session_id, b));
    await importWorkspaceTabs(scope, {
      organizationId: null,
      closedSessionIds: ['unknown', b, a],
      sessionOrderByWorktree: { [worktreeId]: ['unknown', b, a] },
    });
    expect(await state(worktreeId)).toEqual({ closed: [a], order: [] });
  });

  it('does not accept an ID in an imported order for another worktree', async () => {
    const first = await workspace(1);
    const second = await workspace(1);
    await importWorkspaceTabs(scope, {
      organizationId: null,
      closedSessionIds: [],
      sessionOrderByWorktree: { [first.worktreeId]: second.sessionIds },
    });
    expect((await state(first.worktreeId)).order).toEqual([]);
    expect((await state(second.worktreeId)).order).toEqual([]);
  });

  it('requires active organization access and does not leak organization chats into personal state', async () => {
    const organizationId = randomUUID();
    await db.insert(organizations).values({
      id: organizationId,
      name: 'Synthetic tab organization',
      created_by_kilo_user_id: scope.userId,
    });
    const {
      worktreeId,
      sessionIds: [sessionId],
    } = await workspace(1, organizationId);
    const caller = createCallerFactory(createTRPCRouter(workspaceTabProcedures))({
      user,
      headersList: new Headers(),
    } as TRPCContext);
    await expect(
      caller.closeWorkspaceTab({ organizationId, worktreeId, sessionId })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await db
      .insert(organization_memberships)
      .values({ organization_id: organizationId, kilo_user_id: scope.userId, role: 'member' });
    await expect(caller.closeWorkspaceTab(input(worktreeId, sessionId))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await caller.closeWorkspaceTab({ organizationId, worktreeId, sessionId });
    expect(queueWorkspaceUpdates).toHaveBeenCalledWith({ userId: scope.userId, organizationId }, [
      worktreeId,
    ]);
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, organizationId));
    await expect(
      caller.reopenWorkspaceTab({ organizationId, worktreeId, sessionId })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await state(worktreeId)).closed).toEqual([sessionId]);
  });

  it('bounds legacy imports', () => {
    expect(
      importWorkspaceTabsInputSchema.safeParse({
        organizationId: null,
        closedSessionIds: Array(10_001).fill('session'),
        sessionOrderByWorktree: {},
      }).success
    ).toBe(false);
  });
});
