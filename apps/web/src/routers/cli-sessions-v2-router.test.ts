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
import * as githubAdapter from '@/lib/integrations/platforms/github/adapter';
import { parseGitHubOwnerRepo } from '@/routers/cli-sessions-v2-router';

jest.mock('@/lib/config.server', () => {
  const actual: Record<string, unknown> = jest.requireActual('@/lib/config.server');
  return {
    ...actual,
    SESSION_INGEST_WORKER_URL: 'https://test-ingest.example.com',
  };
});

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

  describe('getWithRuntimeState associatedPr', () => {
    const sessionWithPr = 'ses_assoc_pr_present_1234';
    const sessionWithoutPr = 'ses_assoc_pr_absent_1234';

    beforeEach(async () => {
      await db.insert(cli_sessions_v2).values([
        {
          session_id: sessionWithPr,
          kilo_user_id: regularUser.id,
          created_on_platform: 'cloud-agent',
          git_url: 'https://github.com/kilo/repo',
          git_branch: 'feature/x',
        },
        {
          session_id: sessionWithoutPr,
          kilo_user_id: regularUser.id,
          created_on_platform: 'cloud-agent',
          git_url: 'https://github.com/kilo/repo',
          git_branch: 'feature/y',
        },
      ]);
      await db.insert(cli_session_pull_requests).values({
        session_id: sessionWithPr,
        pr_url: 'https://github.com/kilo/repo/pull/42',
        pr_number: 42,
        pr_state: 'open',
        pr_title: 'Add feature X',
        pr_head_sha: 'deadbeefcafe',
      });
    });

    afterEach(async () => {
      await db
        .delete(cli_session_pull_requests)
        .where(eq(cli_session_pull_requests.session_id, sessionWithPr));
      await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, sessionWithPr));
      await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, sessionWithoutPr));
    });

    it('returns associatedPr when the side table has a row', async () => {
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

    it('returns null associatedPr when the side table has no row', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.getWithRuntimeState({
        session_id: sessionWithoutPr,
      });
      expect(result.associatedPr).toBeNull();
    });

    it('throws NOT_FOUND when the session is owned by another user', async () => {
      const caller = await createCallerForUser(otherUser.id);
      await expect(
        caller.cliSessionsV2.getWithRuntimeState({ session_id: sessionWithPr })
      ).rejects.toThrow('Session not found');
    });
  });

  describe('refreshAssociatedPullRequest', () => {
    const sessionId = 'ses_refresh_pr_1234';
    let integrationId: string;
    let fetchSpy: jest.SpyInstance;

    beforeEach(async () => {
      await db.insert(cli_sessions_v2).values({
        session_id: sessionId,
        kilo_user_id: regularUser.id,
        created_on_platform: 'cloud-agent',
        git_url: 'https://github.com/kilo/repo.git',
        git_branch: 'feature/z',
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

      fetchSpy = jest.spyOn(githubAdapter, 'fetchPullRequestForBranch');
    });

    afterEach(async () => {
      fetchSpy.mockRestore();
      await db
        .delete(cli_session_pull_requests)
        .where(eq(cli_session_pull_requests.session_id, sessionId));
      await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, sessionId));
      await db.delete(platform_integrations).where(eq(platform_integrations.id, integrationId));
    });

    it('upserts when GitHub returns a PR', async () => {
      fetchSpy.mockResolvedValue({
        number: 7,
        htmlUrl: 'https://github.com/kilo/repo/pull/7',
        state: 'open',
        title: 'Feature Z',
        headSha: 'abc123',
        updatedAt: '2026-01-01T00:00:00Z',
      });

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.refreshAssociatedPullRequest({ sessionId });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith({
        installationId: 12345,
        owner: 'kilo',
        repo: 'repo',
        branch: 'feature/z',
        appType: 'standard',
      });
      expect(result.associatedPr).toMatchObject({
        url: 'https://github.com/kilo/repo/pull/7',
        number: 7,
        state: 'open',
        title: 'Feature Z',
        headSha: 'abc123',
      });

      const [persisted] = await db
        .select()
        .from(cli_session_pull_requests)
        .where(eq(cli_session_pull_requests.session_id, sessionId));
      expect(persisted).toMatchObject({
        pr_url: 'https://github.com/kilo/repo/pull/7',
        pr_number: 7,
        pr_state: 'open',
      });
    });

    it('clears the PR data when GitHub returns null while retaining a sentinel row for throttling', async () => {
      await db.insert(cli_session_pull_requests).values({
        session_id: sessionId,
        pr_url: 'https://github.com/kilo/repo/pull/1',
        pr_number: 1,
        pr_state: 'open',
        pr_title: 'stale',
        pr_head_sha: 'old',
        // Make the stored row old so the throttle does not kick in.
        pr_last_synced_at: new Date(Date.now() - 60_000).toISOString(),
      });
      fetchSpy.mockResolvedValue(null);

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.refreshAssociatedPullRequest({ sessionId });

      expect(result.associatedPr).toBeNull();
      const rows = await db
        .select()
        .from(cli_session_pull_requests)
        .where(eq(cli_session_pull_requests.session_id, sessionId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        pr_url: null,
        pr_number: null,
        pr_state: null,
        pr_title: null,
        pr_head_sha: null,
      });
      // Sentinel row's pr_last_synced_at is fresh, so the next refresh would
      // short-circuit on the throttle.
      const syncedMs = Date.parse(rows[0].pr_last_synced_at);
      expect(Date.now() - syncedMs).toBeLessThan(5_000);
    });

    it('throttles repeated refreshes even when there is no PR for the branch', async () => {
      fetchSpy.mockResolvedValue(null);

      const caller = await createCallerForUser(regularUser.id);
      // First call persists a sentinel row with fresh pr_last_synced_at.
      await caller.cliSessionsV2.refreshAssociatedPullRequest({ sessionId });
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Second call within the throttle window short-circuits.
      const second = await caller.cliSessionsV2.refreshAssociatedPullRequest({ sessionId });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(second.associatedPr).toBeNull();
    });

    it('short-circuits on the 10-second throttle without calling GitHub', async () => {
      await db.insert(cli_session_pull_requests).values({
        session_id: sessionId,
        pr_url: 'https://github.com/kilo/repo/pull/99',
        pr_number: 99,
        pr_state: 'open',
        pr_title: 'recent',
        pr_head_sha: 'fresh',
      });

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.refreshAssociatedPullRequest({ sessionId });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.associatedPr).toMatchObject({ number: 99, state: 'open' });
    });

    it('maps GitHubRateLimitError to TOO_MANY_REQUESTS', async () => {
      const resetAt = new Date('2099-01-01T00:00:00Z');
      fetchSpy.mockRejectedValue(new githubAdapter.GitHubRateLimitError(resetAt));

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
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('throws BAD_REQUEST when the session has no git branch', async () => {
      await db
        .update(cli_sessions_v2)
        .set({ git_url: null, git_branch: null })
        .where(eq(cli_sessions_v2.session_id, sessionId));

      const caller = await createCallerForUser(regularUser.id);
      await expect(
        caller.cliSessionsV2.refreshAssociatedPullRequest({ sessionId })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('throws BAD_REQUEST for non-GitHub git URLs', async () => {
      await db
        .update(cli_sessions_v2)
        .set({ git_url: 'https://gitlab.com/kilo/repo' })
        .where(eq(cli_sessions_v2.session_id, sessionId));

      const caller = await createCallerForUser(regularUser.id);
      await expect(
        caller.cliSessionsV2.refreshAssociatedPullRequest({ sessionId })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(fetchSpy).not.toHaveBeenCalled();
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
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        await db
          .update(cli_sessions_v2)
          .set({ organization_id: null })
          .where(eq(cli_sessions_v2.session_id, sessionId));
        await db.delete(organizations).where(eq(organizations.id, otherOrg.id));
      }
    });
  });
});
