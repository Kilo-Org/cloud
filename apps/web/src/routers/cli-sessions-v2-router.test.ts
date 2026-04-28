import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { db } from '@/lib/drizzle';
import {
  cloud_agent_webhook_triggers,
  cli_sessions_v2,
  cli_session_pull_requests,
  agent_environment_profiles,
  organizations,
  organization_memberships,
  platform_integrations,
} from '@kilocode/db/schema';
import { eq, and } from 'drizzle-orm';
import type { User, Organization } from '@kilocode/db/schema';
import {
  fetchPullRequestForBranch,
  GitHubRateLimitError,
} from '@/lib/integrations/platforms/github/adapter';

jest.mock('@/lib/config.server', () => {
  const actual: Record<string, unknown> = jest.requireActual('@/lib/config.server');
  return {
    ...actual,
    SESSION_INGEST_WORKER_URL: 'https://test-ingest.example.com',
  };
});

// The cloud-agent-next client is called from getWithRuntimeState whenever the
// session has a cloud_agent_session_id. Our refresh-PR tests don't set one, so
// this mock is only a safety net (never exercised in the new tests).
jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: jest.fn(() => ({
    getSession: jest.fn().mockResolvedValue(null),
  })),
}));

const mockFetchPullRequestForBranch = fetchPullRequestForBranch as jest.MockedFunction<
  typeof fetchPullRequestForBranch
>;

let regularUser: User;
let otherUser: User;
let testOrganization: Organization;

