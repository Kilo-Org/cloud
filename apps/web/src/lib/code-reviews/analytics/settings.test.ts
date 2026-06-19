import { PRIMARY_DEFAULT_MODEL } from '@/lib/ai-gateway/models';
import { db } from '@/lib/drizzle';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { agent_configs, kilocode_users, organizations } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';

import {
  getReviewAnalyticsEnabledFromConfig,
  isReviewAnalyticsEnabled,
  setReviewAnalyticsEnabled,
} from './settings';

describe('Code Reviewer analytics settings', () => {
  it('treats missing and malformed settings as disabled', () => {
    expect(getReviewAnalyticsEnabledFromConfig(undefined)).toBe(false);
    expect(getReviewAnalyticsEnabledFromConfig(null)).toBe(false);
    expect(getReviewAnalyticsEnabledFromConfig([])).toBe(false);
    expect(getReviewAnalyticsEnabledFromConfig({})).toBe(false);
    expect(getReviewAnalyticsEnabledFromConfig({ review_analytics_enabled: 'true' })).toBe(false);
    expect(
      getReviewAnalyticsEnabledFromConfig({
        review_analytics_enabled: true,
        unrelated_setting: 'preserved',
      })
    ).toBe(true);
  });

  describe('database settings', () => {
    let userId: string;
    let organizationId: string;

    beforeAll(async () => {
      const user = await insertTestUser();
      const organization = await createTestOrganization(
        `Review Analytics Settings ${crypto.randomUUID()}`,
        user.id,
        0,
        {},
        false
      );
      userId = user.id;
      organizationId = organization.id;
    });

    afterEach(async () => {
      await db
        .delete(agent_configs)
        .where(
          and(
            eq(agent_configs.agent_type, 'code_review'),
            eq(agent_configs.owned_by_organization_id, organizationId)
          )
        );
    });

    afterAll(async () => {
      await db.delete(organizations).where(eq(organizations.id, organizationId));
      await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
    });

    it('inserts a complete main-disabled Code Reviewer config for a missing row', async () => {
      const owner = { type: 'org' as const, id: organizationId };

      await expect(isReviewAnalyticsEnabled({ owner, platform: 'github' })).resolves.toBe(false);
      await expect(
        setReviewAnalyticsEnabled({
          owner,
          platform: 'github',
          enabled: true,
          createdBy: userId,
        })
      ).resolves.toBe(true);

      const stored = await db.query.agent_configs.findFirst({
        where: and(
          eq(agent_configs.agent_type, 'code_review'),
          eq(agent_configs.platform, 'github'),
          eq(agent_configs.owned_by_organization_id, organizationId)
        ),
      });

      expect(stored?.is_enabled).toBe(false);
      expect(stored?.config).toEqual({
        review_style: 'balanced',
        focus_areas: [],
        custom_instructions: null,
        model_slug: PRIMARY_DEFAULT_MODEL,
        thinking_effort: null,
        gate_threshold: 'off',
        repository_selection_mode: 'all',
        selected_repository_ids: [],
        manually_added_repositories: [],
        disable_review_md: true,
        review_memory_enabled: false,
        review_analytics_enabled: true,
      });
    });

    it('atomically updates only analytics state on an existing row', async () => {
      const owner = { type: 'org' as const, id: organizationId };
      await db.insert(agent_configs).values({
        owned_by_organization_id: organizationId,
        agent_type: 'code_review',
        platform: 'github',
        config: {
          review_memory_enabled: true,
          unrelated_setting: { nested: 'value' },
        },
        is_enabled: true,
        created_by: userId,
      });

      await expect(
        setReviewAnalyticsEnabled({
          owner,
          platform: 'github',
          enabled: true,
          createdBy: userId,
        })
      ).resolves.toBe(true);
      await expect(
        setReviewAnalyticsEnabled({
          owner,
          platform: 'github',
          enabled: false,
          createdBy: userId,
        })
      ).resolves.toBe(false);

      const stored = await db.query.agent_configs.findFirst({
        where: and(
          eq(agent_configs.agent_type, 'code_review'),
          eq(agent_configs.platform, 'github'),
          eq(agent_configs.owned_by_organization_id, organizationId)
        ),
      });

      expect(stored?.is_enabled).toBe(true);
      expect(stored?.config).toEqual({
        review_memory_enabled: true,
        review_analytics_enabled: false,
        unrelated_setting: { nested: 'value' },
      });
    });

    it('looks up analytics state by owner and platform', async () => {
      const organizationOwner = { type: 'org' as const, id: organizationId };

      await setReviewAnalyticsEnabled({
        owner: organizationOwner,
        platform: 'gitlab',
        enabled: true,
        createdBy: userId,
      });

      await expect(
        isReviewAnalyticsEnabled({ owner: organizationOwner, platform: 'gitlab' })
      ).resolves.toBe(true);
      await expect(
        isReviewAnalyticsEnabled({ owner: organizationOwner, platform: 'github' })
      ).resolves.toBe(false);
    });
  });
});
