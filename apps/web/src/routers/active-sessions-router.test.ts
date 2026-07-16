import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { db } from '@/lib/drizzle';
import { cli_sessions_v2, type User } from '@kilocode/db/schema';
import { inArray } from 'drizzle-orm';

jest.mock('@/lib/config.server', () => {
  const actual: Record<string, unknown> = jest.requireActual('@/lib/config.server');
  return {
    ...actual,
    SESSION_INGEST_WORKER_URL: 'https://test-ingest.example.com',
  };
});

// Globally unique across parallel test runs in the shared test database.
const SUITE_TAG = 'active-sessions-router-suite-2026-07-15';
const ACTIVE_STORED_ID = `${SUITE_TAG}-active-stored`;
const ACTIVE_ONLY_ID = `${SUITE_TAG}-active-only`;
const OTHER_USER_SESSION_ID = `${SUITE_TAG}-other-user-session`;
const SESSION_IDS = [ACTIVE_STORED_ID, ACTIVE_ONLY_ID, OTHER_USER_SESSION_ID];

let user: User;
let otherUser: User;

describe('active-sessions-router', () => {
  beforeAll(async () => {
    user = await insertTestUser({
      google_user_email: `${SUITE_TAG}-user@example.com`,
      google_user_name: 'Active Sessions User',
      is_admin: false,
    });
    otherUser = await insertTestUser({
      google_user_email: `${SUITE_TAG}-other@example.com`,
      google_user_name: 'Active Sessions Other User',
      is_admin: false,
    });
  });

  afterAll(async () => {
    // Final safety cleanup.
    await db.delete(cli_sessions_v2).where(inArray(cli_sessions_v2.session_id, SESSION_IDS));
  });

  describe('list', () => {
    let fetchSpy: jest.SpyInstance;

    beforeEach(async () => {
      // Defensive cleanup in case a previous test run left rows.
      await db.delete(cli_sessions_v2).where(inArray(cli_sessions_v2.session_id, SESSION_IDS));

      await db.insert(cli_sessions_v2).values([
        {
          session_id: ACTIVE_STORED_ID,
          kilo_user_id: user.id,
          created_on_platform: 'cloud-agent',
          organization_id: null,
          git_url: 'https://github.com/kilo/stored.git',
          git_branch: 'stored-branch',
        },
        {
          session_id: OTHER_USER_SESSION_ID,
          kilo_user_id: otherUser.id,
          created_on_platform: 'cloud-agent',
          organization_id: null,
        },
      ]);

      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            sessions: [
              {
                id: ACTIVE_STORED_ID,
                status: 'busy',
                title: 'Stored active',
                connectionId: 'connection-1',
                gitUrl: 'https://github.com/kilo/heartbeat.git',
                gitBranch: 'heartbeat-branch',
              },
              {
                id: ACTIVE_ONLY_ID,
                status: 'idle',
                title: 'Remote active',
                connectionId: 'connection-2',
              },
              {
                id: OTHER_USER_SESSION_ID,
                status: 'busy',
                title: 'Collision',
                connectionId: 'connection-3',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
    });

    afterEach(async () => {
      fetchSpy.mockRestore();
      await db.delete(cli_sessions_v2).where(inArray(cli_sessions_v2.session_id, SESSION_IDS));
    });

    it('enriches active records with stored metadata and prefers the stored repository fields', async () => {
      const caller = await createCallerForUser(user.id);
      const result = await caller.activeSessions.list();

      expect(result.sessions).toHaveLength(3);
      expect(result.sessions[0]).toMatchObject({
        id: ACTIVE_STORED_ID,
        status: 'busy',
        title: 'Stored active',
        connectionId: 'connection-1',
        createdOnPlatform: 'cloud-agent',
        organizationId: null,
        gitUrl: 'https://github.com/kilo/stored.git',
        gitBranch: 'stored-branch',
      });
    });

    it('passes active-only and another-user sessions through without leaking stored metadata', async () => {
      const caller = await createCallerForUser(user.id);
      const result = await caller.activeSessions.list();

      // active-only: no stored row, must be unchanged.
      expect(result.sessions[1]).toEqual({
        id: ACTIVE_ONLY_ID,
        status: 'idle',
        title: 'Remote active',
        connectionId: 'connection-2',
      });
      expect(result.sessions[1]).not.toHaveProperty('createdOnPlatform');
      expect(result.sessions[1]).not.toHaveProperty('organizationId');

      // Collision: another user's stored row must not enrich this caller's response.
      expect(result.sessions[2]).toEqual({
        id: OTHER_USER_SESSION_ID,
        status: 'busy',
        title: 'Collision',
        connectionId: 'connection-3',
      });
      expect(result.sessions[2]).not.toHaveProperty('createdOnPlatform');
      expect(result.sessions[2]).not.toHaveProperty('organizationId');
    });
    it('returns un-enriched sessions when metadata enrichment fails', async () => {
      const selectSpy = jest.spyOn(db, 'select').mockImplementation(() => {
        throw new Error('Simulated DB transient error');
      });

      try {
        const caller = await createCallerForUser(user.id);
        const result = await caller.activeSessions.list();

        expect(result.sessions).toHaveLength(3);
        expect(result.sessions[0]).toEqual({
          id: ACTIVE_STORED_ID,
          status: 'busy',
          title: 'Stored active',
          connectionId: 'connection-1',
          gitUrl: 'https://github.com/kilo/heartbeat.git',
          gitBranch: 'heartbeat-branch',
        });
      } finally {
        selectSpy.mockRestore();
      }
    });
  });
});
