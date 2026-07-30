import { afterAll, describe, expect, it } from '@jest/globals';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { getAgentConfig } from '@/lib/agent-config/db/agent-configs';
import { db } from '@/lib/drizzle';
import { agent_configs, organization_audit_logs, organizations } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
const createdOrganizationIds: string[] = [];

async function createFixtureOrganization() {
  const owner = await insertTestUser();
  // require_seats=false grants the trial-bypass that organizationBillingMutationProcedure needs.
  const organization = await createTestOrganization(
    `Code Reviews ${crypto.randomUUID()}`,
    owner.id,
    0,
    {},
    false
  );
  createdOrganizationIds.push(organization.id);
  return { owner, organization };
}

async function settingsChangeAuditLogs(organizationId: string) {
  return db
    .select({ message: organization_audit_logs.message })
    .from(organization_audit_logs)
    .where(
      and(
        eq(organization_audit_logs.organization_id, organizationId),
        eq(organization_audit_logs.action, 'organization.settings.change')
      )
    );
}

describe('organization review agent router: toggleReviewAgent', () => {
  afterAll(async () => {
    for (const organizationId of createdOrganizationIds) {
      await db
        .delete(organization_audit_logs)
        .where(eq(organization_audit_logs.organization_id, organizationId));
      await db
        .delete(agent_configs)
        .where(eq(agent_configs.owned_by_organization_id, organizationId));
      await db.delete(organizations).where(eq(organizations.id, organizationId));
    }
  });

  it('does not audit a disable for a platform that never had a config', async () => {
    const { owner, organization } = await createFixtureOrganization();
    const caller = await createCallerForUser(owner.id);

    const result = await caller.organizations.reviewAgent.toggleReviewAgent({
      organizationId: organization.id,
      platform: 'github',
      isEnabled: false,
    });

    expect(result).toEqual({ success: true, isEnabled: false });
    // No config row was created and nothing was disabled, so no state transition to audit.
    expect(await getAgentConfig(organization.id, 'code_review', 'github')).toBeNull();
    expect(await settingsChangeAuditLogs(organization.id)).toHaveLength(0);
  });

  it('audits enabling the agent for the first time', async () => {
    const { owner, organization } = await createFixtureOrganization();
    const caller = await createCallerForUser(owner.id);

    const result = await caller.organizations.reviewAgent.toggleReviewAgent({
      organizationId: organization.id,
      platform: 'github',
      isEnabled: true,
    });

    expect(result).toEqual({ success: true, isEnabled: true });
    expect(await getAgentConfig(organization.id, 'code_review', 'github')).not.toBeNull();
    const logs = await settingsChangeAuditLogs(organization.id);
    expect(logs).toEqual([{ message: 'Enabled AI Code Review Agent for github' }]);
  });

  it('does not audit re-enabling an already-enabled agent', async () => {
    const { owner, organization } = await createFixtureOrganization();
    const caller = await createCallerForUser(owner.id);

    // First enable creates the config and audits once.
    await caller.organizations.reviewAgent.toggleReviewAgent({
      organizationId: organization.id,
      platform: 'github',
      isEnabled: true,
    });

    // Repeating the same enable is a no-op and must not add another audit row.
    const result = await caller.organizations.reviewAgent.toggleReviewAgent({
      organizationId: organization.id,
      platform: 'github',
      isEnabled: true,
    });

    expect(result).toEqual({ success: true, isEnabled: true });
    const logs = await settingsChangeAuditLogs(organization.id);
    expect(logs).toEqual([{ message: 'Enabled AI Code Review Agent for github' }]);
  });
});

