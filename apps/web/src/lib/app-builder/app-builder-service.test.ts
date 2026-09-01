import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { and, eq, isNull } from 'drizzle-orm';
import { cleanupDbForTest, db, pool } from '@/lib/drizzle';
import {
  app_builder_projects,
  app_builder_project_sessions,
  AppBuilderSessionReason,
} from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type * as serviceModule from './app-builder-service';

const mockPrepareSession =
  jest.fn<(...args: unknown[]) => Promise<{ cloudAgentSessionId: string }>>();
const mockInitiateFromPreparedSession = jest.fn<
  (input: { cloudAgentSessionId: string }) => Promise<{
    cloudAgentSessionId: string;
    executionId: string;
    status: 'started';
    streamUrl: string;
    messageId: string;
    delivery: 'sent';
  }>
>();
const mockInterruptSession = jest.fn<(...args: unknown[]) => Promise<{ success: boolean }>>();
const mockCleanupSession = jest.fn<(...args: unknown[]) => Promise<{ success: boolean }>>();
const mockGetSession = jest.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>();

jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createAppBuilderCloudAgentNextClient: () => ({
    prepareSession: mockPrepareSession,
    initiateFromPreparedSession: mockInitiateFromPreparedSession,
    interruptSession: mockInterruptSession,
    cleanupSession: mockCleanupSession,
    getSession: mockGetSession,
  }),
}));

let getProject: typeof serviceModule.getProject;
let sendMessage: typeof serviceModule.sendMessage;

beforeAll(async () => {
  ({ getProject, sendMessage } = await import('./app-builder-service'));
});

beforeEach(async () => {
  await cleanupDbForTest();
  jest.clearAllMocks();
  mockInterruptSession.mockResolvedValue({ success: true });
  mockCleanupSession.mockResolvedValue({ success: true });
  mockGetSession.mockImplementation(async sessionId => ({
    sessionId,
    userId: 'test-user',
    execution: null,
    preparedAt: Date.now(),
    initiatedAt: Date.now(),
    timestamp: Date.now(),
    version: 1,
  }));
  mockInitiateFromPreparedSession.mockImplementation(async ({ cloudAgentSessionId }) => ({
    cloudAgentSessionId,
    executionId: `execution-${cloudAgentSessionId}`,
    status: 'started',
    streamUrl: `/sessions/${cloudAgentSessionId}/stream`,
    messageId: `message-${cloudAgentSessionId}`,
    delivery: 'sent',
  }));
});

async function createProjectFixture() {
  const user = await insertTestUser();
  const [project] = await db
    .insert(app_builder_projects)
    .values({
      created_by_user_id: user.id,
      owned_by_user_id: user.id,
      session_id: 'session-a',
      title: 'Snapshot project',
      model_id: 'test-model',
      git_repo_full_name: 'kilo/snapshot-project',
    })
    .returning();

  await db.insert(app_builder_project_sessions).values({
    project_id: project.id,
    cloud_agent_session_id: 'session-a',
    reason: AppBuilderSessionReason.Initial,
    worker_version: 'v2',
  });

  return { project, owner: { type: 'user' as const, id: user.id } };
}

async function waitForProjectSessionReadBlockedBy(lockingPid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ waiting: boolean }>(
      `SELECT EXISTS (
        SELECT 1
        FROM pg_locks
        WHERE relation = 'app_builder_project_sessions'::regclass
          AND NOT granted
          AND $1::integer = ANY(pg_blocking_pids(pid))
      ) AS waiting`,
      [lockingPid]
    );
    if (result.rows[0]?.waiting) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('App Builder project read did not block on expected table lock');
}

