import { eq } from 'drizzle-orm';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import {
  agent_briefing_snapshots,
  agent_briefing_preferences,
  cli_sessions_v2,
  organization_memberships,
} from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { buildBriefingSnapshot } from './evidence';
import {
  emptySummary,
  getBriefingPreferences,
  getBriefingReport,
  listBriefings,
  saveBriefingPreferences,
} from './store';

beforeEach(cleanupDbForTest);
async function fixture(organization = false) {
  const user = await insertTestUser();
  const org = organization ? await createTestOrganization('Snapshot context', user.id, 0) : null;
  const captured = new Date().toISOString();
  const [session] = await db
    .insert(cli_sessions_v2)
    .values({
      session_id: `ses_${crypto.randomUUID()}`,
      kilo_user_id: user.id,
      organization_id: org?.id ?? null,
      title: 'Captured title',
      status: 'idle',
      last_activity_at: captured,
    })
    .returning();
  if (!session) throw new Error('Missing session fixture');
  const facts = buildBriefingSnapshot([session]);
  const [row] = await db
    .insert(agent_briefing_snapshots)
    .values({
      kilo_user_id: user.id,
      context_key: org?.id ?? 'personal',
      organization_id: org?.id ?? null,
      timezone: 'UTC',
      language: 'en',
      local_date: captured.slice(0, 10),
      night_start_at: captured,
      cutoff_at: captured,
      morning_end_at: new Date(Date.now() + 3600_000).toISOString(),
      captured_at: captured,
      published_at: captured,
      expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
      facts,
      summary: { ...emptySummary, status: 'ready', text: 'Captured private summary' },
    })
    .returning();
  if (!row) throw new Error('Missing snapshot fixture');
  return { user, org, session, row };
}
it('reads defaults without creating or mutating scheduling preferences', async () => {
  const user = await insertTestUser();
  const defaults = await getBriefingPreferences(user.id, 'Europe/Berlin', 'de');
  expect(defaults.contexts.every(context => !context.enabled)).toBe(true);
  expect(await db.select().from(agent_briefing_preferences)).toHaveLength(0);
  await saveBriefingPreferences(user.id, { timezone: 'UTC', language: 'en' });
  const before = await db.select().from(agent_briefing_preferences);
  await getBriefingPreferences(user.id, 'Europe/Berlin', 'de');
  expect(await db.select().from(agent_briefing_preferences)).toEqual(before);
  expect(before[0]?.next_run_at).toBeDefined();
});
it('preserves captured facts on reads when live metadata changes', async () => {
  const { user, session, row } = await fixture();
  await db
    .update(cli_sessions_v2)
    .set({
      title: 'Later title',
      status: 'error',
      briefing_excerpt: {
        messageId: 'later',
        completedAt: new Date().toISOString(),
        text: 'Later response',
      },
    })
    .where(eq(cli_sessions_v2.session_id, session.session_id));
  const report = await getBriefingReport(user.id, row.id);
  expect(report.sessions[0]?.title).toBe('Captured title');
  expect(report.sessions[0]?.status).toBe('idle');
  expect(report.capturedAt).toBe(new Date(row.captured_at).toISOString());
  expect((await db.select().from(agent_briefing_snapshots))[0]?.facts).toEqual(row.facts);
});
it.each(['delete', 'move'] as const)(
  'refuses an entire immutable report after source %s without refreshing facts',
  async action => {
    const { user, session, row } = await fixture();
    if (action === 'delete')
      await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, session.session_id));
    else {
      const org = await createTestOrganization('Other context', user.id, 0);
      await db
        .update(cli_sessions_v2)
        .set({ organization_id: org.id })
        .where(eq(cli_sessions_v2.session_id, session.session_id));
    }
    await expect(getBriefingReport(user.id, row.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await listBriefings(user.id)).reports).toEqual([]);
    expect((await db.select().from(agent_briefing_snapshots))[0]?.facts).toEqual(row.facts);
  }
);
it('rejects membership revocation before disclosing summary or evidence', async () => {
  const { user, org, row } = await fixture(true);
  if (!org) throw new Error('Missing organization');
  await db
    .delete(organization_memberships)
    .where(eq(organization_memberships.organization_id, org.id));
  await expect(getBriefingReport(user.id, row.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect((await listBriefings(user.id)).reports).toEqual([]);
});
it('retains history after the morning window but refuses expired and foreign-owner reports', async () => {
  const { user, row } = await fixture();
  await db
    .update(agent_briefing_snapshots)
    .set({ morning_end_at: new Date(Date.now() - 3600_000).toISOString() })
    .where(eq(agent_briefing_snapshots.id, row.id));
  expect((await listBriefings(user.id)).reports).toHaveLength(1);
  expect((await listBriefings(user.id, { currentOnly: true })).reports).toHaveLength(0);
  const other = await insertTestUser();
  await expect(getBriefingReport(other.id, row.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await db
    .update(agent_briefing_snapshots)
    .set({ expires_at: new Date(Date.now() - 1).toISOString() })
    .where(eq(agent_briefing_snapshots.id, row.id));
  await expect(getBriefingReport(user.id, row.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

it('refuses stale captured evidence after a source moves away and back to the same context', async () => {
  const { user, session, row } = await fixture();
  const org = await createTestOrganization('Temporary context', user.id, 0);
  const boundary = new Date(Date.parse(row.captured_at) + 1000).toISOString();
  await db
    .update(cli_sessions_v2)
    .set({ organization_id: org.id, briefing_excerpt_scope_changed_at: boundary })
    .where(eq(cli_sessions_v2.session_id, session.session_id));
  await db
    .update(cli_sessions_v2)
    .set({ organization_id: null })
    .where(eq(cli_sessions_v2.session_id, session.session_id));
  await expect(getBriefingReport(user.id, row.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect((await listBriefings(user.id)).reports).toEqual([]);
  expect((await db.select().from(agent_briefing_snapshots))[0]?.facts).toEqual(row.facts);
});

it('authorizes a bounded report page with one context query and one batched source query', async () => {
  const { user, row } = await fixture();
  await db.insert(agent_briefing_snapshots).values({
    ...row,
    id: crypto.randomUUID(),
    local_date: 'previous-occurrence',
    cutoff_at: new Date(Date.parse(row.cutoff_at) - 86400_000).toISOString(),
  });
  const select = jest.spyOn(db, 'select');
  try {
    expect((await listBriefings(user.id)).reports).toHaveLength(2);
    expect(select).toHaveBeenCalledTimes(3);
    select.mockClear();
    await getBriefingReport(user.id, row.id);
    expect(select).toHaveBeenCalledTimes(3);
  } finally {
    select.mockRestore();
  }
});

it('does not authorize a source in another accessible context through the batched owner lookup', async () => {
  const { user, row } = await fixture();
  const org = await createTestOrganization('Other accessible context', user.id, 0);
  await db.insert(agent_briefing_snapshots).values({
    ...row,
    id: crypto.randomUUID(),
    context_key: org.id,
    organization_id: org.id,
  });
  const listed = await listBriefings(user.id);
  expect(listed.reports.map(report => report.id)).toEqual([row.id]);
});

it('excludes quiet snapshots before limiting current reports while retaining quiet history', async () => {
  const { user, row } = await fixture();
  const [quiet] = await db
    .insert(agent_briefing_snapshots)
    .values({
      ...row,
      id: crypto.randomUUID(),
      local_date: 'quiet-occurrence',
      cutoff_at: new Date(Date.parse(row.cutoff_at) + 1000).toISOString(),
      facts: buildBriefingSnapshot([]),
      summary: { ...emptySummary, status: 'unavailable' },
    })
    .returning();
  if (!quiet) throw new Error('Missing quiet report');
  expect(
    (await listBriefings(user.id, { currentOnly: true, limit: 1 })).reports.map(report => report.id)
  ).toEqual([row.id]);
  expect((await listBriefings(user.id, { limit: 2 })).reports.map(report => report.id)).toEqual([
    quiet.id,
    row.id,
  ]);
});
