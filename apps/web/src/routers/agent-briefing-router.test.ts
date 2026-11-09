import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import {
  agent_briefing_context_preferences,
  agent_briefing_preferences,
  cli_sessions_v2,
  organization_memberships,
} from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { eq } from 'drizzle-orm';
import { agentBriefingRouter } from './agent-briefing-router';

beforeEach(cleanupDbForTest);
it('reads context settings without opting in or initializing a schedule', async () => {
  const user = await insertTestUser();
  const preferences = await agentBriefingRouter
    .createCaller({ user })
    .preferences({ timezone: 'Europe/Berlin', language: 'de' });
  expect(preferences.timezone).toBe('Europe/Berlin');
  expect(preferences.contexts[0]?.enabled).toBe(false);
  expect(await db.select().from(agent_briefing_preferences)).toHaveLength(0);
  expect(await db.select().from(agent_briefing_context_preferences)).toHaveLength(0);
});
it('schedules only through an explicit settings mutation and validates the whole overnight window', async () => {
  const user = await insertTestUser();
  const caller = agentBriefingRouter.createCaller({ user });
  await expect(
    caller.updatePreferences({ nightStart: '08:00', morningStart: '08:00' })
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(await db.select().from(agent_briefing_preferences)).toHaveLength(0);
  await caller.updatePreferences({
    timezone: 'UTC',
    nightStart: '22:00',
    morningStart: '08:00',
    morningEnd: '12:00',
  });
  const [row] = await db.select().from(agent_briefing_preferences);
  expect(new Date(row?.next_run_at ?? '').getUTCHours()).toBe(8);
});
it('requires a reviewed cost disclosure before enabling a paid scheduled context', async () => {
  const user = await insertTestUser();
  await expect(
    agentBriefingRouter.createCaller({ user }).updateContextPreferences({ enabled: true })
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(await db.select().from(agent_briefing_context_preferences)).toHaveLength(0);
});
it('disables only the chosen context and clears live excerpts without changing source scope', async () => {
  const user = await insertTestUser();
  const org = await createTestOrganization('Separate scope', user.id, 0);
  const completedAt = new Date(Date.now() - 60_000).toISOString();
  await db.insert(agent_briefing_context_preferences).values([
    { kilo_user_id: user.id, context_key: 'personal', enabled: true, model: 'test/model' },
    {
      kilo_user_id: user.id,
      context_key: org.id,
      organization_id: org.id,
      enabled: true,
      model: 'test/model',
    },
  ]);
  await db.insert(cli_sessions_v2).values([
    {
      session_id: 'ses_personal',
      kilo_user_id: user.id,
      briefing_excerpt: { messageId: 'done', completedAt, text: 'Personal final' },
    },
    {
      session_id: 'ses_org',
      kilo_user_id: user.id,
      organization_id: org.id,
      briefing_excerpt: { messageId: 'done', completedAt, text: 'Organization final' },
    },
  ]);
  await agentBriefingRouter.createCaller({ user }).updateContextPreferences({ enabled: false });
  const sessions = await db.select().from(cli_sessions_v2);
  expect(
    sessions.find(session => session.session_id === 'ses_personal')?.briefing_excerpt
  ).toBeNull();
  expect(
    sessions.find(session => session.session_id === 'ses_personal')
      ?.briefing_excerpt_scope_changed_at
  ).toBeNull();
  expect(sessions.find(session => session.session_id === 'ses_org')?.briefing_excerpt?.text).toBe(
    'Organization final'
  );
  const settings = await db.select().from(agent_briefing_context_preferences);
  expect(settings.find(setting => setting.context_key === org.id)?.enabled).toBe(true);
  expect(settings.find(setting => setting.context_key === 'personal')?.enabled).toBe(false);
});
it('refuses context settings after membership revocation', async () => {
  const user = await insertTestUser();
  const org = await createTestOrganization('Revoked scope', user.id, 0);
  await db
    .delete(organization_memberships)
    .where(eq(organization_memberships.organization_id, org.id));
  await expect(
    agentBriefingRouter
      .createCaller({ user })
      .updateContextPreferences({ organizationId: org.id, enabled: false })
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
