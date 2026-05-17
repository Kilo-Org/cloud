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

// SWC compiles ESM exports as non-configurable, so `jest.spyOn` on re-exported
// module members fails. Replace `fetchPullRequestForBranch` on the already-mocked
// adapter module with a fresh `jest.fn()` so individual tests can drive it.
jest.mock('@/lib/integrations/platforms/github/adapter', () => {
  const actual: Record<string, unknown> = jest.requireActual(
    '@/lib/integrations/platforms/github/adapter'
  );
  return {
    ...actual,
    fetchPullRequestForBranch: jest.fn(),
  };
});

const mockedFetchPullRequestForBranch =
  githubAdapter.fetchPullRequestForBranch as jest.MockedFunction<
    typeof githubAdapter.fetchPullRequestForBranch
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
          caller.cliSessionsV2.getWithRuntimeState({ session_id: sessionWithPr })
        ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      } finally {
        await db
          .update(cli_sessions_v2)
          .set({ organization_id: null })
          .where(eq(cli_sessions_v2.session_id, sessionWithPr));
        await db.delete(organizations).where(eq(organizations.id, otherOrg.id));
      }
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
      const result = await caller.cliSessionsV2.search({ search_string: 'session' });

      const withPr = result.results.find(s => s.session_id === sessionWithPr);
      const withoutPr = result.results.find(s => s.session_id === sessionWithoutPr);

      expect(withPr?.associatedPr).toMatchObject({ number: 77, state: 'open' });
      expect(withoutPr?.associatedPr).toBeNull();
    });
  });

  describe('refreshAssociatedPullRequest', () => {
    const sessionId = 'ses_refresh_pr_1234';
    // Session git_url is stored in the canonical normalized shape that the
    // queue-consumer would persist for a new session, so the tenant-scoped
    // cache JOIN can match.
    const SESSION_GIT_URL = 'https://github.com/kilo/repo';
    const SESSION_BRANCH = 'feature/z';
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

      mockedFetchPullRequestForBranch.mockReset();
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

    it('upserts when GitHub returns a PR', async () => {
      mockedFetchPullRequestForBranch.mockResolvedValue({
        number: 7,
        htmlUrl: 'https://github.com/kilo/repo/pull/7',
        state: 'open',
        title: 'Feature Z',
        headSha: 'abc123',
        updatedAt: '2026-01-01T00:00:00Z',
      });

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.refreshAssociatedPullRequest({ sessionId });

      expect(mockedFetchPullRequestForBranch).toHaveBeenCalledTimes(1);
      expect(mockedFetchPullRequestForBranch).toHaveBeenCalledWith({
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

      const [persisted] = await readCacheRows();
      expect(persisted).toMatchObject({
        git_url: SESSION_GIT_URL,
        git_branch: SESSION_BRANCH,
        owned_by_user_id: regularUser.id,
        owned_by_organization_id: null,
        pr_url: 'https://github.com/kilo/repo/pull/7',
        pr_number: 7,
        pr_state: 'open',
      });
    });

    it('clears the PR data when GitHub returns null while retaining a sentinel row for throttling', async () => {
      await db.insert(github_branch_pull_requests).values({
        git_url: SESSION_GIT_URL,
        git_branch: SESSION_BRANCH,
        owned_by_user_id: regularUser.id,
        pr_url: 'https://github.com/kilo/repo/pull/1',
        pr_number: 1,
        pr_state: 'open',
        pr_title: 'stale',
        pr_head_sha: 'old',
        // Make the stored row old so the throttle does not kick in.
        pr_last_synced_at: new Date(Date.now() - 60_000).toISOString(),
      });
      mockedFetchPullRequestForBranch.mockResolvedValue(null);

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.refreshAssociatedPullRequest({ sessionId });

      expect(result.associatedPr).toBeNull();
      const rows = await readCacheRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        pr_url: null,
        pr_number: null,
        pr_state: null,
        pr_title: null,
        pr_head_sha: null,
        // No PR → nothing to fetch a review decision for. Must not leave the
        // row flagged pending, or the batch worker would repeatedly claim it
        // and skip it (it filters out rows without pr_number) without ever
        // clearing the flag.
        review_decision_pending: false,
      });
      // Sentinel row's pr_last_synced_at is fresh, so the next refresh would
      // short-circuit on the throttle.
      const syncedMs = Date.parse(rows[0].pr_last_synced_at);
      expect(Date.now() - syncedMs).toBeLessThan(5_000);
    });

    it('throttles repeated refreshes even when there is no PR for the branch', async () => {
      mockedFetchPullRequestForBranch.mockResolvedValue(null);

      const caller = await createCallerForUser(regularUser.id);
      // First call persists a sentinel row with fresh pr_last_synced_at.
      await caller.cliSessionsV2.refreshAssociatedPullRequest({ sessionId });
      expect(mockedFetchPullRequestForBranch).toHaveBeenCalledTimes(1);

      // Second call within the throttle window short-circuits.
      const second = await caller.cliSessionsV2.refreshAssociatedPullRequest({ sessionId });
      expect(mockedFetchPullRequestForBranch).toHaveBeenCalledTimes(1);
      expect(second.associatedPr).toBeNull();
    });

    it('short-circuits on the recent-sync throttle without calling GitHub', async () => {
      await db.insert(github_branch_pull_requests).values({
        git_url: SESSION_GIT_URL,
        git_branch: SESSION_BRANCH,
        owned_by_user_id: regularUser.id,
        pr_url: 'https://github.com/kilo/repo/pull/99',
        pr_number: 99,
        pr_state: 'open',
        pr_title: 'recent',
        pr_head_sha: 'fresh',
      });

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.cliSessionsV2.refreshAssociatedPullRequest({ sessionId });

      expect(mockedFetchPullRequestForBranch).not.toHaveBeenCalled();
      expect(result.associatedPr).toMatchObject({ number: 99, state: 'open' });
    });

    it('writes one cache row per (url, branch, tenant) across repeated refreshes', async () => {
      mockedFetchPullRequestForBranch.mockResolvedValue({
        number: 11,
        htmlUrl: 'https://github.com/kilo/repo/pull/11',
        state: 'open',
        title: 'x',
        headSha: 's1',
        updatedAt: '2026-01-01T00:00:00Z',
      });

      const caller = await createCallerForUser(regularUser.id);
      await caller.cliSessionsV2.refreshAssociatedPullRequest({ sessionId });

      // Move pr_last_synced_at back so the throttle releases, then refresh again.
      // Subtract more than REFRESH_THROTTLE_MS so the second call is allowed
      // through to the GitHub adapter mock.
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

      mockedFetchPullRequestForBranch.mockResolvedValue({
        number: 11,
        htmlUrl: 'https://github.com/kilo/repo/pull/11',
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

    it('maps GitHubRateLimitError to TOO_MANY_REQUESTS', async () => {
      const resetAt = new Date('2099-01-01T00:00:00Z');
      mockedFetchPullRequestForBranch.mockRejectedValue(
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
      expect(mockedFetchPullRequestForBranch).not.toHaveBeenCalled();
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
      expect(mockedFetchPullRequestForBranch).not.toHaveBeenCalled();
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
      expect(mockedFetchPullRequestForBranch).not.toHaveBeenCalled();
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
        expect(mockedFetchPullRequestForBranch).not.toHaveBeenCalled();
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
        expect(mockedFetchPullRequestForBranch).not.toHaveBeenCalled();
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