describe('App Builder session consistency', () => {
  it('marks a definitively missing canonical session as unprepared for recovery', async () => {
    const { project, owner } = await createProjectFixture();
    mockGetSession.mockRejectedValueOnce({
      shape: { data: { code: 'NOT_FOUND', httpStatus: 404 } },
    });

    const result = await getProject(project.id, owner, 'test-token');

    expect(result.sessions).toEqual([
      expect.objectContaining({
        cloud_agent_session_id: 'session-a',
        initiated: null,
        prepared: false,
      }),
    ]);
  });

  it('allows only one concurrent new-session request to claim the canonical pointer', async () => {
    const { project, owner } = await createProjectFixture();
    const bothPrepared = Promise.withResolvers<void>();

    mockPrepareSession.mockImplementation(async () => {
      const callNumber = mockPrepareSession.mock.calls.length;
      if (callNumber === 2) bothPrepared.resolve();
      await bothPrepared.promise;
      return { cloudAgentSessionId: `session-${callNumber}` };
    });

    const results = await Promise.allSettled([
      sendMessage({
        projectId: project.id,
        owner,
        message: 'first concurrent message',
        authToken: 'test-token',
        forceNewSession: true,
      }),
      sendMessage({
        projectId: project.id,
        owner,
        message: 'second concurrent message',
        authToken: 'test-token',
        forceNewSession: true,
      }),
    ]);

    const fulfilled = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(result => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'CONFLICT' });

    const [persistedProject] = await db
      .select({ sessionId: app_builder_projects.session_id })
      .from(app_builder_projects)
      .where(eq(app_builder_projects.id, project.id));
    const activeSessions = await db
      .select({ sessionId: app_builder_project_sessions.cloud_agent_session_id })
      .from(app_builder_project_sessions)
      .where(
        and(
          eq(app_builder_project_sessions.project_id, project.id),
          isNull(app_builder_project_sessions.ended_at)
        )
      );

    expect(activeSessions).toEqual([{ sessionId: persistedProject.sessionId }]);
    expect(['session-1', 'session-2']).toContain(persistedProject.sessionId);

    const losingSessionId = persistedProject.sessionId === 'session-1' ? 'session-2' : 'session-1';
    expect(mockInterruptSession).toHaveBeenCalledWith(losingSessionId);
    expect(mockCleanupSession).toHaveBeenCalledWith(losingSessionId);

    const losingRows = await db
      .select()
      .from(app_builder_project_sessions)
      .where(eq(app_builder_project_sessions.cloud_agent_session_id, losingSessionId));
    expect(losingRows).toHaveLength(0);
  });

  it('returns a coherent project and session snapshot across a concurrent rollover', async () => {
    const { project, owner } = await createProjectFixture();
    const lockClient = await pool.connect();
    let projectPromise: ReturnType<typeof getProject> | null = null;

    try {
      await lockClient.query('BEGIN');
      await lockClient.query('LOCK TABLE app_builder_project_sessions IN ACCESS EXCLUSIVE MODE');
      const pidResult = await lockClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const lockingPid = pidResult.rows[0]?.pid;
      if (lockingPid === undefined) throw new Error('Could not determine locking database process');

      projectPromise = getProject(project.id, owner, 'test-token');
      await waitForProjectSessionReadBlockedBy(lockingPid);

      await lockClient.query(
        'UPDATE app_builder_project_sessions SET ended_at = now() WHERE project_id = $1 AND cloud_agent_session_id = $2',
        [project.id, 'session-a']
      );
      await lockClient.query(
        `INSERT INTO app_builder_project_sessions
          (project_id, cloud_agent_session_id, reason, worker_version)
         VALUES ($1, $2, $3, 'v2')`,
        [project.id, 'session-b', AppBuilderSessionReason.UserInitiated]
      );
      await lockClient.query('UPDATE app_builder_projects SET session_id = $2 WHERE id = $1', [
        project.id,
        'session-b',
      ]);
      await lockClient.query('COMMIT');

      const result = await projectPromise;
      expect(result.session_id).toBe('session-b');
      expect(result.sessions).toEqual([
        expect.objectContaining({
          cloud_agent_session_id: 'session-a',
          ended_at: expect.any(String),
        }),
        expect.objectContaining({ cloud_agent_session_id: 'session-b', ended_at: null }),
      ]);
      expect(mockGetSession).toHaveBeenCalledWith('session-b');
    } finally {
      await lockClient.query('ROLLBACK').catch(() => undefined);
      lockClient.release();
      if (projectPromise) await projectPromise.catch(() => undefined);
    }
  }, 20_000);
});
