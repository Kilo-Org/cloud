import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  createOrganization,
  addUserToOrganization,
} from '@kilocode/web-shared/lib/organizations/organizations';
import { db, getReadDbTarget } from '@kilocode/web-shared/lib/drizzle';
import {
  getAgentInteractionsPerDay,
  getCloudAgentSessionsPerDay,
  getCodeReviewsPerDay,
} from '@kilocode/web-shared/lib/organizations/organization-usage';
import { readCachedAIAdoption, writeCachedAIAdoption } from '@/lib/organizations/ai-adoption-cache';
import {
  agent_configs,
  agent_environment_profiles,
  cloud_agent_webhook_triggers,
  cli_sessions_v2,
  organizations,
  organization_recommendation_dismissals,
  platform_integrations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import type { User, Organization } from '@kilocode/db/schema';

jest.mock('@/lib/organizations/posthog-autocomplete-queries', () => ({
  getAutocompleteAcceptedSuggestionsPerDay: jest.fn().mockResolvedValue([]),
}));

jest.mock('@/lib/organizations/ai-adoption-cache', () => ({
  readCachedAIAdoption: jest.fn().mockResolvedValue(null),
  writeCachedAIAdoption: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@kilocode/web-shared/lib/organizations/organization-usage', () => {
  const actual = jest.requireActual('@kilocode/web-shared/lib/organizations/organization-usage');
  return {
    ...actual,
    getAgentInteractionsPerDay: jest.fn(actual.getAgentInteractionsPerDay),
    getCloudAgentSessionsPerDay: jest.fn(actual.getCloudAgentSessionsPerDay),
    getCodeReviewsPerDay: jest.fn(actual.getCodeReviewsPerDay),
  };
});

// Test users and organization will be created dynamically
let regularUser: User;
let memberUser: User;
let testOrganization: Organization;

describe('organizations usage details trpc router', () => {
  beforeAll(async () => {
    // Create test users using the helper function
    regularUser = await insertTestUser({
      google_user_email: 'regular-usage@example.com',
      google_user_name: 'Regular Usage User',
      is_admin: false,
    });

    memberUser = await insertTestUser({
      google_user_email: 'member-usage@example.com',
      google_user_name: 'Member Usage User',
      is_admin: false,
    });

    // Create test organization using the CRUD method
    testOrganization = await createOrganization('Test Usage Organization', regularUser.id);

    // Add member user to organization using CRUD method
    await addUserToOrganization(testOrganization.id, memberUser.id, 'member');
  });

  afterEach(async () => {
    // Clean up usage and feature adoption data after each test
    await db
      .delete(cloud_agent_webhook_triggers)
      .where(eq(cloud_agent_webhook_triggers.organization_id, testOrganization.id));
    await db
      .delete(agent_environment_profiles)
      .where(eq(agent_environment_profiles.owned_by_organization_id, testOrganization.id));
    await Promise.all([
      db
        .delete(platform_integrations)
        .where(eq(platform_integrations.owned_by_organization_id, testOrganization.id)),
      db
        .delete(organization_recommendation_dismissals)
        .where(
          eq(organization_recommendation_dismissals.owned_by_organization_id, testOrganization.id)
        ),
      db
        .delete(agent_configs)
        .where(eq(agent_configs.owned_by_organization_id, testOrganization.id)),
      db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.organization_id, testOrganization.id)),
    ]);
  });

  describe('getFeatureAdoption procedure', () => {
    it('returns feature checks to a member of an Enterprise organization', async () => {
      await db
        .update(organizations)
        .set({ plan: 'enterprise' })
        .where(eq(organizations.id, testOrganization.id));
      const caller = await createCallerForUser(memberUser.id);

      const result = await caller.organizations.usageDetails.getFeatureAdoption({
        organizationId: testOrganization.id,
      });

      expect(result.checks).toHaveLength(5);
      expect(result.checks.every(check => !check.adopted)).toBe(true);
    });

    it('requires a bot-enabled Linear integration for team workflow adoption', async () => {
      await db
        .update(organizations)
        .set({ plan: 'enterprise' })
        .where(eq(organizations.id, testOrganization.id));
      await db.insert(platform_integrations).values({
        owned_by_organization_id: testOrganization.id,
        platform: 'linear',
        integration_type: 'app',
        platform_installation_id: `linear-${crypto.randomUUID()}`,
        platform_account_login: 'test-linear-workspace',
        repository_access: 'all',
        integration_status: 'active',
        metadata: { bot_enabled: false },
      });
      const caller = await createCallerForUser(memberUser.id);

      const disabledResult = await caller.organizations.usageDetails.getFeatureAdoption({
        organizationId: testOrganization.id,
      });
      expect(disabledResult.checks.find(check => check.key === 'team-integration')?.adopted).toBe(
        false
      );

      await db
        .update(platform_integrations)
        .set({ metadata: { bot_enabled: true } })
        .where(eq(platform_integrations.owned_by_organization_id, testOrganization.id));
      const enabledResult = await caller.organizations.usageDetails.getFeatureAdoption({
        organizationId: testOrganization.id,
      });
      expect(enabledResult.checks.find(check => check.key === 'team-integration')?.adopted).toBe(
        true
      );
    });

    it('rejects feature adoption reporting for a Teams organization', async () => {
      await db
        .update(organizations)
        .set({ plan: 'teams' })
        .where(eq(organizations.id, testOrganization.id));
      const caller = await createCallerForUser(memberUser.id);

      await expect(
        caller.organizations.usageDetails.getFeatureAdoption({
          organizationId: testOrganization.id,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('recommendations procedures', () => {
    it('returns recommendations to an Enterprise member', async () => {
      await db
        .update(organizations)
        .set({ plan: 'enterprise' })
        .where(eq(organizations.id, testOrganization.id));
      const caller = await createCallerForUser(memberUser.id);

      const result = await caller.organizations.usageDetails.getRecommendations({
        organizationId: testOrganization.id,
      });

      // A freshly created org has no SSO configured, so that fires as an open item.
      expect(result.recommendations.find(r => r.key === 'org-sso-not-configured')?.status).toBe(
        'open'
      );
    });

    it('treats SSO inherited from a parent organization as configured', async () => {
      const parentOwner = await insertTestUser();
      const parent = await createOrganization('Parent SSO Organization', parentOwner.id);
      await db
        .update(organizations)
        .set({ sso_domain: `recommendations-${crypto.randomUUID()}.example.com` })
        .where(eq(organizations.id, parent.id));
      await db
        .update(organizations)
        .set({ plan: 'enterprise', parent_organization_id: parent.id })
        .where(eq(organizations.id, testOrganization.id));
      const caller = await createCallerForUser(memberUser.id);

      try {
        const result = await caller.organizations.usageDetails.getRecommendations({
          organizationId: testOrganization.id,
        });

        expect(result.recommendations.find(r => r.key === 'org-sso-not-configured')?.status).toBe(
          'completed'
        );
      } finally {
        await db
          .update(organizations)
          .set({ parent_organization_id: null })
          .where(eq(organizations.id, testOrganization.id));
        await db.delete(organizations).where(eq(organizations.id, parent.id));
      }
    });

    it('rejects recommendation reads and mutations for a soft-deleted organization', async () => {
      await db
        .update(organizations)
        .set({ plan: 'enterprise', deleted_at: new Date().toISOString() })
        .where(eq(organizations.id, testOrganization.id));
      const member = await createCallerForUser(memberUser.id);
      const owner = await createCallerForUser(regularUser.id);

      try {
        await expect(
          member.organizations.usageDetails.getRecommendations({
            organizationId: testOrganization.id,
          })
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(
          owner.organizations.usageDetails.dismissRecommendation({
            organizationId: testOrganization.id,
            recommendationKey: 'org-sso-not-configured',
          })
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(
          owner.organizations.usageDetails.restoreRecommendation({
            organizationId: testOrganization.id,
            recommendationKey: 'org-sso-not-configured',
          })
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      } finally {
        await db
          .update(organizations)
          .set({ deleted_at: null })
          .where(eq(organizations.id, testOrganization.id));
      }
    });

    it('hides a recommendation after an owner dismisses it', async () => {
      await db
        .update(organizations)
        .set({ plan: 'enterprise' })
        .where(eq(organizations.id, testOrganization.id));
      const owner = await createCallerForUser(regularUser.id);

      await owner.organizations.usageDetails.dismissRecommendation({
        organizationId: testOrganization.id,
        recommendationKey: 'org-sso-not-configured',
      });

      const afterDismiss = await owner.organizations.usageDetails.getRecommendations({
        organizationId: testOrganization.id,
      });
      // Dismissed items move to the dismissed status, not removed entirely.
      expect(
        afterDismiss.recommendations.find(r => r.key === 'org-sso-not-configured')?.status
      ).toBe('dismissed');

      await owner.organizations.usageDetails.restoreRecommendation({
        organizationId: testOrganization.id,
        recommendationKey: 'org-sso-not-configured',
      });
      const afterRestore = await owner.organizations.usageDetails.getRecommendations({
        organizationId: testOrganization.id,
      });
      expect(
        afterRestore.recommendations.find(r => r.key === 'org-sso-not-configured')?.status
      ).toBe('open');
    });

    it('opens the merge gate recommendation when a code reviewer config has no gate threshold', async () => {
      await db
        .update(organizations)
        .set({ plan: 'enterprise' })
        .where(eq(organizations.id, testOrganization.id));
      // Enabled Code Reviewer with a security focus but no gate_threshold. A
      // missing threshold defaults to 'off', so the merge gate is not active.
      await db.insert(agent_configs).values({
        owned_by_organization_id: testOrganization.id,
        agent_type: 'code_review',
        platform: 'github',
        is_enabled: true,
        created_by: regularUser.id,
        config: { review_style: 'balanced', focus_areas: ['security'], model_slug: 'test-model' },
      });
      const caller = await createCallerForUser(memberUser.id);

      const result = await caller.organizations.usageDetails.getRecommendations({
        organizationId: testOrganization.id,
      });

      expect(
        result.recommendations.find(r => r.key === 'code-reviewer-no-merge-gate')?.status
      ).toBe('open');
    });

    it('keeps the merge gate open for a GitLab config even when GitHub is on the read-only app', async () => {
      await db
        .update(organizations)
        .set({ plan: 'enterprise' })
        .where(eq(organizations.id, testOrganization.id));
      // Read-only GitHub app: GitHub cannot gate, but GitLab is unaffected.
      await db.insert(platform_integrations).values({
        owned_by_organization_id: testOrganization.id,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: `github-${crypto.randomUUID()}`,
        platform_account_login: 'test-github-org',
        repository_access: 'all',
        integration_status: 'active',
        github_app_type: 'lite',
      });
      // Enabled GitLab Code Reviewer with the gate off; GitLab can gate.
      await db.insert(agent_configs).values({
        owned_by_organization_id: testOrganization.id,
        agent_type: 'code_review',
        platform: 'gitlab',
        is_enabled: true,
        created_by: regularUser.id,
        config: {
          review_style: 'balanced',
          focus_areas: ['security'],
          model_slug: 'test-model',
          gate_threshold: 'off',
        },
      });
      const caller = await createCallerForUser(memberUser.id);

      const result = await caller.organizations.usageDetails.getRecommendations({
        organizationId: testOrganization.id,
      });

      // The GitLab config can gate, so the recommendation is not suppressed by the
      // unrelated GitHub Lite installation.
      expect(
        result.recommendations.find(r => r.key === 'code-reviewer-no-merge-gate')?.status
      ).toBe('open');
      // The lite app is still flagged separately.
      expect(result.recommendations.find(r => r.key === 'org-github-lite-app')?.status).toBe(
        'open'
      );
    });

    it('ignores inactive and non-Cloud-Agent triggers when recommending automation', async () => {
      await db
        .update(organizations)
        .set({ plan: 'enterprise' })
        .where(eq(organizations.id, testOrganization.id));
      const [profile] = await db
        .insert(agent_environment_profiles)
        .values({
          owned_by_organization_id: testOrganization.id,
          created_by_user_id: regularUser.id,
          name: `recommendations-${crypto.randomUUID()}`,
        })
        .returning({ id: agent_environment_profiles.id });
      await db.insert(cli_sessions_v2).values({
        session_id: `recommendations-${crypto.randomUUID()}`,
        kilo_user_id: regularUser.id,
        organization_id: testOrganization.id,
        cloud_agent_session_id: `cloud-${crypto.randomUUID()}`,
      });
      await db.insert(cloud_agent_webhook_triggers).values({
        trigger_id: `inactive-${crypto.randomUUID()}`,
        organization_id: testOrganization.id,
        github_repo: 'test/repo',
        profile_id: profile.id,
        is_active: false,
      });
      const caller = await createCallerForUser(memberUser.id);

      const result = await caller.organizations.usageDetails.getRecommendations({
        organizationId: testOrganization.id,
      });

      expect(result.recommendations.find(r => r.key === 'cloud-agent-no-automation')?.status).toBe(
        'open'
      );
    });

    it('treats mixed full and Lite GitHub installations as full-app capable', async () => {
      await db
        .update(organizations)
        .set({ plan: 'enterprise' })
        .where(eq(organizations.id, testOrganization.id));
      await db.insert(platform_integrations).values([
        {
          owned_by_organization_id: testOrganization.id,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: `lite-${crypto.randomUUID()}`,
          integration_status: 'active',
          github_app_type: 'lite',
        },
        {
          owned_by_organization_id: testOrganization.id,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: `standard-${crypto.randomUUID()}`,
          integration_status: 'active',
          github_app_type: 'standard',
        },
      ]);
      await db.insert(agent_configs).values({
        owned_by_organization_id: testOrganization.id,
        agent_type: 'code_review',
        platform: 'github',
        is_enabled: true,
        created_by: regularUser.id,
        config: { review_style: 'balanced', focus_areas: ['security'], model_slug: 'test-model' },
      });
      const caller = await createCallerForUser(memberUser.id);

      const result = await caller.organizations.usageDetails.getRecommendations({
        organizationId: testOrganization.id,
      });

      expect(result.recommendations.find(r => r.key === 'org-github-lite-app')?.status).toBe(
        'completed'
      );
      expect(
        result.recommendations.find(r => r.key === 'code-reviewer-no-merge-gate')?.status
      ).toBe('open');
    });

    it('rejects dismissal and restore for a hard-expired organization', async () => {
      await db
        .update(organizations)
        .set({ plan: 'enterprise', free_trial_end_at: '2020-01-01T00:00:00.000Z' })
        .where(eq(organizations.id, testOrganization.id));
      const owner = await createCallerForUser(regularUser.id);

      await expect(
        owner.organizations.usageDetails.dismissRecommendation({
          organizationId: testOrganization.id,
          recommendationKey: 'org-sso-not-configured',
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        owner.organizations.usageDetails.restoreRecommendation({
          organizationId: testOrganization.id,
          recommendationKey: 'org-sso-not-configured',
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('rejects dismissal from a non-owner member', async () => {
      await db
        .update(organizations)
        .set({ plan: 'enterprise' })
        .where(eq(organizations.id, testOrganization.id));
      const member = await createCallerForUser(memberUser.id);

      await expect(
        member.organizations.usageDetails.dismissRecommendation({
          organizationId: testOrganization.id,
          recommendationKey: 'org-sso-not-configured',
        })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });

    it('rejects recommendations for a Teams organization', async () => {
      await db
        .update(organizations)
        .set({ plan: 'teams' })
        .where(eq(organizations.id, testOrganization.id));
      const caller = await createCallerForUser(memberUser.id);

      await expect(
        caller.organizations.usageDetails.getRecommendations({
          organizationId: testOrganization.id,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('getAIAdoptionTimeseries procedure', () => {
    const input = () => ({
      organizationId: testOrganization.id,
      startDate: '2026-10-21T10:05:03.123Z',
      endDate: '2026-11-20T10:05:03.123Z',
    });

    afterEach(() => {
      jest.restoreAllMocks();
      jest.mocked(readCachedAIAdoption).mockResolvedValue(null);
    });

    it('reads usage through replica transactions that receive a transaction handle', async () => {
      const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
      const transaction = jest.spyOn(getReadDbTarget().db, 'transaction');
      const caller = await createCallerForUser(memberUser.id);

      const result = await caller.organizations.usageDetails.getAIAdoptionTimeseries(input());

      expect(result.unavailable).toBe(false);
      expect(info).toHaveBeenCalledWith('AI adoption timeseries result', {
        outcome: 'available',
        cacheHit: false,
      });
      // Members plus the three per-day reads each run in their own bounded transaction.
      expect(transaction).toHaveBeenCalledTimes(4);
      for (const read of [
        getAgentInteractionsPerDay,
        getCloudAgentSessionsPerDay,
        getCodeReviewsPerDay,
      ]) {
        const lastArgument = jest.mocked(read).mock.calls.at(-1)?.[3];
        expect(lastArgument).toBeDefined();
        expect(lastArgument).not.toBe(db);
      }
    });

    it('rounds the range for the queries and the cache key, and caches the result', async () => {
      const caller = await createCallerForUser(memberUser.id);

      const result = await caller.organizations.usageDetails.getAIAdoptionTimeseries(input());

      const key = {
        organizationId: testOrganization.id,
        startDate: '2026-10-21T10:00:00.000Z',
        endDate: '2026-11-20T11:00:00.000Z',
      };
      expect(readCachedAIAdoption).toHaveBeenCalledWith(key, expect.anything());
      expect(writeCachedAIAdoption).toHaveBeenCalledWith(key, result);
      expect(getAgentInteractionsPerDay).toHaveBeenLastCalledWith(
        testOrganization.id,
        '2026-10-07T10:00:00.000Z',
        '2026-11-20T11:00:00.000Z',
        expect.anything()
      );
    });

    it('returns a cached result without querying', async () => {
      const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
      const cached = {
        timeseries: [],
        weeklyTrends: null,
        userScores: [],
        isNewOrganization: true,
        unavailable: false,
      };
      jest.mocked(readCachedAIAdoption).mockResolvedValueOnce(cached);
      const transaction = jest.spyOn(getReadDbTarget().db, 'transaction');
      const caller = await createCallerForUser(memberUser.id);

      const result = await caller.organizations.usageDetails.getAIAdoptionTimeseries(input());

      expect(result).toEqual(cached);
      expect(transaction).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith('AI adoption timeseries result', {
        outcome: 'available',
        cacheHit: true,
      });
    });

    it.each([
      ['statement_timeout', '57014', 'canceling statement due to statement timeout'],
      ['lock_timeout', '55P03', 'canceling statement due to lock timeout'],
      ['replica_recovery_conflict', '40001', 'canceling statement due to conflict with recovery'],
    ])('degrades and logs only safe diagnostics on %s', async (reason, code, message) => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      jest
        .mocked(getAgentInteractionsPerDay)
        .mockRejectedValueOnce(
          new Error('Failed query: raw SQL and params', { cause: { code, message } })
        );
      jest.mocked(writeCachedAIAdoption).mockClear();
      const caller = await createCallerForUser(memberUser.id);

      const result = await caller.organizations.usageDetails.getAIAdoptionTimeseries(input());

      expect(result).toEqual({
        timeseries: [],
        weeklyTrends: null,
        userScores: [],
        isNewOrganization: false,
        unavailable: true,
      });
      expect(writeCachedAIAdoption).not.toHaveBeenCalled();
      expect(
        warn.mock.calls.filter(([message]) => message === 'AI adoption timeseries result')
      ).toEqual([
        [
          'AI adoption timeseries result',
          {
            outcome: 'unavailable',
            query: 'agent_interactions',
            replica: getReadDbTarget().name,
            elapsedMs: expect.any(Number),
            sqlstate: code,
            reason,
          },
        ],
      ]);
    });

    it('still rejects on an unexpected database failure', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      jest
        .mocked(getAgentInteractionsPerDay)
        .mockRejectedValueOnce(new Error('unexpected failure'));
      const caller = await createCallerForUser(memberUser.id);

      await expect(
        caller.organizations.usageDetails.getAIAdoptionTimeseries(input())
      ).rejects.toThrow('unexpected failure');
      expect(warn).toHaveBeenCalledWith('AI adoption timeseries result', { outcome: 'error' });
    });

    it('does not add a day that has not started when the end rounds up to midnight', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-20T23:30:00.000Z'));
      const caller = await createCallerForUser(memberUser.id);

      const result = await caller.organizations.usageDetails.getAIAdoptionTimeseries({
        organizationId: testOrganization.id,
        startDate: '2026-11-20T00:00:00.000Z',
        endDate: '2026-11-20T23:30:00.000Z',
      });

      expect(result.timeseries.map(point => point.datetime.slice(0, 10))).toEqual(['2026-11-20']);
    });

    it.each([
      ['an end before the start', '2026-11-20T00:00:00.000Z', '2026-11-19T00:00:00.000Z'],
      ['a span over 400 days', '2025-01-01T00:00:00.000Z', '2026-11-20T00:00:00.000Z'],
    ])('rejects %s', async (_name, startDate, endDate) => {
      const caller = await createCallerForUser(memberUser.id);

      await expect(
        caller.organizations.usageDetails.getAIAdoptionTimeseries({
          organizationId: testOrganization.id,
          startDate,
          endDate,
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('still fails on errors that are not replica bounds', async () => {
      jest
        .mocked(getCodeReviewsPerDay)
        .mockRejectedValueOnce(new Error('Failed query', { cause: { code: '23505' } }));
      const caller = await createCallerForUser(memberUser.id);

      await expect(
        caller.organizations.usageDetails.getAIAdoptionTimeseries(input())
      ).rejects.toThrow();
    });
  });
});
