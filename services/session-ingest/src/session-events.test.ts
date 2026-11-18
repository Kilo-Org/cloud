import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./dos/UserConnectionDO', () => ({
  getUserConnectionDO: vi.fn(),
}));

import { mapSessionEventRow, notifyUserSessionEvent } from './session-events';
import { getUserConnectionDO } from './dos/UserConnectionDO';
import type { Env } from './env';
import type { SessionEventPayload } from './types/user-connection-protocol';

describe('mapSessionEventRow', () => {
  it.each(['worktree_11111111-1111-4111-8111-111111111111', null])(
    'normalizes Postgres timestamp text while preserving worktree ID %s',
    cloudAgentWorktreeId => {
      const session = mapSessionEventRow({
        session_id: 'ses_12345678901234567890123456',
        created_at: '2026-04-29 01:16:12.945+00',
        updated_at: '2026-04-29 02:17:13.123+00',
        title: 'Fix issue',
        created_on_platform: 'cloud-agent',
        organization_id: null,
        git_url: null,
        git_branch: null,
        parent_session_id: null,
        cloud_agent_worktree_id: cloudAgentWorktreeId,
        status: 'busy',
        status_updated_at: '2026-04-29 03:18:14.456+00',
      });

      expect(session.createdAt).toBe('2026-04-29T01:16:12.945Z');
      expect(session.updatedAt).toBe('2026-04-29T02:17:13.123Z');
      expect(session.statusUpdatedAt).toBe('2026-04-29T03:18:14.456Z');
      expect(session.worktreeId).toBe(cloudAgentWorktreeId);
    }
  );
});

describe('notifyUserSessionEvent', () => {
  const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
  const session = mapSessionEventRow({
    session_id: 'ses_12345678901234567890123456',
    created_at: '2026-04-29T01:16:12.945Z',
    updated_at: '2026-04-29T02:17:13.123Z',
    title: 'Synthetic session',
    created_on_platform: 'cloud-agent-web',
    organization_id: null,
    git_url: null,
    git_branch: null,
    parent_session_id: null,
    cloud_agent_worktree_id: worktreeId,
    status: 'busy',
    status_updated_at: null,
  });
  const env = {} as Env;
  const notifySessionEvent = vi.fn(async (_event: SessionEventPayload) => ({ delivered: 1 }));

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUserConnectionDO).mockReturnValue({ notifySessionEvent } as never);
  });

  async function notify(event: SessionEventPayload) {
    const pending: Promise<unknown>[] = [];
    notifyUserSessionEvent(env, 'oauth/event-owner', event, {
      waitUntil: promise => pending.push(promise),
    });
    await Promise.all(pending);
  }

  it.each(['session.created', 'session.updated', 'session.status.updated'] as const)(
    'emits a workspace update after %s',
    async type => {
      const event: SessionEventPayload =
        type === 'session.status.updated'
          ? {
              type,
              data: {
                source: 'v2',
                session,
                changedAt: session.updatedAt,
                previousStatus: 'idle',
                status: 'busy',
                statusUpdatedAt: session.updatedAt,
              },
            }
          : { type, data: { source: 'v2', session, changedAt: session.updatedAt } };
      await notify(event);
      expect(notifySessionEvent.mock.calls).toEqual([
        [event],
        [{ type: 'workspace.updated', data: { worktreeId } }],
      ]);
    }
  );

  it('emits a workspace update after deleting a workspace chat', async () => {
    await notify({
      type: 'session.deleted',
      data: {
        source: 'v2',
        sessionId: session.sessionId,
        parentSessionId: null,
        organizationId: null,
        gitUrl: null,
        gitBranch: null,
        createdOnPlatform: session.createdOnPlatform,
        worktreeId,
        deletedAt: session.updatedAt,
      },
    });
    expect(notifySessionEvent).toHaveBeenLastCalledWith({
      type: 'workspace.updated',
      data: { worktreeId },
    });
    expect(notifySessionEvent).toHaveBeenCalledTimes(2);
  });

  it.each(['session.created', 'session.updated', 'session.status.updated'] as const)(
    'does not emit a workspace update for a child %s event',
    async type => {
      const child = { ...session, parentSessionId: 'ses_parent' };
      const event: SessionEventPayload =
        type === 'session.status.updated'
          ? {
              type,
              data: {
                source: 'v2',
                session: child,
                changedAt: session.updatedAt,
                previousStatus: 'idle',
                status: 'busy',
                statusUpdatedAt: session.updatedAt,
              },
            }
          : { type, data: { source: 'v2', session: child, changedAt: session.updatedAt } };
      await notify(event);
      expect(notifySessionEvent.mock.calls).toEqual([[event]]);
    }
  );

  it('does not emit a workspace update for a child deletion', async () => {
    const event: SessionEventPayload = {
      type: 'session.deleted',
      data: {
        source: 'v2',
        sessionId: session.sessionId,
        parentSessionId: 'ses_parent',
        organizationId: null,
        gitUrl: null,
        gitBranch: null,
        createdOnPlatform: session.createdOnPlatform,
        worktreeId,
        deletedAt: session.updatedAt,
      },
    };
    await notify(event);
    expect(notifySessionEvent.mock.calls).toEqual([[event]]);
  });

  it('does not duplicate explicit workspace events', async () => {
    await notify({ type: 'workspace.updated', data: { worktreeId } });
    expect(notifySessionEvent).toHaveBeenCalledTimes(1);
  });

  it('does not look up membership for a legacy lightweight status event', async () => {
    await notify({
      type: 'session.status.updated',
      data: {
        source: 'v2',
        sessionId: session.sessionId,
        previousStatus: 'idle',
        status: 'busy',
        statusUpdatedAt: session.updatedAt,
        changedAt: session.updatedAt,
      },
    });
    expect(notifySessionEvent).toHaveBeenCalledTimes(1);
  });

  it('still emits workspace updates when the session notification fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      notifySessionEvent.mockRejectedValueOnce(new Error('socket unavailable'));
      await notify({
        type: 'session.updated',
        data: { source: 'v2', session, changedAt: session.updatedAt },
      });
      expect(notifySessionEvent).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenCalledWith(expect.any(String), {
        event: 'session.updated',
        sessionId: session.sessionId,
        error: 'socket unavailable',
      });
    } finally {
      log.mockRestore();
    }
  });

  it('logs a failed workspace event without assuming a session ID', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      notifySessionEvent.mockRejectedValueOnce(new Error('socket unavailable'));
      await notify({ type: 'workspace.updated', data: { worktreeId } });
      expect(log).toHaveBeenCalledWith(expect.any(String), {
        event: 'workspace.updated',
        worktreeId,
        error: 'socket unavailable',
      });
    } finally {
      log.mockRestore();
    }
  });
});
