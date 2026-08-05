import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { db } from '@/lib/drizzle';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import type { User } from '@kilocode/db/schema';

jest.mock('@/lib/config.server', () => {
  const actual: Record<string, unknown> = jest.requireActual('@/lib/config.server');
  return {
    ...actual,
    SESSION_INGEST_WORKER_URL: 'https://test-ingest.example.com',
  };
});

let regularUser: User;
let otherUser: User;

function mockWorkerSessions(sessions: Array<Record<string, unknown>>): jest.SpyInstance {
  // Fresh Response per call — a single Response body can only be read once.
  return jest.spyOn(global, 'fetch').mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify({ sessions }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
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
    otherUser = await insertTestUser({
      google_user_email: 'active-sessions-router-other@example.com',
      google_user_name: 'Active Sessions Router Other',
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
          organizationId: null,
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

  it('overlays stored question status over a live busy heartbeat status', async () => {
    const sessionId = 'ses_active_attention_question_1234';
    await db.insert(cli_sessions_v2).values({
      session_id: sessionId,
      kilo_user_id: regularUser.id,
      created_on_platform: 'cli',
      status: 'question',
    });

    fetchSpy = mockWorkerSessions([
      {
        id: sessionId,
        status: 'busy',
        title: 'needs input',
        connectionId: 'conn-attn',
      },
    ]);

    try {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.activeSessions.list();

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]?.status).toBe('question');
      expect(result.sessions[0]?.title).toBe('needs input');
    } finally {
      await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, sessionId));
    }
  });

  it('overlays stored permission status over a live idle heartbeat status', async () => {
    const sessionId = 'ses_active_attention_permission_1234';
    await db.insert(cli_sessions_v2).values({
      session_id: sessionId,
      kilo_user_id: regularUser.id,
      created_on_platform: 'cli',
      status: 'permission',
    });

    fetchSpy = mockWorkerSessions([
      {
        id: sessionId,
        status: 'idle',
        title: 'needs permission',
        connectionId: 'conn-perm',
      },
    ]);

    try {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.activeSessions.list();

      expect(result.sessions[0]?.status).toBe('permission');
    } finally {
      await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, sessionId));
    }
  });

  it('keeps the live status when the stored DB status is not attention', async () => {
    const sessionId = 'ses_active_attention_non_attn_1234';
    await db.insert(cli_sessions_v2).values({
      session_id: sessionId,
      kilo_user_id: regularUser.id,
      created_on_platform: 'cli',
      status: 'idle',
    });

    fetchSpy = mockWorkerSessions([
      {
        id: sessionId,
        status: 'busy',
        title: 'working',
        connectionId: 'conn-busy',
      },
    ]);

    try {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.activeSessions.list();

      expect(result.sessions[0]?.status).toBe('busy');
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
        organizationId: null,
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

  describe('organization context filter and title enrichment', () => {
    const personalId = 'ses_active_ctx_personal_1234';
    const orgId = 'ses_active_ctx_org_1234';
    const noRowId = 'ses_active_ctx_norow_1234';
    const titledId = 'ses_active_ctx_titled_1234';
    const nullTitleId = 'ses_active_ctx_nulltitle_1234';

    afterEach(async () => {
      await db
        .delete(cli_sessions_v2)
        .where(
          inArray(cli_sessions_v2.session_id, [personalId, orgId, noRowId, titledId, nullTitleId])
        );
    });

    it('list({ organizationId: null }) excludes org sessions and includes personal ones', async () => {
      const organization = await createTestOrganization(
        'Active Sessions Filter Org',
        regularUser.id,
        0
      );

      await db.insert(cli_sessions_v2).values([
        {
          session_id: personalId,
          kilo_user_id: regularUser.id,
          created_on_platform: 'cli',
          organization_id: null,
        },
        {
          session_id: orgId,
          kilo_user_id: regularUser.id,
          created_on_platform: 'cli',
          organization_id: organization.id,
        },
      ]);

      fetchSpy = mockWorkerSessions([
        {
          id: personalId,
          status: 'busy',
          title: 'personal',
          connectionId: 'conn-p',
        },
        {
          id: orgId,
          status: 'busy',
          title: 'org',
          connectionId: 'conn-o',
        },
      ]);

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.activeSessions.list({ organizationId: null });

      expect(result.sessions.map(s => s.id)).toEqual([personalId]);
      expect(result.sessions[0]).toHaveProperty('organizationId', null);
    });

    it('list({ organizationId: null }) includes a live session with no cli_sessions_v2 row', async () => {
      fetchSpy = mockWorkerSessions([
        {
          id: noRowId,
          status: 'busy',
          title: 'unattributable',
          connectionId: 'conn-nr',
        },
      ]);

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.activeSessions.list({ organizationId: null });

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]?.id).toBe(noRowId);
      expect(result.sessions[0]).toHaveProperty('organizationId', null);
    });

    it('list({ organizationId: <org> }) includes only that org and excludes personal and no-row', async () => {
      const organization = await createTestOrganization(
        'Active Sessions Org-Only Filter Org',
        regularUser.id,
        0
      );

      await db.insert(cli_sessions_v2).values([
        {
          session_id: personalId,
          kilo_user_id: regularUser.id,
          created_on_platform: 'cli',
          organization_id: null,
        },
        {
          session_id: orgId,
          kilo_user_id: regularUser.id,
          created_on_platform: 'cli',
          organization_id: organization.id,
        },
      ]);

      fetchSpy = mockWorkerSessions([
        {
          id: personalId,
          status: 'busy',
          title: 'personal',
          connectionId: 'conn-p',
        },
        {
          id: orgId,
          status: 'busy',
          title: 'org',
          connectionId: 'conn-o',
        },
        {
          id: noRowId,
          status: 'busy',
          title: 'unattributable',
          connectionId: 'conn-nr',
        },
      ]);

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.activeSessions.list({
        organizationId: organization.id,
      });

      expect(result.sessions.map(s => s.id)).toEqual([orgId]);
      expect(result.sessions[0]).toHaveProperty('organizationId', organization.id);
    });

    it('list() with no input returns personal + org + no-row sessions', async () => {
      const organization = await createTestOrganization(
        'Active Sessions Unfiltered Org',
        regularUser.id,
        0
      );

      await db.insert(cli_sessions_v2).values([
        {
          session_id: personalId,
          kilo_user_id: regularUser.id,
          created_on_platform: 'cli',
          organization_id: null,
        },
        {
          session_id: orgId,
          kilo_user_id: regularUser.id,
          created_on_platform: 'cli',
          organization_id: organization.id,
        },
      ]);

      fetchSpy = mockWorkerSessions([
        {
          id: personalId,
          status: 'busy',
          title: 'personal',
          connectionId: 'conn-p',
        },
        {
          id: orgId,
          status: 'busy',
          title: 'org',
          connectionId: 'conn-o',
        },
        {
          id: noRowId,
          status: 'busy',
          title: 'unattributable',
          connectionId: 'conn-nr',
        },
      ]);

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.activeSessions.list();

      expect(result.sessions.map(s => s.id).sort()).toEqual([personalId, orgId, noRowId].sort());
    });

    it('rejects list for an organization the user is not a member of', async () => {
      const foreignOrg = await createTestOrganization(
        'Active Sessions Foreign Org',
        otherUser.id,
        0
      );

      fetchSpy = mockWorkerSessions([
        {
          id: noRowId,
          status: 'busy',
          title: 'should not matter',
          connectionId: 'conn-x',
        },
      ]);

      const caller = await createCallerForUser(regularUser.id);
      // ensureOrganizationAccess throws UNAUTHORIZED for non-members.
      await expect(
        caller.activeSessions.list({ organizationId: foreignOrg.id })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });

    it('emits organizationId on every returned row including null for no-row sessions', async () => {
      const organization = await createTestOrganization(
        'Active Sessions OrgId Emit Org',
        regularUser.id,
        0
      );

      await db.insert(cli_sessions_v2).values([
        {
          session_id: personalId,
          kilo_user_id: regularUser.id,
          created_on_platform: 'cli',
          organization_id: null,
        },
        {
          session_id: orgId,
          kilo_user_id: regularUser.id,
          created_on_platform: 'cli',
          organization_id: organization.id,
        },
      ]);

      fetchSpy = mockWorkerSessions([
        {
          id: personalId,
          status: 'busy',
          title: 'personal',
          connectionId: 'conn-p',
        },
        {
          id: orgId,
          status: 'busy',
          title: 'org',
          connectionId: 'conn-o',
        },
        {
          id: noRowId,
          status: 'busy',
          title: 'unattributable',
          connectionId: 'conn-nr',
        },
      ]);

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.activeSessions.list();

      const byId = new Map(result.sessions.map(s => [s.id, s]));
      expect(byId.get(personalId)).toHaveProperty('organizationId', null);
      expect(byId.get(orgId)).toHaveProperty('organizationId', organization.id);
      // toHaveProperty with null fails on undefined — the client filter depends on this.
      expect(byId.get(noRowId)).toHaveProperty('organizationId', null);
    });

    it('uses cli_sessions_v2 title when set and falls back to the worker title when NULL', async () => {
      await db.insert(cli_sessions_v2).values([
        {
          session_id: titledId,
          kilo_user_id: regularUser.id,
          created_on_platform: 'cli',
          title: 'db renamed title',
        },
        {
          session_id: nullTitleId,
          kilo_user_id: regularUser.id,
          created_on_platform: 'cli',
          title: null,
        },
      ]);

      fetchSpy = mockWorkerSessions([
        {
          id: titledId,
          status: 'busy',
          title: 'cli stale title',
          connectionId: 'conn-t',
        },
        {
          id: nullTitleId,
          status: 'busy',
          title: 'cli live title',
          connectionId: 'conn-nt',
        },
      ]);

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.activeSessions.list();

      const byId = new Map(result.sessions.map(s => [s.id, s]));
      expect(byId.get(titledId)?.title).toBe('db renamed title');
      expect(byId.get(nullTitleId)?.title).toBe('cli live title');
    });

    it('on enrichment DB failure: unfiltered degrades, filtered contexts reject', async () => {
      const organization = await createTestOrganization(
        'Active Sessions Enrich Fail Org',
        regularUser.id,
        0
      );

      fetchSpy = mockWorkerSessions([
        {
          id: personalId,
          status: 'running',
          title: 'db fail filtered',
          connectionId: 'conn-fail',
        },
      ]);

      const caller = await createCallerForUser(regularUser.id);

      // Capture the real select before any spy replaces it. Filtered org
      // calls run ensureOrganizationAccess first (two selects); only the
      // enrichment select must throw.
      const originalSelect = db.select;

      // Unfiltered: best-effort unenriched passthrough (same contract as the
      // existing enrichment-failure test). No auth selects → first select is
      // enrichment.
      const unfilteredSelectSpy = jest.spyOn(db, 'select').mockImplementationOnce(() => {
        throw new Error('synthetic enrichment db failure unfiltered');
      });
      try {
        const unfiltered = await caller.activeSessions.list();
        expect(unfiltered.sessions).toEqual([
          {
            id: personalId,
            status: 'running',
            title: 'db fail filtered',
            connectionId: 'conn-fail',
            createdOnPlatform: undefined,
            createdAt: undefined,
            updatedAt: undefined,
          },
        ]);
      } finally {
        unfilteredSelectSpy.mockRestore();
      }

      // Personal filter: no auth selects → first select is enrichment → reject.
      const personalSelectSpy = jest.spyOn(db, 'select').mockImplementationOnce(() => {
        throw new Error('synthetic enrichment db failure personal');
      });
      try {
        await expect(caller.activeSessions.list({ organizationId: null })).rejects.toMatchObject({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to resolve the organization context for active sessions',
        });
      } finally {
        personalSelectSpy.mockRestore();
      }

      // Org filter: ensureOrganizationAccess issues two selects, then
      // enrichment is the third. Pass the auth selects through.
      const orgSelectSpy = jest.spyOn(db, 'select');
      orgSelectSpy.mockImplementation(fields => {
        if (orgSelectSpy.mock.calls.length <= 2) {
          return Reflect.apply(originalSelect, db, fields === undefined ? [] : [fields]);
        }
        throw new Error('synthetic enrichment db failure org');
      });
      try {
        await expect(
          caller.activeSessions.list({ organizationId: organization.id })
        ).rejects.toMatchObject({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to resolve the organization context for active sessions',
        });
      } finally {
        orgSelectSpy.mockRestore();
      }
    });

    it('enriches totalCostMicrodollars when DB value is present', async () => {
      const sessionId = 'ses_active_cost_enriched_1234';
      await db.insert(cli_sessions_v2).values({
        session_id: sessionId,
        kilo_user_id: regularUser.id,
        created_on_platform: 'cli',
        total_cost_microdollars: 12_000_000,
      });

      fetchSpy = mockWorkerSessions([
        {
          id: sessionId,
          status: 'running',
          title: 'cost test',
          connectionId: 'conn-cost',
        },
      ]);

      try {
        const caller = await createCallerForUser(regularUser.id);
        const result = await caller.activeSessions.list();

        expect(result.sessions).toHaveLength(1);
        expect(result.sessions[0]?.totalCostMicrodollars).toBe(12_000_000);
      } finally {
        await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, sessionId));
      }
    });

    it('omits totalCostMicrodollars when DB value is null', async () => {
      const sessionId = 'ses_active_cost_null_1234';
      await db.insert(cli_sessions_v2).values({
        session_id: sessionId,
        kilo_user_id: regularUser.id,
        created_on_platform: 'cli',
        total_cost_microdollars: null,
      });

      fetchSpy = mockWorkerSessions([
        {
          id: sessionId,
          status: 'running',
          title: 'cost null test',
          connectionId: 'conn-cost-null',
        },
      ]);

      try {
        const caller = await createCallerForUser(regularUser.id);
        const result = await caller.activeSessions.list();

        expect(result.sessions).toHaveLength(1);
        expect(result.sessions[0]).not.toHaveProperty('totalCostMicrodollars');
      } finally {
        await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, sessionId));
      }
    });

    it('passes zero totalCostMicrodollars on the wire', async () => {
      const sessionId = 'ses_active_cost_zero_1234';
      await db.insert(cli_sessions_v2).values({
        session_id: sessionId,
        kilo_user_id: regularUser.id,
        created_on_platform: 'cli',
        total_cost_microdollars: 0,
      });

      fetchSpy = mockWorkerSessions([
        {
          id: sessionId,
          status: 'running',
          title: 'cost zero test',
          connectionId: 'conn-cost-zero',
        },
      ]);

      try {
        const caller = await createCallerForUser(regularUser.id);
        const result = await caller.activeSessions.list();

        expect(result.sessions).toHaveLength(1);
        expect(result.sessions[0]?.totalCostMicrodollars).toBe(0);
      } finally {
        await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, sessionId));
      }
    });

    it('omits totalCostMicrodollars for unmatched heartbeat rows', async () => {
      const sessionId = 'ses_active_cost_unmatched_1234';

      fetchSpy = mockWorkerSessions([
        {
          id: sessionId,
          status: 'running',
          title: 'no db row',
          connectionId: 'conn-no-db',
        },
      ]);

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.activeSessions.list();

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]?.organizationId).toBeNull();
      // Unenriched rows never carry totalCostMicrodollars — the key is absent.
      expect(result.sessions[0]).not.toHaveProperty('totalCostMicrodollars');
    });
  });
});