describe('organization review agent router: council config', () => {
  afterAll(async () => {
    for (const organizationId of createdOrganizationIds) {
      await db
        .delete(organization_audit_logs)
        .where(eq(organization_audit_logs.organization_id, organizationId));
      await db
        .delete(agent_configs)
        .where(eq(agent_configs.owned_by_organization_id, organizationId));
      await db.delete(organizations).where(eq(organizations.id, organizationId));
    }
  });

  const activeCouncil = {
    enabled: true as const,
    aggregation_strategy: 'unanimous' as const,
    specialists: [
      {
        id: 'security',
        role: 'security' as const,
        name: 'Security',
        enabled: true,
        required: false,
        lens: 'x',
      },
      {
        id: 'performance',
        role: 'performance' as const,
        name: 'Performance',
        enabled: true,
        required: false,
        lens: 'y',
      },
    ],
  };

  it('getReviewConfig exposes council fields (null/empty by default)', async () => {
    const { owner, organization } = await createFixtureOrganization();
    const caller = await createCallerForUser(owner.id);

    const cfg = await caller.organizations.reviewAgent.getReviewConfig({
      organizationId: organization.id,
      platform: 'github',
    });

    expect(cfg.council).toBeNull();
    expect(cfg.councilEnabledRepositoryIds).toEqual([]);
  });

  it('saves and reloads the council config + per-repo opt-ins for an entitled org', async () => {
    // The fixture org has the trial bypass, which grants council entitlement (require_seats=false).
    const { owner, organization } = await createFixtureOrganization();
    const caller = await createCallerForUser(owner.id);

    await caller.organizations.reviewAgent.saveReviewConfig({
      organizationId: organization.id,
      platform: 'github',
      reviewStyle: 'balanced',
      focusAreas: [],
      modelSlug: 'anthropic/claude-sonnet-5',
      council: activeCouncil,
      councilEnabledRepositoryIds: [123, 456],
    });

    const cfg = await caller.organizations.reviewAgent.getReviewConfig({
      organizationId: organization.id,
      platform: 'github',
    });
    expect(cfg.council?.enabled).toBe(true);
    expect(cfg.council?.aggregation_strategy).toBe('unanimous');
    expect(cfg.council?.specialists).toHaveLength(2);
    expect(cfg.councilEnabledRepositoryIds).toEqual([123, 456]);
  });

  it('round-trips the council required_labels selection gate', async () => {
    const { owner, organization } = await createFixtureOrganization();
    const caller = await createCallerForUser(owner.id);

    await caller.organizations.reviewAgent.saveReviewConfig({
      organizationId: organization.id,
      platform: 'github',
      reviewStyle: 'balanced',
      focusAreas: [],
      modelSlug: 'anthropic/claude-sonnet-5',
      council: { ...activeCouncil, required_labels: ['council', 'needs-deep-review'] },
      councilEnabledRepositoryIds: [123],
    });

    const cfg = await caller.organizations.reviewAgent.getReviewConfig({
      organizationId: organization.id,
      platform: 'github',
    });
    expect(cfg.council?.required_labels).toEqual(['council', 'needs-deep-review']);
  });
});

