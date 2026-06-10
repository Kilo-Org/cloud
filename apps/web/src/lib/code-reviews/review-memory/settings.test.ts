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

  it('defaults missing values to disabled and persists enabled settings', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };

    await expect(isReviewMemoryEnabled({ owner, platform: 'github' })).resolves.toBe(false);
    expect(getReviewMemoryEnabledFromConfig({ disable_review_md: true })).toBe(false);

    await setReviewMemoryEnabled({ owner, platform: 'github', enabled: true, createdBy: user.id });

    await expect(isReviewMemoryEnabled({ owner, platform: 'github' })).resolves.toBe(true);
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
});
