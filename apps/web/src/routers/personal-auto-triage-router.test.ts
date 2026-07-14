import { db } from '@/lib/drizzle';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { agent_configs } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';

describe('personalAutoTriage.saveAutoTriageConfig', () => {
  it('enables a fresh config when issue triage is enabled', async () => {
    const user = await insertTestUser();
    const caller = await createCallerForUser(user.id);

    await caller.personalAutoTriage.saveAutoTriageConfig({
      enabled_for_issues: true,
      repository_selection_mode: 'all',
    });

    const config = await db.query.agent_configs.findFirst({
      where: and(
        eq(agent_configs.agent_type, 'auto_triage'),
        eq(agent_configs.platform, 'github'),
        eq(agent_configs.owned_by_user_id, user.id)
      ),
    });

    expect(config?.is_enabled).toBe(true);
  });
});
