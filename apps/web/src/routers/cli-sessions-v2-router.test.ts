import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { db } from '@/lib/drizzle';
import {
  cloud_agent_webhook_triggers,
  cli_sessions_v2,
  github_branch_pull_requests,
  agent_environment_profiles,
  organizations,
  organization_memberships,
  platform_integrations,
} from '@kilocode/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import type { User, Organization } from '@kilocode/db/schema';
import * as githubAdapter from '@/lib/integrations/platforms/github/adapter';
import { TRPCError } from '@trpc/server';
import {
  parseGitHubOwnerRepo,
  parseGitHubPrUrl,
  computeSearchNextCursor,
} from '@/routers/cli-sessions-v2-router';
import type { fetchSessionMessagesPage as FetchSessionMessagesPageType } from '@/lib/session-ingest-client';
import { notifyCliSessionRenamed } from '@/lib/cloud-agent/session-events';
import { captureException } from '@sentry/nextjs';

// Mock the cloud agent client for watermark and runtime-state tests.
const mockGetSession = jest.fn().mockRejectedValue(new Error('not mocked'));

jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: jest.fn(() => ({
    getSession: mockGetSession,
  })),
  rethrowAsPaymentRequired: jest.fn(),
  InsufficientCreditsError: class InsufficientCreditsError extends Error {
    constructor(message = 'Insufficient credits') {
      super(message);
      this.name = 'InsufficientCreditsError';
    }
  },
}));

jest.mock('@/lib/tokens', () => {
  const actual: Record<string, unknown> = jest.requireActual('@/lib/tokens');
  return {
    ...actual,
    generateApiToken: jest.fn(() => 'test-api-token'),
    generateInternalServiceToken: jest.fn(() => 'test-internal-token'),
  };
});

jest.mock('@/lib/config.server', () => {
  const actual: Record<string, unknown> = jest.requireActual('@/lib/config.server');
  return {
    ...actual,
    SESSION_INGEST_WORKER_URL: 'https://test-ingest.example.com',
  };
});

// `after()` only works inside a Next request scope. Capture callbacks so rename
// notify tests can flush them outside a request context.
const afterCallbacks: Array<() => void | Promise<void>> = [];
jest.mock('next/server', () => {
  return {
    ...(jest.requireActual('next/server') as Record<string, unknown>),
    after: (fn: () => void | Promise<void>) => {
      afterCallbacks.push(fn);
    },
  };
});

jest.mock('@/lib/cloud-agent/session-events', () => ({
  notifyCliSessionRenamed: jest.fn().mockResolvedValue({ delivered: true }),
}));

jest.mock('@sentry/nextjs', () => {
  const actual: Record<string, unknown> = jest.requireActual('@sentry/nextjs');
  return {
    ...actual,
    captureException: jest.fn(),
  };
});

// SWC compiles ESM exports as non-configurable, so `jest.spyOn` on re-exported
// module members fails. Replace `fetchPullRequestByNumber` on the already-mocked
// adapter module with a fresh `jest.fn()` so individual tests can drive it.
jest.mock('@/lib/integrations/platforms/github/adapter', () => {
  const actual: Record<string, unknown> = jest.requireActual(
    '@/lib/integrations/platforms/github/adapter'
  );
  return {
    ...actual,
    fetchPullRequestByNumber: jest.fn(),
  };
});

// Same trick for the paginated session-message client. The web router only
// calls `fetchSessionMessagesPage`; the rest of the module keeps its real
// implementation via `requireActual`.
jest.mock('@/lib/session-ingest-client', () => {
  const actual: Record<string, unknown> = jest.requireActual('@/lib/session-ingest-client');
  return {
    ...actual,
    fetchSessionMessagesPage: jest.fn(),
  };
});

const mockedNotifyCliSessionRenamed = notifyCliSessionRenamed as jest.MockedFunction<
  typeof notifyCliSessionRenamed
>;
const mockedCaptureException = captureException as jest.MockedFunction<typeof captureException>;

async function flushAfterCallbacks(): Promise<void> {
  const pending = afterCallbacks.splice(0);
  await Promise.all(pending.map(fn => Promise.resolve(fn())));
}

const mockedFetchPullRequestByNumber =
  githubAdapter.fetchPullRequestByNumber as jest.MockedFunction<
    typeof githubAdapter.fetchPullRequestByNumber
  >;

let regularUser: User;
let otherUser: User;
let adminUser: User;
let testOrganization: Organization;

