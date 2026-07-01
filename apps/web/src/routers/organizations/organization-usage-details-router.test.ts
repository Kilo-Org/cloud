import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { insertUsageWithOverrides } from '@/tests/helpers/microdollar-usage.helper';
import { createOrganization, addUserToOrganization } from '@/lib/organizations/organizations';
import { db, pool } from '@/lib/drizzle';
import {
  agent_configs,
  agent_environment_profiles,
  cloud_agent_webhook_triggers,
  cli_sessions_v2,
  microdollar_usage,
  organizations,
  organization_recommendation_dismissals,
  platform_integrations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import type { User, Organization } from '@kilocode/db/schema';

// Test users and organization will be created dynamically
let regularUser: User;
let memberUser: User;
let testOrganization: Organization;

// Helper functions for date handling in tests
async function getDateFromDb(intervalString = '0 days'): Promise<string> {
  const query =
    intervalString === '0 days'
      ? 'SELECT now()::text as date'
      : `SELECT (now() - interval '${intervalString}')::text as date`;

  const { rows } = await pool.query<{ date: string }>(query);
  return rows[0].date;
}

function extractDateOnly(timestamp: string): string {
  return timestamp.split(/[T ]/)[0];
}

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
        .delete(microdollar_usage)
        .where(eq(microdollar_usage.organization_id, testOrganization.id)),
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

      expect(result.checks).toHaveLength(6);
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

  describe('get procedure', () => {
    it('should return usage details for organization member with default parameters', async () => {
      // Get current date from database to ensure consistency
      const now = await getDateFromDb();
      const yesterday = await getDateFromDb('1 day');

      await insertUsageWithOverrides({
        kilo_user_id: memberUser.id,
        organization_id: testOrganization.id,
        cost: 1000,
        input_tokens: 300,
        output_tokens: 200,
        created_at: now,
        model: 'gpt-4',
      });

      await insertUsageWithOverrides({
        kilo_user_id: memberUser.id,
        organization_id: testOrganization.id,
        cost: 1500,
        input_tokens: 450,
        output_tokens: 300,
        created_at: yesterday,
        model: 'gpt-4',
      });

      const caller = await createCallerForUser(memberUser.id);

      const result = await caller.organizations.usageDetails.get({
        organizationId: testOrganization.id,
      });

      expect(result.daily).toHaveLength(2);

      // Results should be ordered by date desc (newest first)
      const nowDate = extractDateOnly(now);
      const yesterdayDate = extractDateOnly(yesterday);
      const todayResult = result.daily.find(d => d.date === nowDate);
      const yesterdayResult = result.daily.find(d => d.date === yesterdayDate);

      expect(todayResult).toEqual({
        date: nowDate,
        user: {
          name: memberUser.google_user_name,
          email: memberUser.google_user_email,
        },
        microdollarCost: '1000',
        tokenCount: 500,
        inputTokens: 300,
        outputTokens: 200,
        requestCount: 1,
      });

      expect(yesterdayResult).toEqual({
        date: yesterdayDate,
        user: {
          name: memberUser.google_user_name,
          email: memberUser.google_user_email,
        },
        microdollarCost: '1500',
        tokenCount: 750,
        inputTokens: 450,
        outputTokens: 300,
        requestCount: 1,
      });
    });

    it('should return usage details with week period filter', async () => {
      // Get dates from database to ensure consistency
      const threeDaysAgo = await getDateFromDb('3 days');
      const tenDaysAgo = await getDateFromDb('10 days');

      await insertUsageWithOverrides({
        kilo_user_id: memberUser.id,
        organization_id: testOrganization.id,
        cost: 1000,
        input_tokens: 300,
        output_tokens: 200,
        created_at: threeDaysAgo,
        model: 'gpt-4',
      });

      await insertUsageWithOverrides({
        kilo_user_id: memberUser.id,
        organization_id: testOrganization.id,
        cost: 2000,
        input_tokens: 600,
        output_tokens: 400,
        created_at: tenDaysAgo,
        model: 'gpt-4',
      });

      const caller = await createCallerForUser(memberUser.id);

      const result = await caller.organizations.usageDetails.get({
        organizationId: testOrganization.id,
        period: 'week',
      });

      // Should only include usage from within the last week (3 days ago, not 10 days ago)
      expect(result.daily).toHaveLength(1);
      expect(result.daily[0]).toEqual({
        date: extractDateOnly(threeDaysAgo),
        user: {
          name: memberUser.google_user_name,
          email: memberUser.google_user_email,
        },
        microdollarCost: '1000',
        tokenCount: 500,
        inputTokens: 300,
        outputTokens: 200,
        requestCount: 1,
      });
    });

    it('should return usage details with me filter for current user', async () => {
      // Get current date from database to ensure consistency
      const now = await getDateFromDb();

      await insertUsageWithOverrides({
        kilo_user_id: memberUser.id,
        organization_id: testOrganization.id,
        cost: 1000,
        input_tokens: 300,
        output_tokens: 200,
        created_at: now,
        model: 'gpt-4',
      });

      await insertUsageWithOverrides({
        kilo_user_id: regularUser.id,
        organization_id: testOrganization.id,
        cost: 2000,
        input_tokens: 600,
        output_tokens: 400,
        created_at: now,
        model: 'gpt-4',
      });

      const caller = await createCallerForUser(memberUser.id);

      const result = await caller.organizations.usageDetails.get({
        organizationId: testOrganization.id,
        userFilter: 'me',
      });

      // Should only include usage from the member user, not the regular user
      expect(result.daily).toHaveLength(1);
      expect(result.daily[0].user.email).toBe(memberUser.google_user_email);
    });

    it('should return usage details grouped by model', async () => {
      // Get current date from database to ensure consistency
      const now = await getDateFromDb();

      await insertUsageWithOverrides({
        kilo_user_id: memberUser.id,
        organization_id: testOrganization.id,
        cost: 1000,
        input_tokens: 300,
        output_tokens: 200,
        created_at: now,
        model: 'gpt-4',
        requested_model: 'gpt-4',
      });

      await insertUsageWithOverrides({
        kilo_user_id: memberUser.id,
        organization_id: testOrganization.id,
        cost: 500,
        input_tokens: 150,
        output_tokens: 100,
        created_at: now,
        model: 'gpt-3.5-turbo',
        requested_model: 'gpt-3.5-turbo',
      });

      const caller = await createCallerForUser(memberUser.id);

      const result = await caller.organizations.usageDetails.get({
        organizationId: testOrganization.id,
        groupByModel: true,
      });

      expect(result.daily).toHaveLength(2);

      const gpt4Result = result.daily.find(d => d.model === 'gpt-4');
      const gpt35Result = result.daily.find(d => d.model === 'gpt-3.5-turbo');

      expect(gpt4Result).toHaveProperty('model', 'gpt-4');
      expect(gpt4Result?.microdollarCost).toBe('1000');

      expect(gpt35Result).toHaveProperty('model', 'gpt-3.5-turbo');
      expect(gpt35Result?.microdollarCost).toBe('500');
    });

    it('should fall back to model when requested_model is null (legacy rows)', async () => {
      const now = await getDateFromDb();

      await insertUsageWithOverrides({
        kilo_user_id: memberUser.id,
        organization_id: testOrganization.id,
        cost: 750,
        created_at: now,
        model: 'legacy-model',
        requested_model: null,
      });

      const caller = await createCallerForUser(memberUser.id);

      const result = await caller.organizations.usageDetails.get({
        organizationId: testOrganization.id,
        groupByModel: true,
      });

      const legacyRow = result.daily.find(d => d.model === 'legacy-model');
      expect(legacyRow).toBeDefined();
      expect(legacyRow?.microdollarCost).toBe('750');
    });

    it('should handle empty usage data', async () => {
      const caller = await createCallerForUser(memberUser.id);

      const result = await caller.organizations.usageDetails.get({
        organizationId: testOrganization.id,
      });

      expect(result).toEqual({
        daily: [],
      });
    });

    it('should handle null microdollar cost', async () => {
      // Get current date from database to ensure consistency
      const now = await getDateFromDb();

      await insertUsageWithOverrides({
        kilo_user_id: memberUser.id,
        organization_id: testOrganization.id,
        cost: 0, // This should result in null when converted
        input_tokens: 300,
        output_tokens: 200,
        created_at: now,
        model: 'gpt-4',
      });

      const caller = await createCallerForUser(memberUser.id);

      const result = await caller.organizations.usageDetails.get({
        organizationId: testOrganization.id,
      });

      expect(result.daily).toHaveLength(1);
      expect(result.daily[0].microdollarCost).toBe('0'); // Should be '0', not null
    });

    it('should throw UNAUTHORIZED error for non-member users', async () => {
      const nonMemberUser = await insertTestUser({
        google_user_email: 'non-member-usage@example.com',
        google_user_name: 'Non Member Usage User',
        is_admin: false,
      });

      const caller = await createCallerForUser(nonMemberUser.id);

      await expect(
        caller.organizations.usageDetails.get({
          organizationId: testOrganization.id,
        })
      ).rejects.toThrow('You do not have access to this organization');
    });

    it('should validate input schema', async () => {
      const caller = await createCallerForUser(memberUser.id);

      // Test invalid UUID
      await expect(
        caller.organizations.usageDetails.get({
          organizationId: 'invalid-uuid',
        })
      ).rejects.toThrow();

      // Test invalid period
      await expect(
        caller.organizations.usageDetails.get({
          organizationId: testOrganization.id,
          // @ts-expect-error Testing invalid period
          period: 'invalid-period',
        })
      ).rejects.toThrow();

      // Test invalid userFilter
      await expect(
        caller.organizations.usageDetails.get({
          organizationId: testOrganization.id,
          // @ts-expect-error Testing invalid userFilter
          userFilter: 'invalid-filter',
        })
      ).rejects.toThrow();
    });

    it('should work with all valid period values', async () => {
      const caller = await createCallerForUser(memberUser.id);

      const periods = ['week', 'month', 'year', 'all'] as const;

      for (const period of periods) {
        const result = await caller.organizations.usageDetails.get({
          organizationId: testOrganization.id,
          period,
        });

        expect(result).toEqual({ daily: [] });
      }
    });
  });

  describe('getAutocomplete procedure', () => {
    it('should return autocomplete metrics for organization', async () => {
      const now = await getDateFromDb();

      // Insert autocomplete usage (codestral-2508 model)
      await insertUsageWithOverrides({
        kilo_user_id: memberUser.id,
        organization_id: testOrganization.id,
        cost: 1000,
        input_tokens: 300,
        output_tokens: 200,
        created_at: now,
        model: 'codestral-2508',
      });

      await insertUsageWithOverrides({
        kilo_user_id: memberUser.id,
        organization_id: testOrganization.id,
        cost: 500,
        input_tokens: 150,
        output_tokens: 100,
        created_at: now,
        model: 'codestral-2508',
      });

      // Insert non-autocomplete usage (should not be counted)
      await insertUsageWithOverrides({
        kilo_user_id: memberUser.id,
        organization_id: testOrganization.id,
        cost: 2000,
        input_tokens: 600,
        output_tokens: 400,
        created_at: now,
        model: 'gpt-4',
      });

      const caller = await createCallerForUser(memberUser.id);

      const result = await caller.organizations.usageDetails.getAutocomplete({
        organizationId: testOrganization.id,
        period: 'month',
      });

      expect(result.cost).toBe(1500); // 1000 + 500
      expect(result.requests).toBe(2);
      expect(result.tokens).toBe(750); // (300 + 200) + (150 + 100)
    });

    it('should return zero metrics when no autocomplete usage exists', async () => {
      const now = await getDateFromDb();

      // Insert only non-autocomplete usage
      await insertUsageWithOverrides({
        kilo_user_id: memberUser.id,
        organization_id: testOrganization.id,
        cost: 2000,
        input_tokens: 600,
        output_tokens: 400,
        created_at: now,
        model: 'gpt-4',
      });

      const caller = await createCallerForUser(memberUser.id);

      const result = await caller.organizations.usageDetails.getAutocomplete({
        organizationId: testOrganization.id,
        period: 'month',
      });

      expect(result.cost).toBe(0);
      expect(result.requests).toBe(0);
      expect(result.tokens).toBe(0);
    });

    it('should exclude autocomplete usage outside the selected period', async () => {
      const now = await getDateFromDb();
      const twoMonthsAgo = await getDateFromDb('60 days');

      // Insert recent autocomplete usage (within the past week)
      await insertUsageWithOverrides({
        kilo_user_id: memberUser.id,
        organization_id: testOrganization.id,
        cost: 1000,
        input_tokens: 300,
        output_tokens: 200,
        created_at: now,
        model: 'codestral-2508',
      });

      // Insert old autocomplete usage (outside the past week)
      await insertUsageWithOverrides({
        kilo_user_id: memberUser.id,
        organization_id: testOrganization.id,
        cost: 5000,
        input_tokens: 1000,
        output_tokens: 800,
        created_at: twoMonthsAgo,
        model: 'codestral-2508',
      });

      const caller = await createCallerForUser(memberUser.id);

      // Query with 'week' period — should only include recent usage
      const weekResult = await caller.organizations.usageDetails.getAutocomplete({
        organizationId: testOrganization.id,
        period: 'week',
      });

      expect(weekResult.cost).toBe(1000);
      expect(weekResult.requests).toBe(1);
      expect(weekResult.tokens).toBe(500); // 300 + 200

      // Query with 'all' period — should include everything
      const allResult = await caller.organizations.usageDetails.getAutocomplete({
        organizationId: testOrganization.id,
        period: 'all',
      });

      expect(allResult.cost).toBe(6000); // 1000 + 5000
      expect(allResult.requests).toBe(2);
      expect(allResult.tokens).toBe(2300); // (300 + 200) + (1000 + 800)
    });

    it('should throw UNAUTHORIZED error for non-member users', async () => {
      const nonMemberUser = await insertTestUser({
        google_user_email: 'non-member-autocomplete@example.com',
        google_user_name: 'Non Member Autocomplete User',
        is_admin: false,
      });

      const caller = await createCallerForUser(nonMemberUser.id);

      await expect(
        caller.organizations.usageDetails.getAutocomplete({
          organizationId: testOrganization.id,
        })
      ).rejects.toThrow('You do not have access to this organization');
    });
  });
});