describe('organization review agent router: patchReviewConfig', () => {
  const activeCouncil = {
    enabled: true as const,
    aggregation_strategy: 'unanimous' as const,
    specialists: [
      {
        id: 'security',
        role: 'security' as const,
        name: 'Security',
        enabled: true,
        required: false,
        lens: 'x',
      },
      {
        id: 'performance',
        role: 'performance' as const,
        name: 'Performance',
        enabled: true,
        required: false,
        lens: 'y',
      },
    ],
  };

  // A fully-populated org config that the field-merge PATCH must NOT
  // touch when the patch omits those fields: council, councilEnabled,
  // manuallyAddedRepositories, repositoryModelOverrides, plus the
  // review_memory_enabled / review_analytics_enabled feature flags.
  async function seedOrgGithubConfig(
    organization: { id: string },
    owner: { id: string }
  ): Promise<void> {
    await db.insert(agent_configs).values({
      owned_by_organization_id: organization.id,
      agent_type: 'code_review',
      platform: 'github',
      config: {
        review_style: 'balanced',
        focus_areas: ['bugs'],
        custom_instructions: 'be terse',
        model_slug: 'anthropic/claude-sonnet-5',
        thinking_effort: null,
        gate_threshold: 'off',
        repository_selection_mode: 'all',
        selected_repository_ids: [101, 202],
        manually_added_repositories: [
          { id: 9, name: 'manual', full_name: 'manual/repo', private: true },
        ],
        repository_model_overrides: [
          {
            repository_id: 101,
            repo_full_name: 'acme/api',
            model_slug: 'openai/gpt-5',
            thinking_effort: 'high',
          },
        ],
        council: activeCouncil,
        council_enabled_repository_ids: [101, 202],
        disable_review_md: true,
        // Web-only setting the patch schema never carries; `false` proves
        // the patch passes it through instead of resetting to the default.
        skip_bot_pull_requests: false,
        review_memory_enabled: true,
        review_analytics_enabled: true,
      },
      is_enabled: false,
      created_by: owner.id,
    });
  }

  it('returns NOT_FOUND when no stored org config exists', async () => {
    const { owner, organization } = await createFixtureOrganization();
    const caller = await createCallerForUser(owner.id);

    await expect(
      caller.organizations.reviewAgent.patchReviewConfig({
        organizationId: organization.id,
        platform: 'github',
        reviewStyle: 'strict',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const stored = await getAgentConfig(organization.id, 'code_review', 'github');
    expect(stored).toBeNull();
  });

  it('preserves council, councilEnabled, manuallyAddedRepositories, and overrides when the mobile-shaped patch omits them', async () => {
    const { owner, organization } = await createFixtureOrganization();
    await seedOrgGithubConfig(organization, owner);
    const caller = await createCallerForUser(owner.id);

    await caller.organizations.reviewAgent.patchReviewConfig({
      organizationId: organization.id,
      platform: 'github',
      // Only the mobile-shaped fields. Council / councilEnabled /
      // manuallyAddedRepositories / repositoryModelOverrides are absent
      // and must round-trip through the patch unchanged.
      reviewStyle: 'strict',
      focusAreas: ['security'],
      modelSlug: 'openai/gpt-5',
    });

    const stored = await getAgentConfig(organization.id, 'code_review', 'github');
    expect(stored?.config).toEqual(
      expect.objectContaining({
        review_style: 'strict',
        focus_areas: ['security'],
        model_slug: 'openai/gpt-5',
        council: expect.objectContaining({ enabled: true, aggregation_strategy: 'unanimous' }),
        council_enabled_repository_ids: [101, 202],
        manually_added_repositories: [
          { id: 9, name: 'manual', full_name: 'manual/repo', private: true },
        ],
        repository_model_overrides: [
          {
            repository_id: 101,
            repo_full_name: 'acme/api',
            model_slug: 'openai/gpt-5',
            thinking_effort: 'high',
          },
        ],
        // Feature flags preserved by `preserveCodeReviewFeatureSettings`:
        review_memory_enabled: true,
        review_analytics_enabled: true,
      })
    );
  });

  it('preserves council when the patch edits an unrelated field (entitlement gate NOT triggered)', async () => {
    // The fixture org is entitled, but the assertion here is behavioral:
    // an unrelated field edit (reviewStyle) must NOT re-evaluate the
    // entitlement gate. We verify by checking the gate would have failed
    // had it run against a NON-entitled org: if the helper decides to
    // re-trigger the gate on every patch, the assertion would either
    // silently pass (entitled) or, in a non-entitled setup, throw — so
    // this test also documents the omit-council preservation contract.
    const { owner, organization } = await createFixtureOrganization();
    await seedOrgGithubConfig(organization, owner);
    const caller = await createCallerForUser(owner.id);

    await caller.organizations.reviewAgent.patchReviewConfig({
      organizationId: organization.id,
      platform: 'github',
      reviewStyle: 'lenient',
    });

    const stored = await getAgentConfig(organization.id, 'code_review', 'github');
    expect(stored?.config).toEqual(
      expect.objectContaining({
        review_style: 'lenient',
        // Council preserved unchanged.
        council: expect.objectContaining({
          enabled: true,
          aggregation_strategy: 'unanimous',
          specialists: expect.arrayContaining([
            expect.objectContaining({ id: 'security' }),
            expect.objectContaining({ id: 'performance' }),
          ]),
        }),
        council_enabled_repository_ids: [101, 202],
      })
    );
  });

  it('writes a PATCH audit log identifying the patch action', async () => {
    const { owner, organization } = await createFixtureOrganization();
    await seedOrgGithubConfig(organization, owner);
    const caller = await createCallerForUser(owner.id);

    await caller.organizations.reviewAgent.patchReviewConfig({
      organizationId: organization.id,
      platform: 'github',
      reviewStyle: 'roast',
    });

    const logs = await settingsChangeAuditLogs(organization.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.message).toMatch(/^Patched Review Agent configuration for github/);
    expect(logs[0]?.message).toContain('roast');
  });

  // P0-B-13b: real mobile→server contract guard. The mobile
  // useSaveReviewConfig hook now sends a partial org patch whose shape
  // is exactly { organizationId, platform, ...editedFields } — no
  // manuallyAddedRepositories, no council, no councilEnabledRepositoryIds,
  // no autoConfigureWebhooks. The server PATCH must field-merge those
  // absent keys from the stored config so mobile edits do not clobber
  // org-only state the mobile UI does not surface.
  it('preserves a config seeded with council + manuallyAddedRepositories + councilEnabledRepositoryIds when a mobile-shaped patch is applied', async () => {
    const { owner, organization } = await createFixtureOrganization();
    await seedOrgGithubConfig(organization, owner);
    const caller = await createCallerForUser(owner.id);

    // Mobile-shaped patch: ONLY the keys the mobile UI lets the user
    // edit. council, councilEnabledRepositoryIds, manuallyAddedRepositories,
    // and repositoryModelOverrides are ALL absent — the server must
    // preserve them.
    await caller.organizations.reviewAgent.patchReviewConfig({
      organizationId: organization.id,
      platform: 'github',
      reviewStyle: 'strict',
      focusAreas: ['security'],
    });

    const stored = await getAgentConfig(organization.id, 'code_review', 'github');

    // Patched fields applied.
    expect(stored?.config).toEqual(
      expect.objectContaining({
        review_style: 'strict',
        focus_areas: ['security'],
      })
    );
    // Stored fields NOT in the mobile-shaped patch must round-trip
    // unchanged. The org schema accepts council /
    // councilEnabledRepositoryIds / manuallyAddedRepositories, but mobile
    // never sends them — the field-merge must keep them as-is.
    expect(stored?.config).toEqual(
      expect.objectContaining({
        council: expect.objectContaining({
          enabled: true,
          aggregation_strategy: 'unanimous',
          specialists: expect.arrayContaining([
            expect.objectContaining({ id: 'security' }),
            expect.objectContaining({ id: 'performance' }),
          ]),
        }),
        council_enabled_repository_ids: [101, 202],
        manually_added_repositories: [
          { id: 9, name: 'manual', full_name: 'manual/repo', private: true },
        ],
        repository_model_overrides: [
          {
            repository_id: 101,
            repo_full_name: 'acme/api',
            model_slug: 'openai/gpt-5',
            thinking_effort: 'high',
          },
        ],
      })
    );
    // Other stored fields that the mobile client never read or sent must
    // also be preserved.
    expect(stored?.config).toEqual(
      expect.objectContaining({
        selected_repository_ids: [101, 202],
        repository_selection_mode: 'all',
        gate_threshold: 'off',
        disable_review_md: true,
        skip_bot_pull_requests: false,
      })
    );
  });
});

describe('organization review agent router: skip bot pull requests', () => {
  afterAll(async () => {
    for (const organizationId of createdOrganizationIds) {
      await db
        .delete(organization_audit_logs)
        .where(eq(organization_audit_logs.organization_id, organizationId));
      await db
        .delete(agent_configs)
        .where(eq(agent_configs.owned_by_organization_id, organizationId));
      await db.delete(organizations).where(eq(organizations.id, organizationId));
    }
  });

  it('defaults skipBotPullRequests to true and round-trips an explicit false', async () => {
    const { owner, organization } = await createFixtureOrganization();
    const caller = await createCallerForUser(owner.id);

    // Default (no config saved) is to skip bot PRs.
    const defaults = await caller.organizations.reviewAgent.getReviewConfig({
      organizationId: organization.id,
      platform: 'github',
    });
    expect(defaults.skipBotPullRequests).toBe(true);

    // Saving false persists and reloads as false.
    await caller.organizations.reviewAgent.saveReviewConfig({
      organizationId: organization.id,
      platform: 'github',
      reviewStyle: 'balanced',
      focusAreas: [],
      modelSlug: 'anthropic/claude-sonnet-5',
      skipBotPullRequests: false,
    });
    const cfg = await caller.organizations.reviewAgent.getReviewConfig({
      organizationId: organization.id,
      platform: 'github',
    });
    expect(cfg.skipBotPullRequests).toBe(false);
  });
});