describe('cli-sessions-v2-router', () => {
  beforeEach(() => {
    afterCallbacks.length = 0;
    mockedNotifyCliSessionRenamed.mockReset().mockResolvedValue({ delivered: true });
    mockedCaptureException.mockClear();
  });

  beforeAll(async () => {
    regularUser = await insertTestUser({
      google_user_email: 'cli-sessions-v2-user@example.com',
      google_user_name: 'CLI Sessions V2 User',
      is_admin: false,
    });

    otherUser = await insertTestUser({
      google_user_email: 'cli-sessions-v2-other@example.com',
      google_user_name: 'CLI Sessions V2 Other User',
      is_admin: false,
    });

    adminUser = await insertTestUser({
      google_user_email: 'cli-sessions-v2-admin@example.com',
      google_user_name: 'CLI Sessions V2 Admin',
      is_admin: true,
    });

    const [org] = await db
      .insert(organizations)
      .values({
        name: 'CLI Sessions V2 Test Org',
        created_by_kilo_user_id: regularUser.id,
      })
      .returning();
    testOrganization = org;
  });

  describe('getSessionMessages', () => {
    const sessionId = 'ses_snapshot_metadata_test_1234';
    let fetchSpy: jest.SpyInstance;

    beforeEach(async () => {
      await db.insert(cli_sessions_v2).values({
        session_id: sessionId,
        kilo_user_id: regularUser.id,
        created_on_platform: 'cloud-agent',
      });
      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            info: {
              id: sessionId,
              model: {
                providerID: 'anthropic',
                id: 'claude-sonnet-4',
                variant: 'thinking',
              },
            },
            messages: [{ info: { id: 'msg_1', role: 'user' }, parts: [] }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
    });

    afterEach(async () => {
      fetchSpy.mockRestore();
      await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, sessionId));
    });

    it('returns validated snapshot info together with messages', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessionsV2.getSessionMessages({
        session_id: sessionId,
      });

      expect(result).toEqual({
        info: {
          id: sessionId,
          model: {
            providerID: 'anthropic',
            id: 'claude-sonnet-4',
            variant: 'thinking',
          },
        },
        messages: [{ info: { id: 'msg_1', role: 'user' }, parts: [] }],
      });
    });

    it('does not fetch a snapshot for a session owned by another user', async () => {
      const caller = await createCallerForUser(otherUser.id);

      await expect(
        caller.cliSessionsV2.getSessionMessages({ session_id: sessionId })
      ).rejects.toThrow('Session not found');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('getSessionMessagesPage', () => {
    const sessionId = 'ses_messages_page_test_1234';
    let fetchSessionMessagesPage: jest.MockedFunction<typeof FetchSessionMessagesPageType>;

    beforeEach(async () => {
      const { fetchSessionMessagesPage: imported } = jest.requireMock(
        '@/lib/session-ingest-client'
      ) as {
        fetchSessionMessagesPage: jest.MockedFunction<typeof FetchSessionMessagesPageType>;
      };
      fetchSessionMessagesPage = imported;
      fetchSessionMessagesPage.mockReset();
      await db.insert(cli_sessions_v2).values({
        session_id: sessionId,
        kilo_user_id: regularUser.id,
        created_on_platform: 'cloud-agent',
      });
    });

    afterEach(async () => {
      await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, sessionId));
    });

    it('returns the bounded page and the opaque next cursor for an owned session', async () => {
      const history = {
        messages: [
          {
            info: {
              id: 'msg_user_01',
              sessionID: sessionId,
              role: 'user' as const,
              time: { created: 1761000000100 },
              agent: 'build',
              model: {
                providerID: 'openrouter',
                modelID: 'anthropic/claude-sonnet-4',
              },
            },
            parts: [
              {
                id: 'prt_user_01',
                sessionID: sessionId,
                messageID: 'msg_user_01',
                type: 'text' as const,
                text: 'hello',
              },
            ],
          },
        ],
        nextCursor: 'opaque-cursor',
        omittedItemCount: 0,
      };
      fetchSessionMessagesPage.mockResolvedValueOnce({
        kiloSessionId: sessionId,
        history,
      });

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.getSessionMessagesPage({
        session_id: sessionId,
        limit: 50,
      });

      expect(result).toEqual({
        kiloSessionId: sessionId,
        history,
        watermarkEventId: null,
      });
      expect(fetchSessionMessagesPage).toHaveBeenCalledWith(sessionId, regularUser.id, {
        limit: 50,
      });
    });

    it('forwards the continuation cursor to the client', async () => {
      fetchSessionMessagesPage.mockResolvedValueOnce({
        kiloSessionId: sessionId,
        history: { messages: [], nextCursor: null, omittedItemCount: 0 },
      });

      const caller = await createCallerForUser(regularUser.id);
      const validCursor = btoa(JSON.stringify({ id: 'msg_user_01', time: 1761000000100 })).replace(
        /=+$/,
        ''
      );
      await caller.cliSessionsV2.getSessionMessagesPage({
        session_id: sessionId,
        limit: 25,
        cursor: validCursor,
      });

      expect(fetchSessionMessagesPage).toHaveBeenCalledWith(sessionId, regularUser.id, {
        limit: 25,
        before: validCursor,
      });
    });

    it('defaults an omitted limit to 50 before calling the client (bounded request)', async () => {
      fetchSessionMessagesPage.mockResolvedValueOnce({
        kiloSessionId: sessionId,
        history: { messages: [], nextCursor: null, omittedItemCount: 0 },
      });

      const caller = await createCallerForUser(regularUser.id);
      await caller.cliSessionsV2.getSessionMessagesPage({
        session_id: sessionId,
      });

      // The tRPC input schema must fill in the shared default before the
      // client is called so the worker's bounded reader always sees a
      // positive limit and never falls back to the legacy unbounded scan.
      expect(fetchSessionMessagesPage).toHaveBeenCalledWith(sessionId, regularUser.id, {
        limit: 50,
      });
    });

    it('defaults an omitted limit to 50 and forwards a cursor that would otherwise be cursor-only', async () => {
      fetchSessionMessagesPage.mockResolvedValueOnce({
        kiloSessionId: sessionId,
        history: { messages: [], nextCursor: null, omittedItemCount: 0 },
      });

      const caller = await createCallerForUser(regularUser.id);
      const validCursor = btoa(JSON.stringify({ id: 'msg_user_01', time: 1761000000100 })).replace(
        /=+$/,
        ''
      );
      await caller.cliSessionsV2.getSessionMessagesPage({
        session_id: sessionId,
        cursor: validCursor,
      });

      expect(fetchSessionMessagesPage).toHaveBeenCalledWith(sessionId, regularUser.id, {
        limit: 50,
        before: validCursor,
      });
    });

    it('preserves retryable_failure so the UI can offer Retry', async () => {
      const history = {
        kind: 'retryable_failure' as const,
        phase: 'page_parts' as const,
      };
      fetchSessionMessagesPage.mockResolvedValueOnce({
        kiloSessionId: sessionId,
        history,
      });

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.getSessionMessagesPage({
        session_id: sessionId,
        limit: 10,
      });

      expect(result).toEqual({
        kiloSessionId: sessionId,
        history,
        watermarkEventId: null,
      });
    });

    it('preserves too_large and invalid_data as non-retryable outcomes', async () => {
      for (const history of [
        {
          kind: 'too_large' as const,
          maximumBytes: 8 * 1024 * 1024,
          phase: 'message_scan' as const,
        },
        { kind: 'invalid_data' as const },
      ]) {
        fetchSessionMessagesPage.mockReset();
        fetchSessionMessagesPage.mockResolvedValueOnce({
          kiloSessionId: sessionId,
          history,
        });
        const caller = await createCallerForUser(regularUser.id);
        const result = await caller.cliSessionsV2.getSessionMessagesPage({
          session_id: sessionId,
          limit: 10,
        });
        expect(result).toEqual({
          kiloSessionId: sessionId,
          history,
          watermarkEventId: null,
        });
      }
    });

    it('returns an empty page for a valid session without persisted messages', async () => {
      fetchSessionMessagesPage.mockResolvedValueOnce({
        kiloSessionId: sessionId,
        history: { messages: [], nextCursor: null, omittedItemCount: 0 },
      });

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.getSessionMessagesPage({
        session_id: sessionId,
        limit: 50,
      });

      expect(result).toEqual({
        kiloSessionId: sessionId,
        history: { messages: [], nextCursor: null, omittedItemCount: 0 },
        watermarkEventId: null,
      });
    });

    it('rejects a session owned by another user before calling the client', async () => {
      const caller = await createCallerForUser(otherUser.id);

      await expect(
        caller.cliSessionsV2.getSessionMessagesPage({
          session_id: sessionId,
          limit: 50,
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(fetchSessionMessagesPage).not.toHaveBeenCalled();
    });

    it('rejects a session the user no longer has organization access to', async () => {
      const orgSessionId = 'ses_messages_page_org_test_12345';
      await db.insert(organization_memberships).values({
        organization_id: testOrganization.id,
        kilo_user_id: regularUser.id,
        role: 'member',
      });
      await db.insert(cli_sessions_v2).values({
        session_id: orgSessionId,
        kilo_user_id: regularUser.id,
        organization_id: testOrganization.id,
        created_on_platform: 'cloud-agent',
      });

      try {
        // Simulate losing membership without re-creating it in afterEach.
        await db
          .delete(organization_memberships)
          .where(
            and(
              eq(organization_memberships.organization_id, testOrganization.id),
              eq(organization_memberships.kilo_user_id, regularUser.id)
            )
          );

        const caller = await createCallerForUser(regularUser.id);
        await expect(
          caller.cliSessionsV2.getSessionMessagesPage({
            session_id: orgSessionId,
            limit: 50,
          })
        ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        expect(fetchSessionMessagesPage).not.toHaveBeenCalled();
      } finally {
        await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, orgSessionId));
      }
    });

    it('rejects a positive limit above the shared maximum before calling the client', async () => {
      const caller = await createCallerForUser(regularUser.id);

      await expect(
        caller.cliSessionsV2.getSessionMessagesPage({
          session_id: sessionId,
          limit: 101,
        })
      ).rejects.toThrow();
      expect(fetchSessionMessagesPage).not.toHaveBeenCalled();
    });

    it('rejects limit=0 (the generic endpoint is always bounded) before calling the client', async () => {
      const caller = await createCallerForUser(regularUser.id);

      await expect(
        caller.cliSessionsV2.getSessionMessagesPage({
          session_id: sessionId,
          limit: 0,
        })
      ).rejects.toThrow();
      expect(fetchSessionMessagesPage).not.toHaveBeenCalled();
    });

    it('rejects limit=0 even when a cursor is supplied', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const validCursor = btoa(JSON.stringify({ id: 'msg_user_01', time: 1761000000100 })).replace(
        /=+$/,
        ''
      );

      await expect(
        caller.cliSessionsV2.getSessionMessagesPage({
          session_id: sessionId,
          limit: 0,
          cursor: validCursor,
        })
      ).rejects.toThrow();
      expect(fetchSessionMessagesPage).not.toHaveBeenCalled();
    });

    it('maps a client throw to a stable INTERNAL_SERVER_ERROR (no client retry inference)', async () => {
      const clientError = new Error(
        'Session ingest messages page failed: 500 Internal Server Error'
      );
      fetchSessionMessagesPage.mockRejectedValueOnce(clientError);

      const caller = await createCallerForUser(regularUser.id);
      const rejection = await caller.cliSessionsV2
        .getSessionMessagesPage({ session_id: sessionId, limit: 50 })
        .catch(err => err);
      // The router must surface a stable, tRPC-shaped error so the mobile
      // client can map it without inferring retry semantics from the worker
      // message text. Assert a TRPCError with a stable message so we don't
      // depend on Sentry's tRPC middleware's default fallback.
      expect(rejection).toBeInstanceOf(TRPCError);
      expect(rejection).toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch session messages page',
      });
    });

    it('rejects a continuation cursor without a positive limit', async () => {
      const caller = await createCallerForUser(regularUser.id);

      await expect(
        caller.cliSessionsV2.getSessionMessagesPage({
          session_id: sessionId,
          cursor: 'bad',
        })
      ).rejects.toThrow();
      expect(fetchSessionMessagesPage).not.toHaveBeenCalled();
    });

    it('rejects a malformed continuation cursor before calling the client', async () => {
      const caller = await createCallerForUser(regularUser.id);

      await expect(
        caller.cliSessionsV2.getSessionMessagesPage({
          session_id: sessionId,
          limit: 10,
          cursor: 'not-a-real-cursor',
        })
      ).rejects.toThrow();
      expect(fetchSessionMessagesPage).not.toHaveBeenCalled();
    });

    it('rejects an invalid session id before calling the client', async () => {
      const caller = await createCallerForUser(regularUser.id);

      await expect(
        caller.cliSessionsV2.getSessionMessagesPage({
          session_id: 'not-a-session',
          limit: 50,
        })
      ).rejects.toThrow();
      expect(fetchSessionMessagesPage).not.toHaveBeenCalled();
    });

    describe('watermark', () => {
      const cloudAgentSessionId = 'agent_wm123456-1234-1234-1234-123456789abc';
      const watermarkSessionId = 'ses_watermark_test_123456';

      beforeEach(async () => {
        mockGetSession.mockReset().mockRejectedValue(new Error('not mocked'));
        await db.insert(cli_sessions_v2).values({
          session_id: watermarkSessionId,
          cloud_agent_session_id: cloudAgentSessionId,
          kilo_user_id: regularUser.id,
          created_on_platform: 'cloud-agent',
        });
      });

      afterEach(async () => {
        await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, watermarkSessionId));
      });

      it('carries a present watermark on the initial page response', async () => {
        mockGetSession.mockResolvedValue({ latestEventId: 42 });
        fetchSessionMessagesPage.mockResolvedValueOnce({
          kiloSessionId: watermarkSessionId,
          history: { messages: [], nextCursor: null, omittedItemCount: 0 },
        });

        const caller = await createCallerForUser(regularUser.id);
        const result = await caller.cliSessionsV2.getSessionMessagesPage({
          session_id: watermarkSessionId,
          limit: 50,
        });

        expect(result).toEqual({
          kiloSessionId: watermarkSessionId,
          history: { messages: [], nextCursor: null, omittedItemCount: 0 },
          watermarkEventId: 42,
        });
        expect(mockGetSession).toHaveBeenCalledWith(cloudAgentSessionId);
        // Verify both the watermark and the page were fetched.
        expect(fetchSessionMessagesPage).toHaveBeenCalled();
      });

      it('carries null watermark when the DO has no events', async () => {
        mockGetSession.mockResolvedValue({ latestEventId: null });
        fetchSessionMessagesPage.mockResolvedValueOnce({
          kiloSessionId: watermarkSessionId,
          history: { messages: [], nextCursor: null, omittedItemCount: 0 },
        });

        const caller = await createCallerForUser(regularUser.id);
        const result = await caller.cliSessionsV2.getSessionMessagesPage({
          session_id: watermarkSessionId,
          limit: 50,
        });

        expect(result).toEqual({
          kiloSessionId: watermarkSessionId,
          history: { messages: [], nextCursor: null, omittedItemCount: 0 },
          watermarkEventId: null,
        });
      });

      it('fails open: a watermark read failure returns null and page still succeeds', async () => {
        mockGetSession.mockRejectedValue(new Error('DO unreachable'));
        fetchSessionMessagesPage.mockResolvedValueOnce({
          kiloSessionId: watermarkSessionId,
          history: { messages: [], nextCursor: null, omittedItemCount: 0 },
        });

        const caller = await createCallerForUser(regularUser.id);
        const result = await caller.cliSessionsV2.getSessionMessagesPage({
          session_id: watermarkSessionId,
          limit: 50,
        });

        // The page must succeed with null watermark — no INTERNAL_SERVER_ERROR.
        expect(result).toEqual({
          kiloSessionId: watermarkSessionId,
          history: { messages: [], nextCursor: null, omittedItemCount: 0 },
          watermarkEventId: null,
        });
      });

      it('skips the watermark read when the session has no cloud_agent_session_id', async () => {
        // Remove the CA session ID and test that no watermark fetch happens.
        await db
          .update(cli_sessions_v2)
          .set({ cloud_agent_session_id: null })
          .where(eq(cli_sessions_v2.session_id, watermarkSessionId));

        fetchSessionMessagesPage.mockResolvedValueOnce({
          kiloSessionId: watermarkSessionId,
          history: { messages: [], nextCursor: null, omittedItemCount: 0 },
        });

        const caller = await createCallerForUser(regularUser.id);
        const result = await caller.cliSessionsV2.getSessionMessagesPage({
          session_id: watermarkSessionId,
          limit: 50,
        });

        expect(mockGetSession).not.toHaveBeenCalled();
        expect(result).toEqual({
          kiloSessionId: watermarkSessionId,
          history: { messages: [], nextCursor: null, omittedItemCount: 0 },
          watermarkEventId: null,
        });
      });

      it('skips the watermark read on cursor pages (continuation reads)', async () => {
        mockGetSession.mockRejectedValue(new Error('must not be called'));
        fetchSessionMessagesPage.mockResolvedValueOnce({
          kiloSessionId: watermarkSessionId,
          history: { messages: [], nextCursor: null, omittedItemCount: 0 },
        });

        const caller = await createCallerForUser(regularUser.id);
        const validCursor = btoa(
          JSON.stringify({ id: 'msg_user_01', time: 1761000000100 })
        ).replace(/=+$/, '');
        const result = await caller.cliSessionsV2.getSessionMessagesPage({
          session_id: watermarkSessionId,
          limit: 50,
          cursor: validCursor,
        });

        // Cursor pages must skip the Cloud Agent read entirely.
        expect(mockGetSession).not.toHaveBeenCalled();
        expect(result.watermarkEventId).toBeNull();
      });

      it('resolves getSession before fetchSessionMessagesPage starts (deferred-promise order proof)', async () => {
        // Deferred promise proves the router awaits getSession before calling
        // fetchSessionMessagesPage. Without this ordering, the watermark
        // read could race with the page fetch.
        let getSessionResolved = false;
        let resolveGetSession!: (value: { latestEventId: number }) => void;

        const getSessionPromise = new Promise<{ latestEventId: number }>(resolve => {
          resolveGetSession = resolve;
        });
        mockGetSession.mockReturnValue(getSessionPromise);

        let fetchPageCalled = false;
        let pageResolved = false;
        fetchSessionMessagesPage.mockImplementationOnce(async () => {
          fetchPageCalled = true;
          // If getSession hasn't resolved yet, the ordering is broken.
          expect(getSessionResolved).toBe(true);
          pageResolved = true;
          return {
            kiloSessionId: watermarkSessionId,
            history: { messages: [], nextCursor: null, omittedItemCount: 0 },
          };
        });

        const caller = await createCallerForUser(regularUser.id);
        const resultPromise = caller.cliSessionsV2.getSessionMessagesPage({
          session_id: watermarkSessionId,
          limit: 50,
        });

        // Let the router reach the getSession call.
        await new Promise(r => setTimeout(r, 0));

        // Neither getSession nor fetchPage has resolved yet.
        expect(getSessionResolved).toBe(false);
        expect(fetchPageCalled).toBe(false);

        // Resolve getSession — the router must then call fetchSessionMessagesPage.
        getSessionResolved = true;
        resolveGetSession({ latestEventId: 99 });

        const result = await resultPromise;
        expect(result.watermarkEventId).toBe(99);
        expect(pageResolved).toBe(true);
      });
    });
  });

  describe('shareForWebhookTrigger', () => {
    let triggerId: string;
    let profileId: string;
    const testTriggerId = 'test-trigger-share-v2';

    beforeAll(async () => {
      const [profile] = await db
        .insert(agent_environment_profiles)
        .values({
          owned_by_user_id: regularUser.id,
          name: 'share-test-profile-v2',
        })
        .returning({ id: agent_environment_profiles.id });
      profileId = profile.id;

      const [trigger] = await db
        .insert(cloud_agent_webhook_triggers)
        .values({
          trigger_id: testTriggerId,
          user_id: regularUser.id,
          github_repo: 'test/repo',
          profile_id: profileId,
        })
        .returning({ id: cloud_agent_webhook_triggers.id });
      triggerId = trigger.id;
    });

    afterAll(async () => {
      await db
        .delete(cloud_agent_webhook_triggers)
        .where(eq(cloud_agent_webhook_triggers.id, triggerId));
      await db
        .delete(agent_environment_profiles)
        .where(eq(agent_environment_profiles.id, profileId));
    });

    const v2SessionId = 'ses_test_share_v2_session_1234';
    let fetchSpy: jest.SpyInstance;

    beforeEach(async () => {
      await db.insert(cli_sessions_v2).values({
        session_id: v2SessionId,
        kilo_user_id: regularUser.id,
        created_on_platform: 'webhook',
      });

      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ success: true, public_id: 'test-public-uuid' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    afterEach(async () => {
      fetchSpy.mockRestore();
      await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, v2SessionId));
    });

    it('should share a v2 session via the session-ingest worker', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessionsV2.shareForWebhookTrigger({
        kilo_session_id: v2SessionId,
        trigger_id: testTriggerId,
      });

      expect(result).toEqual({
        share_id: 'test-public-uuid',
        session_id: v2SessionId,
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [fetchUrl, fetchOpts] = fetchSpy.mock.calls[0];
      expect(fetchUrl).toBe(
        `https://test-ingest.example.com/api/session/${encodeURIComponent(v2SessionId)}/share`
      );
      expect(fetchOpts.method).toBe('POST');
      expect(fetchOpts.headers.Authorization).toMatch(/^Bearer .+/);
    });

    it('should throw NOT_FOUND for non-existent v2 session', async () => {
      await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, v2SessionId));

      const caller = await createCallerForUser(regularUser.id);

      await expect(
        caller.cliSessionsV2.shareForWebhookTrigger({
          kilo_session_id: 'ses_nonexistent_session_12345',
          trigger_id: testTriggerId,
        })
      ).rejects.toThrow('Session not found');
    });

    it('should throw INTERNAL_SERVER_ERROR when session-ingest returns an error', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('Internal Server Error', {
          status: 500,
          statusText: 'Internal Server Error',
        })
      );

      const caller = await createCallerForUser(regularUser.id);

      await expect(
        caller.cliSessionsV2.shareForWebhookTrigger({
          kilo_session_id: v2SessionId,
          trigger_id: testTriggerId,
        })
      ).rejects.toThrow('Session share failed: 500 Internal Server Error');
    });

    it('should throw NOT_FOUND when session belongs to a different user (personal trigger)', async () => {
      // Session is created by regularUser (via beforeEach), but otherUser tries to share it
      // otherUser needs their own trigger to pass verifyWebhookTriggerAccess
      const [otherProfile] = await db
        .insert(agent_environment_profiles)
        .values({
          owned_by_user_id: otherUser.id,
          name: 'other-user-share-profile-v2',
        })
        .returning({ id: agent_environment_profiles.id });

      const otherTriggerId = 'test-trigger-share-other-user-v2';
      const [otherTrigger] = await db
        .insert(cloud_agent_webhook_triggers)
        .values({
          trigger_id: otherTriggerId,
          user_id: otherUser.id,
          github_repo: 'test/other-repo',
          profile_id: otherProfile.id,
        })
        .returning({ id: cloud_agent_webhook_triggers.id });

      try {
        const caller = await createCallerForUser(otherUser.id);
        await expect(
          caller.cliSessionsV2.shareForWebhookTrigger({
            kilo_session_id: v2SessionId,
            trigger_id: otherTriggerId,
          })
        ).rejects.toThrow('Session not found');
      } finally {
        await db
          .delete(cloud_agent_webhook_triggers)
          .where(eq(cloud_agent_webhook_triggers.id, otherTrigger.id));
        await db
          .delete(agent_environment_profiles)
          .where(eq(agent_environment_profiles.id, otherProfile.id));
      }
    });

    it('should throw NOT_FOUND when session belongs to a different org (org trigger)', async () => {
      // Create a session belonging to testOrganization
      const orgSessionId = 'ses_test_share_v2_org_session_1234';
      await db.insert(cli_sessions_v2).values({
        session_id: orgSessionId,
        kilo_user_id: regularUser.id,
        created_on_platform: 'webhook',
        organization_id: testOrganization.id,
      });

      // Create a second org and an org trigger for it
      const [otherOrg] = await db
        .insert(organizations)
        .values({
          name: 'Other Org for Share Test V2',
          created_by_kilo_user_id: regularUser.id,
        })
        .returning();

      await db.insert(organization_memberships).values({
        organization_id: otherOrg.id,
        kilo_user_id: regularUser.id,
        role: 'owner',
      });

      const [otherProfile] = await db
        .insert(agent_environment_profiles)
        .values({
          name: 'other-org-share-profile-v2',
          owned_by_organization_id: otherOrg.id,
        })
        .returning({ id: agent_environment_profiles.id });

      const otherOrgTriggerId = 'test-trigger-share-other-org-v2';
      const [otherOrgTrigger] = await db
        .insert(cloud_agent_webhook_triggers)
        .values({
          trigger_id: otherOrgTriggerId,
          organization_id: otherOrg.id,
          github_repo: 'test/other-org-repo',
          profile_id: otherProfile.id,
        })
        .returning({ id: cloud_agent_webhook_triggers.id });

      try {
        const caller = await createCallerForUser(regularUser.id);
        // Try to share orgSession (belongs to testOrganization) via otherOrg's trigger
        await expect(
          caller.cliSessionsV2.shareForWebhookTrigger({
            kilo_session_id: orgSessionId,
            trigger_id: otherOrgTriggerId,
            organization_id: otherOrg.id,
          })
        ).rejects.toThrow('Session not found');
      } finally {
        await db
          .delete(cloud_agent_webhook_triggers)
          .where(eq(cloud_agent_webhook_triggers.id, otherOrgTrigger.id));
        await db
          .delete(agent_environment_profiles)
          .where(eq(agent_environment_profiles.id, otherProfile.id));
        await db
          .delete(organization_memberships)
          .where(
            and(
              eq(organization_memberships.organization_id, otherOrg.id),
              eq(organization_memberships.kilo_user_id, regularUser.id)
            )
          );
        await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, orgSessionId));
        await db.delete(organizations).where(eq(organizations.id, otherOrg.id));
      }
    });

    it('should throw NOT_FOUND for non-existent trigger', async () => {
      const caller = await createCallerForUser(regularUser.id);

      await expect(
        caller.cliSessionsV2.shareForWebhookTrigger({
          kilo_session_id: v2SessionId,
          trigger_id: 'non-existent-trigger',
        })
      ).rejects.toThrow('Trigger not found');
    });
  });

  describe('session authorization', () => {
    const organizationSessionId = 'ses_read_auth_org_1234';
    const cloudAgentSessionId = 'cloud-agent-read-auth-org-1234';

    async function removeCreatorMembership() {
      await db
        .delete(organization_memberships)
        .where(
          and(
            eq(organization_memberships.organization_id, testOrganization.id),
            eq(organization_memberships.kilo_user_id, regularUser.id)
          )
        );
    }

    beforeEach(async () => {
      await db.insert(organization_memberships).values({
        organization_id: testOrganization.id,
        kilo_user_id: regularUser.id,
        role: 'member',
      });
      await db.insert(cli_sessions_v2).values({
        session_id: organizationSessionId,
        cloud_agent_session_id: cloudAgentSessionId,
        kilo_user_id: regularUser.id,
        organization_id: testOrganization.id,
        created_on_platform: 'cloud-agent',
      });
    });

    afterEach(async () => {
      await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, organizationSessionId));
      await removeCreatorMembership();
    });

    it('list omits organization sessions after their creator loses membership', async () => {
      const personalSessionId = 'ses_read_auth_personal_1234';
      await db.insert(cli_sessions_v2).values({
        session_id: personalSessionId,
        kilo_user_id: regularUser.id,
        created_on_platform: 'cloud-agent',
      });

      try {
        const caller = await createCallerForUser(regularUser.id);
        const beforeRemoval = await caller.cliSessionsV2.list({});
        expect(beforeRemoval.cliSessions.map(session => session.session_id)).toEqual(
          expect.arrayContaining([organizationSessionId, personalSessionId])
        );

        await removeCreatorMembership();

        const afterRemoval = await caller.cliSessionsV2.list({});
        expect(afterRemoval.cliSessions.map(session => session.session_id)).toContain(
          personalSessionId
        );
        expect(afterRemoval.cliSessions.map(session => session.session_id)).not.toContain(
          organizationSessionId
        );
      } finally {
        await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, personalSessionId));
      }
    });

    it('list preserves platform-admin access without organization membership', async () => {
      const adminSessionId = 'ses_read_auth_admin_1234';
      await db.insert(cli_sessions_v2).values({
        session_id: adminSessionId,
        kilo_user_id: adminUser.id,
        organization_id: testOrganization.id,
        created_on_platform: 'cloud-agent',
      });

      try {
        const caller = await createCallerForUser(adminUser.id);
        const result = await caller.cliSessionsV2.list({});

        expect(result.cliSessions.map(session => session.session_id)).toContain(adminSessionId);
      } finally {
        await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, adminSessionId));
      }
    });

    it('search omits organization sessions after their creator loses membership', async () => {
      await db
        .update(cli_sessions_v2)
        .set({ title: 'removed-member-search-result' })
        .where(eq(cli_sessions_v2.session_id, organizationSessionId));
      await removeCreatorMembership();

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.search({
        search_string: 'removed-member-search-result',
      });

      expect(result.results).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('recentRepositories omits organization sessions after their creator loses membership', async () => {
      const personalSessionId = 'ses_recent_repo_personal_1234';
      const personalGitUrl = 'https://github.com/kilo/personal-repository';
      const organizationGitUrl = 'https://github.com/kilo/organization-repository';
      await db
        .update(cli_sessions_v2)
        .set({ git_url: organizationGitUrl })
        .where(eq(cli_sessions_v2.session_id, organizationSessionId));
      await db.insert(cli_sessions_v2).values({
        session_id: personalSessionId,
        kilo_user_id: regularUser.id,
        created_on_platform: 'cloud-agent',
        git_url: personalGitUrl,
      });

      try {
        await removeCreatorMembership();

        const caller = await createCallerForUser(regularUser.id);
        const result = await caller.cliSessionsV2.recentRepositories({
          updatedSince: '2026-01-01T00:00:00.000Z',
        });
        const gitUrls = result.repositories.map(repository => repository.gitUrl);

        expect(gitUrls).toContain(personalGitUrl);
        expect(gitUrls).not.toContain(organizationGitUrl);
      } finally {
        await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, personalSessionId));
      }
    });

    it('delete rejects an organization session before cleanup after its creator loses membership', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      try {
        await removeCreatorMembership();

        const caller = await createCallerForUser(regularUser.id);
        await expect(
          caller.cliSessionsV2.delete({ session_id: organizationSessionId })
        ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('rename permits a current organization member', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.rename({
        session_id: organizationSessionId,
        title: 'renamed by current member',
      });

      expect(result.title).toBe('renamed by current member');
    });

    it('rename always overwrites the title, whether it is still the creation placeholder or an existing (e.g. agent-generated) title', async () => {
      const caller = await createCallerForUser(regularUser.id);

      // Session starts with title NULL (the creation placeholder) — rename must succeed.
      const [beforeAnyTitle] = await db
        .select({ title: cli_sessions_v2.title })
        .from(cli_sessions_v2)
        .where(eq(cli_sessions_v2.session_id, organizationSessionId));
      expect(beforeAnyTitle?.title).toBeNull();

      const firstRename = await caller.cliSessionsV2.rename({
        session_id: organizationSessionId,
        title: 'agent-generated title',
      });
      expect(firstRename.title).toBe('agent-generated title');

      // A subsequent user rename must overwrite an already non-null (agent-generated) title too.
      const secondRename = await caller.cliSessionsV2.rename({
        session_id: organizationSessionId,
        title: 'user renamed title',
      });
      expect(secondRename.title).toBe('user renamed title');

      const [persisted] = await db
        .select({ title: cli_sessions_v2.title })
        .from(cli_sessions_v2)
        .where(eq(cli_sessions_v2.session_id, organizationSessionId));
      expect(persisted?.title).toBe('user renamed title');
    });

    it('rename rejects an organization session after its creator loses membership', async () => {
      const originalTitle = 'organization session title';
      await db
        .update(cli_sessions_v2)
        .set({ title: originalTitle })
        .where(eq(cli_sessions_v2.session_id, organizationSessionId));
      await removeCreatorMembership();

      const caller = await createCallerForUser(regularUser.id);
      await expect(
        caller.cliSessionsV2.rename({
          session_id: organizationSessionId,
          title: 'renamed after removal',
        })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

      const [session] = await db
        .select({ title: cli_sessions_v2.title })
        .from(cli_sessions_v2)
        .where(eq(cli_sessions_v2.session_id, organizationSessionId));
      expect(session?.title).toBe(originalTitle);
    });

    it('share rejects an organization session before publishing after its creator loses membership', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ success: true, public_id: 'test-public-uuid' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      try {
        await removeCreatorMembership();

        const caller = await createCallerForUser(regularUser.id);
        await expect(
          caller.cliSessionsV2.share({ session_id: organizationSessionId })
        ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('get rejects an organization session after its creator loses membership', async () => {
      await removeCreatorMembership();

      const caller = await createCallerForUser(regularUser.id);

      await expect(
        caller.cliSessionsV2.get({ session_id: organizationSessionId })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });

    it('getByCloudAgentSessionId rejects an organization session after its creator loses membership', async () => {
      await removeCreatorMembership();

      const caller = await createCallerForUser(regularUser.id);

      await expect(
        caller.cliSessionsV2.getByCloudAgentSessionId({
          cloud_agent_session_id: cloudAgentSessionId,
        })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });

    it('getSessionMessages rejects an organization session before fetching messages after its creator loses membership', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ info: {}, messages: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      try {
        await removeCreatorMembership();

        const caller = await createCallerForUser(regularUser.id);

        await expect(
          caller.cliSessionsV2.getSessionMessages({
            session_id: organizationSessionId,
          })
        ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  describe('parseGitHubOwnerRepo', () => {
    it('parses https URLs', () => {
      expect(parseGitHubOwnerRepo('https://github.com/Kilo/repo')).toEqual({
        owner: 'Kilo',
        repo: 'repo',
      });
    });
    it('strips trailing .git', () => {
      expect(parseGitHubOwnerRepo('https://github.com/kilo/repo.git')).toEqual({
        owner: 'kilo',
        repo: 'repo',
      });
    });
    it('parses ssh URLs', () => {
      expect(parseGitHubOwnerRepo('git@github.com:kilo/repo.git')).toEqual({
        owner: 'kilo',
        repo: 'repo',
      });
    });
    it('parses ssh:// URLs', () => {
      expect(parseGitHubOwnerRepo('ssh://git@github.com/kilo/repo.git')).toEqual({
        owner: 'kilo',
        repo: 'repo',
      });
    });
    it('rejects non-GitHub hosts', () => {
      expect(parseGitHubOwnerRepo('https://gitlab.com/kilo/repo')).toBeNull();
      expect(parseGitHubOwnerRepo('git@gitlab.com:kilo/repo.git')).toBeNull();
    });
    it('rejects URLs that do not resolve to owner/repo', () => {
      expect(parseGitHubOwnerRepo('https://github.com/kilo')).toBeNull();
      expect(parseGitHubOwnerRepo('https://github.com/kilo/repo/tree/main')).toBeNull();
      expect(parseGitHubOwnerRepo('not-a-url')).toBeNull();
    });
  });

  describe('parseGitHubPrUrl', () => {
    it('parses https PR URLs', () => {
      expect(parseGitHubPrUrl('https://github.com/Kilo/repo/pull/42')).toEqual({
        owner: 'Kilo',
        repo: 'repo',
        number: 42,
      });
    });
    it('parses trailing subpaths, query strings, fragments, and trailing slashes (matching the mobile parser)', () => {
      expect(parseGitHubPrUrl('https://github.com/Kilo/repo/pull/42/files')).toEqual({
        owner: 'Kilo',
        repo: 'repo',
        number: 42,
      });
      expect(parseGitHubPrUrl('https://github.com/Kilo/repo/pull/42/files?diff=split')).toEqual({
        owner: 'Kilo',
        repo: 'repo',
        number: 42,
      });
      expect(parseGitHubPrUrl('https://github.com/Kilo/repo/pull/42#issuecomment-123')).toEqual({
        owner: 'Kilo',
        repo: 'repo',
        number: 42,
      });
      expect(parseGitHubPrUrl('https://github.com/Kilo/repo/pull/42/')).toEqual({
        owner: 'Kilo',
        repo: 'repo',
        number: 42,
      });
    });
    it('rejects URLs that are not PR URLs', () => {
      expect(parseGitHubPrUrl('https://github.com/kilo/repo')).toBeNull();
      expect(parseGitHubPrUrl('https://github.com/kilo/repo/tree/main')).toBeNull();
      expect(parseGitHubPrUrl('https://gitlab.com/kilo/repo/pull/42')).toBeNull();
      expect(parseGitHubPrUrl('https://github.com/kilo/repo/pull/abc')).toBeNull();
      expect(parseGitHubPrUrl('not-a-url')).toBeNull();
    });
  });

  describe('getWithRuntimeState associatedPr', () => {
    const sessionWithPr = 'ses_assoc_pr_present_1234';
    const sessionWithoutPr = 'ses_assoc_pr_absent_1234';
    const CACHE_GIT_URL = 'https://github.com/kilo/repo';

    beforeEach(async () => {
      await db.insert(cli_sessions_v2).values([
        {
          session_id: sessionWithPr,
          kilo_user_id: regularUser.id,
          created_on_platform: 'cloud-agent',
          git_url: CACHE_GIT_URL,
          git_branch: 'feature/x',
        },
        {
          session_id: sessionWithoutPr,
          kilo_user_id: regularUser.id,
          created_on_platform: 'cloud-agent',
          git_url: CACHE_GIT_URL,
          git_branch: 'feature/y',
        },
      ]);
      await db.insert(github_branch_pull_requests).values({
        git_url: CACHE_GIT_URL,
        git_branch: 'feature/x',
        owned_by_user_id: regularUser.id,
        pr_url: 'https://github.com/kilo/repo/pull/42',
        pr_number: 42,
        pr_state: 'open',
        pr_title: 'Add feature X',
        pr_head_sha: 'deadbeefcafe',
      });
    });

    afterEach(async () => {
      await db
        .delete(github_branch_pull_requests)
        .where(
          and(
            eq(github_branch_pull_requests.git_url, CACHE_GIT_URL),
            eq(github_branch_pull_requests.owned_by_user_id, regularUser.id)
          )
        );
      await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, sessionWithPr));
      await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, sessionWithoutPr));
    });

    it('returns associatedPr when the per-tenant cache has a row for (git_url, git_branch)', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.getWithRuntimeState({
        session_id: sessionWithPr,
      });

      expect(result.associatedPr).toMatchObject({
        url: 'https://github.com/kilo/repo/pull/42',
        number: 42,
        state: 'open',
        title: 'Add feature X',
        headSha: 'deadbeefcafe',
      });
      expect(typeof result.associatedPr?.lastSyncedAt).toBe('string');
    });

    it('returns null associatedPr when the per-tenant cache has no row for (git_url, git_branch)', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.getWithRuntimeState({
        session_id: sessionWithoutPr,
      });
      expect(result.associatedPr).toBeNull();
    });

    it('does not leak PR metadata across tenants on the same (git_url, git_branch)', async () => {
      // Cache row belongs to regularUser. otherUser has a session on the
      // same repo+branch but a different tenant → the JOIN must miss.
      const crossTenantSessionId = 'ses_assoc_pr_cross_tenant_1234';
      await db.insert(cli_sessions_v2).values({
        session_id: crossTenantSessionId,
        kilo_user_id: otherUser.id,
        created_on_platform: 'cloud-agent',
        git_url: CACHE_GIT_URL,
        git_branch: 'feature/x',
      });
      try {
        const caller = await createCallerForUser(otherUser.id);
        const result = await caller.cliSessionsV2.getWithRuntimeState({
          session_id: crossTenantSessionId,
        });
        expect(result.associatedPr).toBeNull();
      } finally {
        await db
          .delete(cli_sessions_v2)
          .where(eq(cli_sessions_v2.session_id, crossTenantSessionId));
      }
    });

    it('throws NOT_FOUND when the session is owned by another user', async () => {
      const caller = await createCallerForUser(otherUser.id);
      await expect(
        caller.cliSessionsV2.getWithRuntimeState({ session_id: sessionWithPr })
      ).rejects.toThrow('Session not found');
    });

    it('rejects org-scoped reads for a user who is no longer an org member', async () => {
      const [otherOrg] = await db
        .insert(organizations)
        .values({
          name: 'Get Runtime State Org Access Test',
          created_by_kilo_user_id: regularUser.id,
        })
        .returning();

      // Stale session row ties regularUser to an org they do not belong to.
      // A `kilo_user_id` match alone must not be enough to return cached PR data.
      await db
        .update(cli_sessions_v2)
        .set({ organization_id: otherOrg.id })
        .where(eq(cli_sessions_v2.session_id, sessionWithPr));

      try {
        const caller = await createCallerForUser(regularUser.id);
        await expect(
          caller.cliSessionsV2.getWithRuntimeState({
            session_id: sessionWithPr,
          })
        ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      } finally {
        await db
          .update(cli_sessions_v2)
          .set({ organization_id: null })
          .where(eq(cli_sessions_v2.session_id, sessionWithPr));
        await db.delete(organizations).where(eq(organizations.id, otherOrg.id));
      }
    });

    it('uses live cache fields when the session link matches the branch cache', async () => {
      // Give sessionWithPr a stored link that matches the cache row (pull/42).
      await db
        .update(cli_sessions_v2)
        .set({
          platform: 'github',
          pr_url: 'https://github.com/kilo/repo/pull/42',
          pr_number: 42,
        })
        .where(eq(cli_sessions_v2.session_id, sessionWithPr));

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.getWithRuntimeState({
        session_id: sessionWithPr,
      });

      expect(result.associatedPr).toMatchObject({
        url: 'https://github.com/kilo/repo/pull/42',
        number: 42,
        state: 'open',
        title: 'Add feature X',
        headSha: 'deadbeefcafe',
        platform: 'github',
      });
    });

    it('uses live cache fields when the stored link has a trailing subpath', async () => {
      // Stored link names the same PR (pull/42) as the cache row, with a
      // trailing subpath. Raw string equality fails; normalized comparison wins.
      await db
        .update(cli_sessions_v2)
        .set({
          platform: 'github',
          pr_url: 'https://github.com/kilo/repo/pull/42/files',
          pr_number: 42,
        })
        .where(eq(cli_sessions_v2.session_id, sessionWithPr));

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.getWithRuntimeState({
        session_id: sessionWithPr,
      });

      expect(result.associatedPr).toMatchObject({
        url: 'https://github.com/kilo/repo/pull/42',
        number: 42,
        state: 'open',
        title: 'Add feature X',
        headSha: 'deadbeefcafe',
        platform: 'github',
      });
    });

    it('uses live cache fields when the stored link has mixed-case owner/repo', async () => {
      // Stored link names the same PR (pull/42) as the canonical lowercase
      // cache URL, but with mixed-case owner/repo. Owner and repo compare
      // case-insensitively.
      await db
        .update(cli_sessions_v2)
        .set({
          platform: 'github',
          pr_url: 'https://github.com/Kilo/Repo/pull/42',
          pr_number: 42,
        })
        .where(eq(cli_sessions_v2.session_id, sessionWithPr));

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.getWithRuntimeState({
        session_id: sessionWithPr,
      });

      expect(result.associatedPr).toMatchObject({
        url: 'https://github.com/kilo/repo/pull/42',
        number: 42,
        state: 'open',
        title: 'Add feature X',
        headSha: 'deadbeefcafe',
        platform: 'github',
      });
    });

    it('returns the session partial (not the other PR) when the session link disagrees with the branch cache', async () => {
      // Session link points at a different PR than the branch cache (pull/42).
      await db
        .update(cli_sessions_v2)
        .set({
          platform: 'github',
          pr_url: 'https://github.com/kilo/repo/pull/999',
          pr_number: 999,
        })
        .where(eq(cli_sessions_v2.session_id, sessionWithPr));

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.getWithRuntimeState({
        session_id: sessionWithPr,
      });

      expect(result.associatedPr).toMatchObject({
        url: 'https://github.com/kilo/repo/pull/999',
        number: 999,
        state: 'unknown',
        title: null,
        headSha: null,
        reviewDecision: null,
        reviewDecisionPending: true,
        platform: 'github',
      });
    });

    it('uses the branch fallback when the session has no stored link', async () => {
      // sessionWithPr has no pr_url; the branch cache row (pull/42) is used.
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.getWithRuntimeState({
        session_id: sessionWithPr,
      });

      expect(result.associatedPr).toMatchObject({
        url: 'https://github.com/kilo/repo/pull/42',
        number: 42,
        state: 'open',
        platform: 'github',
      });
    });
  });

  describe('list / search associatedPr', () => {
    // Same fixtures as the getWithRuntimeState block: one session with a
    // matching cache row, one without. Both sessions are recent so they fall
    // inside the default `updatedSince` window of `list`.
    const sessionWithPr = 'ses_list_pr_present_5678';
    const sessionWithoutPr = 'ses_list_pr_absent_5678';
    const CACHE_GIT_URL = 'https://github.com/kilo/repo';

    beforeEach(async () => {
      await db.insert(cli_sessions_v2).values([
        {
          session_id: sessionWithPr,
          kilo_user_id: regularUser.id,
          created_on_platform: 'cloud-agent',
          git_url: CACHE_GIT_URL,
          git_branch: 'feature/list-x',
          title: 'session with PR',
        },
        {
          session_id: sessionWithoutPr,
          kilo_user_id: regularUser.id,
          created_on_platform: 'cloud-agent',
          git_url: CACHE_GIT_URL,
          git_branch: 'feature/list-y',
          title: 'session without PR',
        },
      ]);
      await db.insert(github_branch_pull_requests).values({
        git_url: CACHE_GIT_URL,
        git_branch: 'feature/list-x',
        owned_by_user_id: regularUser.id,
        pr_url: 'https://github.com/kilo/repo/pull/77',
        pr_number: 77,
        pr_state: 'open',
        pr_title: 'List endpoint feature',
        pr_head_sha: 'cafef00d',
      });
    });

    afterEach(async () => {
      await db
        .delete(github_branch_pull_requests)
        .where(
          and(
            eq(github_branch_pull_requests.git_url, CACHE_GIT_URL),
            eq(github_branch_pull_requests.owned_by_user_id, regularUser.id)
          )
        );
      await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, sessionWithPr));
      await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, sessionWithoutPr));
    });

    it('list returns associatedPr per row from the per-tenant cache', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.list({});

      const withPr = result.cliSessions.find(s => s.session_id === sessionWithPr);
      const withoutPr = result.cliSessions.find(s => s.session_id === sessionWithoutPr);

      expect(withPr?.associatedPr).toMatchObject({
        url: 'https://github.com/kilo/repo/pull/77',
        number: 77,
        state: 'open',
        title: 'List endpoint feature',
        headSha: 'cafef00d',
        reviewDecision: null,
      });
      expect(typeof withPr?.associatedPr?.lastSyncedAt).toBe('string');
      expect(withoutPr?.associatedPr).toBeNull();
    });

    it('list returns live cache fields when the stored link has a trailing subpath', async () => {
      // Stored link names the same PR (pull/77) as the cache row, with a
      // trailing subpath. Normalized comparison must yield live cache fields.
      await db
        .update(cli_sessions_v2)
        .set({
          platform: 'github',
          pr_url: 'https://github.com/kilo/repo/pull/77/files',
          pr_number: 77,
        })
        .where(eq(cli_sessions_v2.session_id, sessionWithPr));

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.list({});

      const row = result.cliSessions.find(s => s.session_id === sessionWithPr);
      expect(row?.associatedPr).toMatchObject({
        url: 'https://github.com/kilo/repo/pull/77',
        number: 77,
        state: 'open',
        title: 'List endpoint feature',
        headSha: 'cafef00d',
      });
    });

    it('search returns live cache fields when the stored link has a trailing subpath', async () => {
      await db
        .update(cli_sessions_v2)
        .set({
          platform: 'github',
          pr_url: 'https://github.com/kilo/repo/pull/77/files',
          pr_number: 77,
        })
        .where(eq(cli_sessions_v2.session_id, sessionWithPr));

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.search({
        search_string: 'session',
      });

      const row = result.results.find(s => s.session_id === sessionWithPr);
      expect(row?.associatedPr).toMatchObject({ number: 77, state: 'open' });
    });

    it.each([
      'git@github.com:Kilo/Repo.git',
      'ssh://git@github.com/Kilo/Repo.git',
      'https://token@github.com/Kilo/Repo.git',
    ])('list normalizes git URL filter %s', async gitUrl => {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.list({ gitUrl });

      expect(result.cliSessions.map(session => session.session_id)).toEqual(
        expect.arrayContaining([sessionWithPr, sessionWithoutPr])
      );
    });

    it('search normalizes git URL filters', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.search({
        search_string: 'session',
        gitUrl: 'git@github.com:Kilo/Repo.git',
      });

      expect(result.results.map(session => session.session_id)).toEqual(
        expect.arrayContaining([sessionWithPr, sessionWithoutPr])
      );
    });

    it('list exposes reviewDecision when the cache row has it set', async () => {
      // Update the existing cache row to have an approved review decision.
      await db
        .update(github_branch_pull_requests)
        .set({ pr_review_decision: 'approved' })
        .where(
          and(
            eq(github_branch_pull_requests.git_url, CACHE_GIT_URL),
            eq(github_branch_pull_requests.owned_by_user_id, regularUser.id)
          )
        );

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.list({});
      const withPr = result.cliSessions.find(s => s.session_id === sessionWithPr);

      expect(withPr?.associatedPr?.reviewDecision).toBe('approved');

      // Reset back to null for subsequent tests.
      await db
        .update(github_branch_pull_requests)
        .set({ pr_review_decision: null })
        .where(
          and(
            eq(github_branch_pull_requests.git_url, CACHE_GIT_URL),
            eq(github_branch_pull_requests.owned_by_user_id, regularUser.id)
          )
        );
    });

    it('list exposes reviewDecisionPending so the client can poll while a fetch is in flight', async () => {
      const caller = await createCallerForUser(regularUser.id);

      // Default cache row has review_decision_pending=false.
      const beforeFlag = await caller.cliSessionsV2.list({});
      const beforeRow = beforeFlag.cliSessions.find(s => s.session_id === sessionWithPr);
      expect(beforeRow?.associatedPr?.reviewDecisionPending).toBe(false);

      // Flip the flag the way a webhook upsert does.
      await db
        .update(github_branch_pull_requests)
        .set({ review_decision_pending: true })
        .where(
          and(
            eq(github_branch_pull_requests.git_url, CACHE_GIT_URL),
            eq(github_branch_pull_requests.owned_by_user_id, regularUser.id)
          )
        );

      const afterFlag = await caller.cliSessionsV2.list({});
      const afterRow = afterFlag.cliSessions.find(s => s.session_id === sessionWithPr);
      expect(afterRow?.associatedPr?.reviewDecisionPending).toBe(true);

      // Reset for subsequent tests.
      await db
        .update(github_branch_pull_requests)
        .set({ review_decision_pending: false })
        .where(
          and(
            eq(github_branch_pull_requests.git_url, CACHE_GIT_URL),
            eq(github_branch_pull_requests.owned_by_user_id, regularUser.id)
          )
        );
    });

    it('list does not leak PR metadata across tenants on the same (git_url, git_branch)', async () => {
      // Same repo+branch as the cache row, but for otherUser → JOIN must miss.
      const crossTenantSessionId = 'ses_list_pr_cross_tenant_5678';
      await db.insert(cli_sessions_v2).values({
        session_id: crossTenantSessionId,
        kilo_user_id: otherUser.id,
        created_on_platform: 'cloud-agent',
        git_url: CACHE_GIT_URL,
        git_branch: 'feature/list-x',
        title: 'cross-tenant session',
      });
      try {
        const caller = await createCallerForUser(otherUser.id);
        const result = await caller.cliSessionsV2.list({});
        const row = result.cliSessions.find(s => s.session_id === crossTenantSessionId);
        expect(row?.associatedPr).toBeNull();
      } finally {
        await db
          .delete(cli_sessions_v2)
          .where(eq(cli_sessions_v2.session_id, crossTenantSessionId));
      }
    });

    it('search returns associatedPr per row matching the search string', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.search({
        search_string: 'session',
      });

      const withPr = result.results.find(s => s.session_id === sessionWithPr);
      const withoutPr = result.results.find(s => s.session_id === sessionWithoutPr);

      expect(withPr?.associatedPr).toMatchObject({ number: 77, state: 'open' });
      expect(withoutPr?.associatedPr).toBeNull();
    });

    it('list returns the session partial (not the other cache PR) when the stored link disagrees', async () => {
      // Session link points at a different PR than the branch cache (pull/77).
      await db
        .update(cli_sessions_v2)
        .set({
          platform: 'github',
          pr_url: 'https://github.com/kilo/repo/pull/999',
          pr_number: 999,
        })
        .where(eq(cli_sessions_v2.session_id, sessionWithPr));

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.list({});

      const row = result.cliSessions.find(s => s.session_id === sessionWithPr);

      expect(row?.associatedPr).toMatchObject({
        url: 'https://github.com/kilo/repo/pull/999',
        number: 999,
        state: 'unknown',
        title: null,
        headSha: null,
        reviewDecision: null,
        reviewDecisionPending: false,
        platform: 'github',
      });
    });

    it('search returns the session partial (not the other cache PR) when the stored link disagrees', async () => {
      await db
        .update(cli_sessions_v2)
        .set({
          platform: 'github',
          pr_url: 'https://github.com/kilo/repo/pull/999',
          pr_number: 999,
        })
        .where(eq(cli_sessions_v2.session_id, sessionWithPr));

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.search({
        search_string: 'session',
      });

      const row = result.results.find(s => s.session_id === sessionWithPr);

      expect(row?.associatedPr).toMatchObject({
        url: 'https://github.com/kilo/repo/pull/999',
        number: 999,
        state: 'unknown',
        reviewDecisionPending: false,
        platform: 'github',
      });
    });

    it('list row count does not increase when two cache rows share a PR URL', async () => {
      // Two sessions on different branches whose cache rows point at the same
      // PR URL. The JOIN is on (git_url, git_branch, tenant), not pr_url, so
      // each session must appear exactly once (no fan-out).
      const sharedPrUrl = 'https://github.com/kilo/repo/pull/77';
      const secondSessionId = 'ses_list_pr_shared_url_5678';
      const secondBranch = 'feature/list-b';

      await db.insert(cli_sessions_v2).values({
        session_id: secondSessionId,
        kilo_user_id: regularUser.id,
        created_on_platform: 'cloud-agent',
        git_url: CACHE_GIT_URL,
        git_branch: secondBranch,
        title: 'second session shared PR',
      });
      await db.insert(github_branch_pull_requests).values({
        git_url: CACHE_GIT_URL,
        git_branch: secondBranch,
        owned_by_user_id: regularUser.id,
        pr_url: sharedPrUrl,
        pr_number: 77,
        pr_state: 'open',
        pr_title: 'List endpoint feature',
        pr_head_sha: 'cafef00d',
      });

      try {
        const caller = await createCallerForUser(regularUser.id);
        const result = await caller.cliSessionsV2.list({});

        const ids = result.cliSessions.map(s => s.session_id);
        expect(ids.filter(id => id === sessionWithPr)).toHaveLength(1);
        expect(ids.filter(id => id === secondSessionId)).toHaveLength(1);
      } finally {
        await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, secondSessionId));
      }
    });

    it('search row count does not increase when two cache rows share a PR URL', async () => {
      // Same fan-out guard as the list case: the JOIN is on (git_url,
      // git_branch, tenant), not pr_url, so each session must appear exactly
      // once in search results even when both cache rows point at one PR URL.
      const sharedPrUrl = 'https://github.com/kilo/repo/pull/77';
      const secondSessionId = 'ses_search_pr_shared_url_5678';
      const secondBranch = 'feature/list-c';

      await db.insert(cli_sessions_v2).values({
        session_id: secondSessionId,
        kilo_user_id: regularUser.id,
        created_on_platform: 'cloud-agent',
        git_url: CACHE_GIT_URL,
        git_branch: secondBranch,
        title: 'second session shared PR',
      });
      await db.insert(github_branch_pull_requests).values({
        git_url: CACHE_GIT_URL,
        git_branch: secondBranch,
        owned_by_user_id: regularUser.id,
        pr_url: sharedPrUrl,
        pr_number: 77,
        pr_state: 'open',
        pr_title: 'List endpoint feature',
        pr_head_sha: 'cafef00d',
      });

      try {
        const caller = await createCallerForUser(regularUser.id);
        const result = await caller.cliSessionsV2.search({ search_string: 'session' });

        const ids = result.results.map(s => s.session_id);
        expect(ids.filter(id => id === sessionWithPr)).toHaveLength(1);
        expect(ids.filter(id => id === secondSessionId)).toHaveLength(1);
      } finally {
        await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, secondSessionId));
      }
    });
  });

  describe('refreshAssociatedPullRequest', () => {
    const sessionId = 'ses_refresh_pr_1234';
    // Session git_url is stored in the canonical normalized shape that the
    // queue-consumer would persist for a new session, so the tenant-scoped
    // cache JOIN can match.
    const SESSION_GIT_URL = 'https://github.com/kilo/repo';
    const SESSION_BRANCH = 'feature/z';
    // The session's stored PR link, set by the CLI when it links a PR.
    const SESSION_PR_URL = 'https://github.com/kilo/repo/pull/7';
    const SESSION_PR_NUMBER = 7;
    let integrationId: string;

    async function readCacheRows(opts: { orgId?: string | null } = {}) {
      const tenantClause = opts.orgId
        ? eq(github_branch_pull_requests.owned_by_organization_id, opts.orgId)
        : eq(github_branch_pull_requests.owned_by_user_id, regularUser.id);
      return db
        .select()
        .from(github_branch_pull_requests)
        .where(
          and(
            eq(github_branch_pull_requests.git_url, SESSION_GIT_URL),
            eq(github_branch_pull_requests.git_branch, SESSION_BRANCH),
            tenantClause
          )
        );
    }

    beforeEach(async () => {
      await db.insert(cli_sessions_v2).values({
        session_id: sessionId,
        kilo_user_id: regularUser.id,
        created_on_platform: 'cloud-agent',
        git_url: SESSION_GIT_URL,
        git_branch: SESSION_BRANCH,
        platform: 'github',
        pr_url: SESSION_PR_URL,
        pr_number: SESSION_PR_NUMBER,
      });

      const [integration] = await db
        .insert(platform_integrations)
        .values({
          owned_by_user_id: regularUser.id,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: '12345',
          github_app_type: 'standard',
          integration_status: 'active',
        })
        .returning({ id: platform_integrations.id });
      integrationId = integration.id;

      mockedFetchPullRequestByNumber.mockReset();
    });

    afterEach(async () => {
      // Clean up cache rows under both possible tenants (some tests switch
      // the session's organization_id mid-test).
      await db
        .delete(github_branch_pull_requests)
        .where(
          and(
            eq(github_branch_pull_requests.git_url, SESSION_GIT_URL),
            eq(github_branch_pull_requests.git_branch, SESSION_BRANCH)
          )
        );
      await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, sessionId));
      await db.delete(platform_integrations).where(eq(platform_integrations.id, integrationId));
    });

    it('upserts when GitHub returns the stored-link PR', async () => {
      mockedFetchPullRequestByNumber.mockResolvedValue({
        number: 7,
        htmlUrl: SESSION_PR_URL,
        state: 'open',
        title: 'Feature Z',
        headSha: 'abc123',
        updatedAt: '2026-01-01T00:00:00Z',
      });

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.refreshAssociatedPullRequest({
        sessionId,
      });

      expect(mockedFetchPullRequestByNumber).toHaveBeenCalledTimes(1);
      expect(mockedFetchPullRequestByNumber).toHaveBeenCalledWith({
        installationId: 12345,
        owner: 'kilo',
        repo: 'repo',
        number: 7,
        appType: 'standard',
      });
      expect(result.associatedPr).toMatchObject({
        url: SESSION_PR_URL,
        number: 7,
        state: 'open',
        title: 'Feature Z',
        headSha: 'abc123',
        platform: 'github',
      });

      const [persisted] = await readCacheRows();
      expect(persisted).toMatchObject({
        git_url: SESSION_GIT_URL,
        git_branch: SESSION_BRANCH,
        owned_by_user_id: regularUser.id,
        owned_by_organization_id: null,
        pr_url: SESSION_PR_URL,
        pr_number: 7,
        pr_state: 'open',
      });
    });

    it('writes one cache row per (url, branch, tenant) across repeated refreshes', async () => {
      mockedFetchPullRequestByNumber.mockResolvedValue({
        number: 7,
        htmlUrl: SESSION_PR_URL,
        state: 'open',
        title: 'x',
        headSha: 's1',
        updatedAt: '2026-01-01T00:00:00Z',
      });

      const caller = await createCallerForUser(regularUser.id);
      await caller.cliSessionsV2.refreshAssociatedPullRequest({ sessionId });

      // Move pr_last_synced_at back so the throttle releases, then refresh again.
      await db
        .update(github_branch_pull_requests)
        .set({ pr_last_synced_at: new Date(Date.now() - 90_000).toISOString() })
        .where(
          and(
            eq(github_branch_pull_requests.git_url, SESSION_GIT_URL),
            eq(github_branch_pull_requests.git_branch, SESSION_BRANCH),
            eq(github_branch_pull_requests.owned_by_user_id, regularUser.id)
          )
        );

      mockedFetchPullRequestByNumber.mockResolvedValue({
        number: 7,
        htmlUrl: SESSION_PR_URL,
        state: 'open',
        title: 'x',
        headSha: 's2',
        updatedAt: '2026-01-01T00:00:00Z',
      });
      await caller.cliSessionsV2.refreshAssociatedPullRequest({ sessionId });

      const rows = await readCacheRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].pr_head_sha).toBe('s2');
    });

    it('does not overwrite a different branch-cache PR when refreshing by number', async () => {
      // Branch cache holds a DIFFERENT PR than the session's stored link.
      await db.insert(github_branch_pull_requests).values({
        git_url: SESSION_GIT_URL,
        git_branch: SESSION_BRANCH,
        owned_by_user_id: regularUser.id,
        pr_url: 'https://github.com/kilo/repo/pull/99',
        pr_number: 99,
        pr_state: 'open',
        pr_title: 'other PR',
        pr_head_sha: 'other-sha',
        pr_last_synced_at: new Date(Date.now() - 90_000).toISOString(),
      });

      mockedFetchPullRequestByNumber.mockResolvedValue({
        number: 7,
        htmlUrl: SESSION_PR_URL,
        state: 'open',
        title: 'Feature Z',
        headSha: 'abc123',
        updatedAt: '2026-01-01T00:00:00Z',
      });

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.refreshAssociatedPullRequest({
        sessionId,
      });

      // Fetched the session's own PR by number...
      expect(mockedFetchPullRequestByNumber).toHaveBeenCalledWith({
        installationId: 12345,
        owner: 'kilo',
        repo: 'repo',
        number: 7,
        appType: 'standard',
      });
      // ...and returned it for this session only.
      expect(result.associatedPr).toMatchObject({
        url: SESSION_PR_URL,
        number: 7,
        state: 'open',
      });

      // The branch cache row for the other PR is untouched.
      const rows = await readCacheRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        pr_url: 'https://github.com/kilo/repo/pull/99',
        pr_number: 99,
      });
    });

    it('returns the pending partial for a non-GitHub session without calling GitHub', async () => {
      await db
        .update(cli_sessions_v2)
        .set({ platform: 'gitlab' })
        .where(eq(cli_sessions_v2.session_id, sessionId));

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.refreshAssociatedPullRequest({
        sessionId,
      });

      expect(mockedFetchPullRequestByNumber).not.toHaveBeenCalled();
      expect(result.associatedPr).toMatchObject({
        state: 'unknown',
        title: null,
        headSha: null,
        reviewDecision: null,
        reviewDecisionPending: true,
        platform: 'gitlab',
      });
    });

    it('fetches by number but does not write the cache when git_url/git_branch are missing', async () => {
      await db
        .update(cli_sessions_v2)
        .set({ git_url: null, git_branch: null })
        .where(eq(cli_sessions_v2.session_id, sessionId));

      mockedFetchPullRequestByNumber.mockResolvedValue({
        number: 7,
        htmlUrl: SESSION_PR_URL,
        state: 'open',
        title: 'Feature Z',
        headSha: 'abc123',
        updatedAt: '2026-01-01T00:00:00Z',
      });

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.refreshAssociatedPullRequest({
        sessionId,
      });

      // Fetch-by-number still runs (pr_url parses)...
      expect(mockedFetchPullRequestByNumber).toHaveBeenCalledTimes(1);
      // ...returns the fetched payload for this session only...
      expect(result.associatedPr).toMatchObject({
        url: SESSION_PR_URL,
        number: 7,
        state: 'open',
        platform: 'github',
      });
      // ...with reviewDecisionPending false: no cache row is written on this
      // path, so no batch worker can ever clear a pending flag.
      expect(result.associatedPr?.reviewDecisionPending).toBe(false);
      // ...and writes no cache row (no branch identity).
      const rows = await readCacheRows();
      expect(rows).toHaveLength(0);
    });

    it('short-circuits on the recent-sync throttle when the cache matches the stored link', async () => {
      await db.insert(github_branch_pull_requests).values({
        git_url: SESSION_GIT_URL,
        git_branch: SESSION_BRANCH,
        owned_by_user_id: regularUser.id,
        pr_url: SESSION_PR_URL,
        pr_number: 7,
        pr_state: 'open',
        pr_title: 'recent',
        pr_head_sha: 'fresh',
      });

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.refreshAssociatedPullRequest({
        sessionId,
      });

      expect(mockedFetchPullRequestByNumber).not.toHaveBeenCalled();
      expect(result.associatedPr).toMatchObject({ number: 7, state: 'open' });
    });

    it('updates the matching cache row when the stored link has a trailing subpath', async () => {
      // Cache row holds the same PR (canonical URL) with stale fields.
      await db.insert(github_branch_pull_requests).values({
        git_url: SESSION_GIT_URL,
        git_branch: SESSION_BRANCH,
        owned_by_user_id: regularUser.id,
        pr_url: SESSION_PR_URL,
        pr_number: 7,
        pr_state: 'open',
        pr_title: 'stale',
        pr_head_sha: 'old-sha',
        pr_last_synced_at: new Date(Date.now() - 90_000).toISOString(),
      });

      // Session stores a subpath link that names the same PR.
      await db
        .update(cli_sessions_v2)
        .set({ pr_url: 'https://github.com/kilo/repo/pull/7/files' })
        .where(eq(cli_sessions_v2.session_id, sessionId));

      mockedFetchPullRequestByNumber.mockResolvedValue({
        number: 7,
        htmlUrl: SESSION_PR_URL,
        state: 'open',
        title: 'Feature Z',
        headSha: 'new-sha',
        updatedAt: '2026-01-01T00:00:00Z',
      });

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.refreshAssociatedPullRequest({
        sessionId,
      });

      expect(result.associatedPr).toMatchObject({ number: 7, state: 'open' });

      // The write guard treated the subpath link as the same PR and updated the
      // existing row in place — no duplicate row and no stale fields.
      const rows = await readCacheRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        pr_url: SESSION_PR_URL,
        pr_number: 7,
        pr_head_sha: 'new-sha',
      });
    });

    it('maps GitHubRateLimitError to TOO_MANY_REQUESTS', async () => {
      const resetAt = new Date('2099-01-01T00:00:00Z');
      mockedFetchPullRequestByNumber.mockRejectedValue(
        new githubAdapter.GitHubRateLimitError(resetAt)
      );

      const caller = await createCallerForUser(regularUser.id);
      await expect(
        caller.cliSessionsV2.refreshAssociatedPullRequest({ sessionId })
      ).rejects.toMatchObject({
        code: 'TOO_MANY_REQUESTS',
      });
    });

    it('throws NOT_FOUND when the session belongs to a different user', async () => {
      const caller = await createCallerForUser(otherUser.id);
      await expect(
        caller.cliSessionsV2.refreshAssociatedPullRequest({ sessionId })
      ).rejects.toThrow('Session not found');
      expect(mockedFetchPullRequestByNumber).not.toHaveBeenCalled();
    });

    it('rejects org-scoped refreshes for a user who is not a current org member', async () => {
      const [otherOrg] = await db
        .insert(organizations)
        .values({
          name: 'Refresh PR Org Access Test',
          created_by_kilo_user_id: regularUser.id,
        })
        .returning();

      // Session row ties regularUser to the org even though they have no
      // membership row — simulates stale access after org removal.
      await db
        .update(cli_sessions_v2)
        .set({ organization_id: otherOrg.id })
        .where(eq(cli_sessions_v2.session_id, sessionId));

      try {
        const caller = await createCallerForUser(regularUser.id);
        await expect(
          caller.cliSessionsV2.refreshAssociatedPullRequest({ sessionId })
        ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        expect(mockedFetchPullRequestByNumber).not.toHaveBeenCalled();
      } finally {
        await db
          .update(cli_sessions_v2)
          .set({ organization_id: null })
          .where(eq(cli_sessions_v2.session_id, sessionId));
        await db.delete(organizations).where(eq(organizations.id, otherOrg.id));
      }
    });

    it('rejects org-scoped refreshes for a non-member even when the PR row is fresh enough to hit the throttle', async () => {
      const [otherOrg] = await db
        .insert(organizations)
        .values({
          name: 'Refresh PR Throttle Bypass Test',
          created_by_kilo_user_id: regularUser.id,
        })
        .returning();

      await db
        .update(cli_sessions_v2)
        .set({ organization_id: otherOrg.id })
        .where(eq(cli_sessions_v2.session_id, sessionId));

      // Fresh sentinel row owned by the *org* that would normally short-circuit
      // via the throttle. Using owned_by_organization_id matches how the JOIN
      // would attach the PR to the now-org-scoped session.
      await db.insert(github_branch_pull_requests).values({
        git_url: SESSION_GIT_URL,
        git_branch: SESSION_BRANCH,
        owned_by_organization_id: otherOrg.id,
        pr_url: 'https://github.com/kilo/repo/pull/42',
        pr_number: 42,
        pr_state: 'open',
        pr_title: 'Should not leak',
        pr_head_sha: 'leaky-sha',
      });

      try {
        const caller = await createCallerForUser(regularUser.id);
        // Must throw UNAUTHORIZED — the throttle must not bypass the org
        // membership re-check, even when cached PR metadata is available.
        await expect(
          caller.cliSessionsV2.refreshAssociatedPullRequest({ sessionId })
        ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        expect(mockedFetchPullRequestByNumber).not.toHaveBeenCalled();
      } finally {
        await db
          .update(cli_sessions_v2)
          .set({ organization_id: null })
          .where(eq(cli_sessions_v2.session_id, sessionId));
        await db.delete(organizations).where(eq(organizations.id, otherOrg.id));
      }
    });
  });

  describe('search ordering', () => {
    const olderCreatedNewerUpdated = 'ses_search_sort_old_created';
    const newerCreatedOlderUpdated = 'ses_search_sort_new_created';
    const searchableTitle = 'mobile-search-sort-fixture';

    beforeEach(async () => {
      await db.insert(cli_sessions_v2).values([
        {
          session_id: olderCreatedNewerUpdated,
          kilo_user_id: regularUser.id,
          created_on_platform: 'cloud-agent',
          title: searchableTitle,
          created_at: '2026-01-01T10:00:00.000Z',
          updated_at: '2026-01-04T10:00:00.000Z',
        },
        {
          session_id: newerCreatedOlderUpdated,
          kilo_user_id: regularUser.id,
          created_on_platform: 'cloud-agent',
          title: searchableTitle,
          created_at: '2026-01-03T10:00:00.000Z',
          updated_at: '2026-01-02T10:00:00.000Z',
        },
      ]);
    });

    afterEach(async () => {
      await db
        .delete(cli_sessions_v2)
        .where(
          inArray(cli_sessions_v2.session_id, [olderCreatedNewerUpdated, newerCreatedOlderUpdated])
        );
    });

    it('defaults search to updated_at descending', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.search({
        search_string: searchableTitle,
      });

      expect(result.results.map(session => session.session_id)).toEqual([
        olderCreatedNewerUpdated,
        newerCreatedOlderUpdated,
      ]);
    });

    it('orders search by created_at descending when requested', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.search({
        search_string: searchableTitle,
        orderBy: 'created_at',
      });

      expect(result.results.map(session => session.session_id)).toEqual([
        newerCreatedOlderUpdated,
        olderCreatedNewerUpdated,
      ]);
    });
  });

  describe('search cursor paging', () => {
    const needle = 'cursor-paging-search-fixture';
    const sessionA = 'ses_cursor_paging_a_0001';
    const sessionB = 'ses_cursor_paging_b_0001';
    const sessionC = 'ses_cursor_paging_c_0001';
    const allIds = [sessionA, sessionB, sessionC];

    beforeEach(async () => {
      await db.insert(cli_sessions_v2).values([
        {
          session_id: sessionA,
          kilo_user_id: regularUser.id,
          created_on_platform: 'cloud-agent',
          title: `${needle} alpha`,
          updated_at: '2026-01-03T10:00:00.000Z',
        },
        {
          session_id: sessionB,
          kilo_user_id: regularUser.id,
          created_on_platform: 'cloud-agent',
          title: `${needle} beta`,
          updated_at: '2026-01-02T10:00:00.000Z',
        },
        {
          session_id: sessionC,
          kilo_user_id: regularUser.id,
          created_on_platform: 'cloud-agent',
          title: `${needle} gamma`,
          updated_at: '2026-01-01T10:00:00.000Z',
        },
      ]);
    });

    afterEach(async () => {
      await db.delete(cli_sessions_v2).where(inArray(cli_sessions_v2.session_id, allIds));
    });

    it('returns the first page with nextCursor pointing at the remaining rows', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.search({ search_string: needle, limit: 2 });

      expect(result.results).toHaveLength(2);
      expect(result.total).toBe(3);
      expect(result.offset).toBe(0);
      expect(result.nextCursor).toBe(2);
      // Default sort is updated_at descending.
      expect(result.results.map(s => s.session_id)).toEqual([sessionA, sessionB]);
    });

    it('returns the remaining row with nextCursor null on the cursor page', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const page1 = await caller.cliSessionsV2.search({ search_string: needle, limit: 2 });
      const page1Ids = new Set(page1.results.map(s => s.session_id));

      const page2 = await caller.cliSessionsV2.search({
        search_string: needle,
        limit: 2,
        cursor: 2,
      });

      expect(page2.results).toHaveLength(1);
      expect(page2.total).toBe(3);
      expect(page2.offset).toBe(2);
      expect(page2.nextCursor).toBeNull();
      expect(page1Ids.has(page2.results[0].session_id)).toBe(false);
      expect(page2.results[0].session_id).toBe(sessionC);
    });

    it('prefers cursor over legacy offset when both arrive', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.search({
        search_string: needle,
        limit: 2,
        cursor: 2,
        offset: 0,
      });

      expect(result.offset).toBe(2);
      expect(result.results).toHaveLength(1);
    });

    it('offsets from zero when only legacy offset is supplied', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.search({
        search_string: needle,
        limit: 2,
        offset: 0,
      });

      expect(result.results).toHaveLength(2);
      expect(result.total).toBe(3);
      expect(result.offset).toBe(0);
    });

    it('returns null nextCursor on an empty page even when nextOffset < total', () => {
      // Empty page: results.length === 0, nextOffset === pageOffset.
      // When pageOffset (2) < total (3), the naive formula
      //   nextOffset < total ? nextOffset : null
      // returns 2 — a non-null cursor that would cause an infinite loop.
      // The empty-results guard prevents this.
      const resultsLength = 0;
      const nextOffset = 2;
      const total = 3;

      const withGuard = computeSearchNextCursor(resultsLength, nextOffset, total);
      expect(withGuard).toBeNull();

      // Old formula:  nextOffset < total → truthy, returns nextOffset (wrong)
      // Empty guard:  resultsLength > 0 → false → null (correct)
      const oldFormula: number | null = nextOffset < total ? nextOffset : null;
      expect(oldFormula).toBe(nextOffset);
      expect(withGuard).not.toBe(oldFormula);
    });
  });

  describe('list / search hide never-ingested placeholders', () => {
    // Bare POST /api/session placeholders: title/status/cost NULL and platform
    // still at the column default 'unknown'. Content may still exist in DO/R2;
    // the four-column conjunction is only a list/search visibility predicate.
    const placeholderId = 'ses_hide_placeholder_bare_0001';
    const titledUnknownId = 'ses_hide_placeholder_titled_0001';
    const statusUnknownId = 'ses_hide_placeholder_status_0001';
    const costOnlyZeroId = 'ses_hide_placeholder_cost0_0001';
    const normalCliId = 'ses_hide_placeholder_cli_0001';
    const allSessionIds = [
      placeholderId,
      titledUnknownId,
      statusUnknownId,
      costOnlyZeroId,
      normalCliId,
    ];

    beforeEach(async () => {
      const baseTime = Date.parse('2026-06-01T12:00:00.000Z');
      await db.insert(cli_sessions_v2).values([
        {
          session_id: placeholderId,
          kilo_user_id: regularUser.id,
          // defaults: created_on_platform 'unknown', title/status/cost NULL
          created_at: new Date(baseTime).toISOString(),
          updated_at: new Date(baseTime).toISOString(),
        },
        {
          session_id: titledUnknownId,
          kilo_user_id: regularUser.id,
          created_on_platform: 'unknown',
          title: 'titled but still unknown platform',
          created_at: new Date(baseTime + 1000).toISOString(),
          updated_at: new Date(baseTime + 1000).toISOString(),
        },
        {
          session_id: statusUnknownId,
          kilo_user_id: regularUser.id,
          created_on_platform: 'unknown',
          status: 'running',
          created_at: new Date(baseTime + 2000).toISOString(),
          updated_at: new Date(baseTime + 2000).toISOString(),
        },
        {
          session_id: costOnlyZeroId,
          kilo_user_id: regularUser.id,
          created_on_platform: 'unknown',
          // Metrics emission can persist 0 (writer clamps with Math.max(0, …))
          // while no metadata projection ever succeeded.
          total_cost_microdollars: 0,
          created_at: new Date(baseTime + 3000).toISOString(),
          updated_at: new Date(baseTime + 3000).toISOString(),
        },
        {
          session_id: normalCliId,
          kilo_user_id: regularUser.id,
          created_on_platform: 'cli',
          title: 'normal cli session',
          status: 'completed',
          created_at: new Date(baseTime + 4000).toISOString(),
          updated_at: new Date(baseTime + 4000).toISOString(),
        },
      ]);
    });

    afterEach(async () => {
      await db.delete(cli_sessions_v2).where(inArray(cli_sessions_v2.session_id, allSessionIds));
    });

    it('list omits bare placeholder rows', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.list({});
      const ids = result.cliSessions.map(session => session.session_id);

      expect(ids).not.toContain(placeholderId);
    });

    it('list returns a row with a title even when platform is still unknown', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.list({});
      const ids = result.cliSessions.map(session => session.session_id);

      expect(ids).toContain(titledUnknownId);
    });

    it('list returns a row with a status even when title is null and platform is unknown', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.list({});
      const ids = result.cliSessions.map(session => session.session_id);

      expect(ids).toContain(statusUnknownId);
    });

    it('list returns a row with only total_cost_microdollars set (including zero)', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.list({});
      const ids = result.cliSessions.map(session => session.session_id);

      expect(ids).toContain(costOnlyZeroId);
      const costOnly = result.cliSessions.find(session => session.session_id === costOnlyZeroId);
      expect(costOnly?.total_cost_microdollars).toBe(0);
    });

    it('list returns a normal cli session and keeps pagination stable with placeholders interleaved', async () => {
      const caller = await createCallerForUser(regularUser.id);
      // Fixtures are ordered by created_at; placeholders sit between visible
      // rows. limit=2 over created_at should page only visible rows.
      const page1 = await caller.cliSessionsV2.list({
        limit: 2,
        orderBy: 'created_at',
      });
      const page1Ids = page1.cliSessions.map(session => session.session_id);

      expect(page1Ids).toEqual([normalCliId, costOnlyZeroId]);
      expect(page1Ids).not.toContain(placeholderId);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await caller.cliSessionsV2.list({
        limit: 2,
        orderBy: 'created_at',
        cursor: page1.nextCursor!,
      });
      const page2Ids = page2.cliSessions.map(session => session.session_id);

      expect(page2Ids).toEqual([statusUnknownId, titledUnknownId]);
      expect(page2Ids).not.toContain(placeholderId);
    });

    it('search by exact session_id does not return a bare placeholder', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.search({
        search_string: placeholderId,
      });

      expect(result.results.map(session => session.session_id)).not.toContain(placeholderId);
      expect(result.total).toBe(0);
    });
  });

  describe('rename CLI notify', () => {
    const sessionId = 'ses_rename_notify_test_abc12';

    beforeEach(async () => {
      await db.insert(cli_sessions_v2).values({
        session_id: sessionId,
        kilo_user_id: regularUser.id,
        created_on_platform: 'cli',
        title: 'original title',
      });
    });

    afterEach(async () => {
      await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, sessionId));
    });

    it('notifies session-ingest with the renamed sessionId, title, and user after success', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.rename({
        session_id: sessionId,
        title: 'web renamed title',
      });

      expect(result).toEqual({ title: 'web renamed title' });
      expect(mockedNotifyCliSessionRenamed).not.toHaveBeenCalled();

      await flushAfterCallbacks();

      expect(mockedNotifyCliSessionRenamed).toHaveBeenCalledTimes(1);
      expect(mockedNotifyCliSessionRenamed).toHaveBeenCalledWith({
        sessionId,
        title: 'web renamed title',
        userId: regularUser.id,
      });
    });

    it('still returns the renamed title when the CLI notify helper fails', async () => {
      const notifyError = new Error('ingest unavailable');
      mockedNotifyCliSessionRenamed.mockRejectedValue(notifyError);

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.rename({
        session_id: sessionId,
        title: 'still renamed',
      });

      expect(result).toEqual({ title: 'still renamed' });

      await flushAfterCallbacks();

      expect(mockedNotifyCliSessionRenamed).toHaveBeenCalledWith({
        sessionId,
        title: 'still renamed',
        userId: regularUser.id,
      });
      expect(mockedCaptureException).toHaveBeenCalledWith(
        notifyError,
        expect.objectContaining({
          tags: { source: 'cli-sessions-v2-router', endpoint: 'rename-notify' },
          extra: { sessionId },
        })
      );

      const [persisted] = await db
        .select({ title: cli_sessions_v2.title })
        .from(cli_sessions_v2)
        .where(eq(cli_sessions_v2.session_id, sessionId));
      expect(persisted?.title).toBe('still renamed');
    });

    it('does not notify when the session is not found', async () => {
      const caller = await createCallerForUser(regularUser.id);

      await expect(
        caller.cliSessionsV2.rename({
          session_id: 'ses_does_not_exist_zzzzzz',
          title: 'nope',
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      await flushAfterCallbacks();
      expect(mockedNotifyCliSessionRenamed).not.toHaveBeenCalled();
    });
  });
});
