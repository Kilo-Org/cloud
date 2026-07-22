import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { db } from '@/lib/drizzle';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import type { User } from '@kilocode/db/schema';

jest.mock('@/lib/config.server', () => {
  const actual: Record<string, unknown> = jest.requireActual('@/lib/config.server');
  return {
    ...actual,
    SESSION_INGEST_WORKER_URL: 'https://test-ingest.example.com',
  };
});

let regularUser: User;

function mockWorkerSessions(sessions: Array<Record<string, unknown>>): jest.SpyInstance {
  return jest.spyOn(global, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ sessions }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

function mockMalformedWorkerResponse(): jest.SpyInstance {
  return jest.spyOn(global, 'fetch').mockResolvedValue(
    new Response('not valid json', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    })
  );
}

describe('active-sessions-router.list', () => {
  beforeAll(async () => {
    regularUser = await insertTestUser({
      google_user_email: 'active-sessions-router-user@example.com',
      google_user_name: 'Active Sessions Router User',
      is_admin: false,
    });
  });

  let fetchSpy: jest.SpyInstance;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it('merges enrichment fields from cli_sessions_v2 with explicit camelCase keys', async () => {
    const sessionId = 'ses_active_enrich_match_1234';
    const createdAt = '2026-07-01 10:00:00+00';
    const updatedAt = '2026-07-02 11:00:00+00';
    await db.insert(cli_sessions_v2).values({
      session_id: sessionId,
      kilo_user_id: regularUser.id,
      created_on_platform: 'cli',
      created_at: createdAt,
      updated_at: updatedAt,
    });

    fetchSpy = mockWorkerSessions([
      {
        id: sessionId,
        status: 'running',
        title: 'matched',
        connectionId: 'conn-1',
        gitUrl: 'https://github.com/kilo/repo',
        gitBranch: 'main',
      },
    ]);

    try {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.activeSessions.list();

      expect(result.sessions).toEqual([
        {
          id: sessionId,
          status: 'running',
          title: 'matched',
          connectionId: 'conn-1',
          gitUrl: 'https://github.com/kilo/repo',
          gitBranch: 'main',
          createdOnPlatform: 'cli',
          createdAt,
          updatedAt,
        },
      ]);
      // Assert the explicit camelCase keys exist (not snake_case).
      const row = result.sessions[0]!;
      expect(Object.keys(row)).toEqual(
        expect.arrayContaining(['createdOnPlatform', 'createdAt', 'updatedAt'])
      );
      expect(Object.keys(row)).not.toEqual(
        expect.arrayContaining(['created_on_platform', 'created_at', 'updated_at'])
      );
    } finally {
      await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, sessionId));
    }
  });

  it('passes sessions with undefined enrichment fields when no matching row exists', async () => {
    const unmatchedId = 'ses_active_enrich_unmatched_1234';

    fetchSpy = mockWorkerSessions([
      {
        id: unmatchedId,
        status: 'running',
        title: 'no row',
        connectionId: 'conn-2',
      },
    ]);

    const caller = await createCallerForUser(regularUser.id);
    const result = await caller.activeSessions.list();

    expect(result.sessions).toEqual([
      {
        id: unmatchedId,
        status: 'running',
        title: 'no row',
        connectionId: 'conn-2',
        createdOnPlatform: undefined,
        createdAt: undefined,
        updatedAt: undefined,
      },
    ]);
  });

  it('performs no DB query when the active list is empty', async () => {
    fetchSpy = mockWorkerSessions([]);

    const selectSpy = jest.spyOn(db, 'select');
    try {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.activeSessions.list();

      expect(result.sessions).toEqual([]);
      // The router short-circuits the enrichment query when there are no
      // sessions to enrich.
      expect(selectSpy).not.toHaveBeenCalled();
    } finally {
      selectSpy.mockRestore();
    }
  });

  it('returns unenriched sessions when the enrichment DB query fails', async () => {
    const sessionId = 'ses_active_enrich_db_fail_1234';
    fetchSpy = mockWorkerSessions([
      {
        id: sessionId,
        status: 'running',
        title: 'db fail',
        connectionId: 'conn-3',
      },
    ]);

    // Force the enrichment Drizzle query to throw. The router must catch
    // the failure and return the parsed sessions unenriched — NOT an empty
    // list.
    const selectSpy = jest.spyOn(db, 'select').mockImplementationOnce(() => {
      throw new Error('synthetic enrichment db failure');
    });

    try {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.activeSessions.list();

      expect(result.sessions).toEqual([
        {
          id: sessionId,
          status: 'running',
          title: 'db fail',
          connectionId: 'conn-3',
          createdOnPlatform: undefined,
          createdAt: undefined,
          updatedAt: undefined,
        },
      ]);
    } finally {
      selectSpy.mockRestore();
    }
  });

  it('degrades to empty sessions when the worker returns a malformed response', async () => {
    fetchSpy = mockMalformedWorkerResponse();

    const caller = await createCallerForUser(regularUser.id);
    const result = await caller.activeSessions.list();

    expect(result).toEqual({ sessions: [] });
  });
});