describe('cli-sessions-v2-router', () => {
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

    const [org] = await db
      .insert(organizations)
      .values({
        name: 'CLI Sessions V2 Test Org',
        created_by_kilo_user_id: regularUser.id,
      })
      .returning();
    testOrganization = org;
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

  describe('getWithRuntimeState — associatedPr', () => {
    const sessionId = 'ses_test_assoc_pr_get_1';

    beforeEach(async () => {
      await db.insert(cli_sessions_v2).values({
        session_id: sessionId,
        kilo_user_id: regularUser.id,
        created_on_platform: 'cloud-agent-web',
        git_url: 'https://github.com/acme/widgets',
        git_branch: 'main',
      });
    });

    afterEach(async () => {
      await db
        .delete(cli_session_pull_requests)
        .where(eq(cli_session_pull_requests.session_id, sessionId));
      await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, sessionId));
    });

    it('returns associatedPr=null when no row exists in the side table', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessionsV2.getWithRuntimeState({ session_id: sessionId });

      expect(result.associatedPr).toBeNull();
    });

    it('includes associatedPr when a row exists in the side table', async () => {
      await db.insert(cli_session_pull_requests).values({
        session_id: sessionId,
        pr_url: 'https://github.com/acme/widgets/pull/42',
        pr_number: 42,
        pr_state: 'open',
        pr_title: 'Add login page',
        pr_head_sha: 'abc123',
      });

      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessionsV2.getWithRuntimeState({ session_id: sessionId });

      expect(result.associatedPr).toMatchObject({
        url: 'https://github.com/acme/widgets/pull/42',
        number: 42,
        state: 'open',
        title: 'Add login page',
        headSha: 'abc123',
      });
      expect(typeof result.associatedPr?.lastSyncedAt).toBe('string');
      expect(() => new Date(result.associatedPr!.lastSyncedAt).toISOString()).not.toThrow();
    });
  });

  describe('refreshAssociatedPullRequest', () => {
    const sessionId = 'ses_test_assoc_pr_refresh_1';
    let integrationId: string;

    beforeEach(async () => {
      mockFetchPullRequestForBranch.mockReset();
      mockFetchPullRequestForBranch.mockResolvedValue(null);

      const [integration] = await db
        .insert(platform_integrations)
        .values({
          owned_by_user_id: regularUser.id,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: '98765',
          github_app_type: 'standard',
        })
        .returning({ id: platform_integrations.id });
      integrationId = integration.id;

      await db.insert(cli_sessions_v2).values({
        session_id: sessionId,
        kilo_user_id: regularUser.id,
        created_on_platform: 'cloud-agent-web',
        git_url: 'https://github.com/acme/widgets',
        git_branch: 'feature/login',
      });
    });

    afterEach(async () => {
      await db
        .delete(cli_session_pull_requests)
        .where(eq(cli_session_pull_requests.session_id, sessionId));
      await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, sessionId));
      await db.delete(platform_integrations).where(eq(platform_integrations.id, integrationId));
    });

    it('upserts the PR row when GitHub returns a pull request', async () => {
      mockFetchPullRequestForBranch.mockResolvedValue({
        number: 42,
        htmlUrl: 'https://github.com/acme/widgets/pull/42',
        state: 'open',
        title: 'Add login page',
        headSha: 'abc123',
        updatedAt: '2026-04-20T10:00:00Z',
      });

      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessionsV2.refreshAssociatedPullRequest({ sessionId });

      expect(result.associatedPr).toMatchObject({
        url: 'https://github.com/acme/widgets/pull/42',
        number: 42,
        state: 'open',
        title: 'Add login page',
        headSha: 'abc123',
      });

      const [stored] = await db
        .select()
        .from(cli_session_pull_requests)
        .where(eq(cli_session_pull_requests.session_id, sessionId))
        .limit(1);
      expect(stored?.pr_number).toBe(42);
      expect(stored?.pr_state).toBe('open');
      expect(stored?.pr_head_sha).toBe('abc123');
    });

    it('deletes the PR row when GitHub reports no associated pull request', async () => {
      // Seed an existing row that we expect to be deleted.
      await db.insert(cli_session_pull_requests).values({
        session_id: sessionId,
        pr_url: 'https://github.com/acme/widgets/pull/7',
        pr_number: 7,
        pr_state: 'open',
        pr_title: 'Old PR',
        pr_head_sha: 'oldsha',
        // Force last_synced_at far in the past so the 10s throttle doesn't kick in.
        pr_last_synced_at: new Date(Date.now() - 60_000).toISOString(),
      });

      mockFetchPullRequestForBranch.mockResolvedValue(null);

      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessionsV2.refreshAssociatedPullRequest({ sessionId });

      expect(result.associatedPr).toBeNull();
      const remaining = await db
        .select()
        .from(cli_session_pull_requests)
        .where(eq(cli_session_pull_requests.session_id, sessionId));
      expect(remaining).toHaveLength(0);
    });

    it('short-circuits and does not call GitHub when last sync is within 10 seconds', async () => {
      await db.insert(cli_session_pull_requests).values({
        session_id: sessionId,
        pr_url: 'https://github.com/acme/widgets/pull/7',
        pr_number: 7,
        pr_state: 'open',
        pr_title: 'Recent PR',
        pr_head_sha: 'recentsha',
        pr_last_synced_at: new Date().toISOString(),
      });

      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessionsV2.refreshAssociatedPullRequest({ sessionId });

      expect(result.associatedPr).toMatchObject({
        number: 7,
        title: 'Recent PR',
        headSha: 'recentsha',
      });
      expect(mockFetchPullRequestForBranch).not.toHaveBeenCalled();
    });

    it('throws NOT_FOUND when the session belongs to a different user', async () => {
      const caller = await createCallerForUser(otherUser.id);

      await expect(
        caller.cliSessionsV2.refreshAssociatedPullRequest({ sessionId })
      ).rejects.toThrow('Session not found');
      expect(mockFetchPullRequestForBranch).not.toHaveBeenCalled();
    });

    it('surfaces rate-limit errors as TOO_MANY_REQUESTS', async () => {
      const resetAt = new Date('2030-01-01T00:00:00Z');
      mockFetchPullRequestForBranch.mockRejectedValue(new GitHubRateLimitError(resetAt));

      const caller = await createCallerForUser(regularUser.id);

      await expect(
        caller.cliSessionsV2.refreshAssociatedPullRequest({ sessionId })
      ).rejects.toMatchObject({
        code: 'TOO_MANY_REQUESTS',
      });
    });

    it('throws BAD_REQUEST when the session has no git_url/git_branch', async () => {
      await db
        .update(cli_sessions_v2)
        .set({ git_url: null, git_branch: null })
        .where(eq(cli_sessions_v2.session_id, sessionId));

      const caller = await createCallerForUser(regularUser.id);

      await expect(
        caller.cliSessionsV2.refreshAssociatedPullRequest({ sessionId })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(mockFetchPullRequestForBranch).not.toHaveBeenCalled();
    });

    it('throws BAD_REQUEST when the session git_url is not a GitHub URL', async () => {
      await db
        .update(cli_sessions_v2)
        .set({ git_url: 'https://gitlab.com/acme/widgets' })
        .where(eq(cli_sessions_v2.session_id, sessionId));

      const caller = await createCallerForUser(regularUser.id);

      await expect(
        caller.cliSessionsV2.refreshAssociatedPullRequest({ sessionId })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(mockFetchPullRequestForBranch).not.toHaveBeenCalled();
    });
  });
});
