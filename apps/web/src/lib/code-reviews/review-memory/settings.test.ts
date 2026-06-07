/* eslint-disable drizzle/enforce-delete-with-where */
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { agent_configs, kilocode_users } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import {
  getReviewMemoryEnabledFromConfig,
  isReviewMemoryEnabled,
  setReviewMemoryEnabled,
} from './settings';

describe('review memory settings', () => {
  afterEach(async () => {
    await db.delete(agent_configs);
    await db.delete(kilocode_users);
  });

  it('defaults missing and partial config values to disabled', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };

    await expect(isReviewMemoryEnabled({ owner, platform: 'github' })).resolves.toBe(false);
    expect(getReviewMemoryEnabledFromConfig({ disable_review_md: true })).toBe(false);
    expect(getReviewMemoryEnabledFromConfig({ review_memory_enabled: true })).toBe(true);
    expect(getReviewMemoryEnabledFromConfig({ review_memory_enabled: false })).toBe(false);
  });

  it('creates a memory-only config without enabling Code Reviewer', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };

    await setReviewMemoryEnabled({ owner, platform: 'github', enabled: true, createdBy: user.id });

    const config = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.agent_type, 'code_review'),
        eq(agent_configs.platform, 'github'),
        eq(agent_configs.owned_by_user_id, user.id)
      ),
    });

    expect(config?.is_enabled).toBe(false);
    expect(config?.config).toEqual(expect.objectContaining({ review_memory_enabled: true }));
  });

  it('preserves existing partial config fields when toggling', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    await db.insert(agent_configs).values({
      owned_by_user_id: user.id,
      agent_type: 'code_review',
      platform: 'github',
      config: { disable_review_md: true, custom_partial_flag: 'kept' },
      is_enabled: true,
      created_by: user.id,
    });

    await setReviewMemoryEnabled({ owner, platform: 'github', enabled: true, createdBy: user.id });

    const config = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.agent_type, 'code_review'),
        eq(agent_configs.platform, 'github'),
        eq(agent_configs.owned_by_user_id, user.id)
      ),
    });

    expect(config?.is_enabled).toBe(true);
    expect(config?.config).toEqual(
      expect.objectContaining({
        custom_partial_flag: 'kept',
        disable_review_md: true,
        review_memory_enabled: true,
      })
    );
  });
});
