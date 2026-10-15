import { and, eq } from 'drizzle-orm';
import { db, cleanupDbForTest } from '@kilocode/web-shared/lib/drizzle';
import {
  agent_briefing_events,
  agent_briefing_preferences,
  agent_briefing_context_preferences,
  agent_briefing_reports,
  cli_sessions_v2,
  microdollar_usage,
  microdollar_usage_metadata,
  organization_memberships,
  organizations,
  type User,
} from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { collectBriefingEvidence } from '@/lib/agent-briefing/evidence';
import { emptySummary } from '@/lib/agent-briefing/store';
import { reconcileBriefingCharge } from '@/lib/agent-briefing/summary';
import { sweepAgentBriefings } from '@/lib/agent-briefing/sweep';
import { agentBriefingRouter } from './agent-briefing-router';
import { dispatchAgentBriefingPush } from '@kilocode/web-shared/lib/notifications-worker-client';

jest.mock('@kilocode/web-shared/lib/notifications-worker-client', () => ({
  dispatchAgentBriefingPush: jest.fn().mockResolvedValue(true),
}));
let user: User;
let other: User;
let organizationId: string;
let sessionSequence = 0;
beforeEach(async () => {
  await cleanupDbForTest();
  user = await insertTestUser({ id: 'oauth/briefing-owner', is_admin: false });
  other = await insertTestUser({ id: 'oauth/briefing-other', is_admin: false });
  organizationId = crypto.randomUUID();
  await db.insert(organizations).values({
    id: organizationId,
    name: 'Briefing organization',
    created_by_kilo_user_id: user.id,
  });
  await db
    .insert(organization_memberships)
    .values({ organization_id: organizationId, kilo_user_id: user.id, role: 'member' });
});
async function seedReport(organization: string | null = null, count = 1) {
  const now = Date.now();
  const start = new Date(now - 12 * 3600_000).toISOString();
  const cutoff = new Date(now - 30 * 60_000).toISOString();
  const end = new Date(now + 3 * 3600_000).toISOString();
  const sessionIds: string[] = [];
  for (let index = 0; index < count; index++) {
    const sessionId = `ses_briefing_${sessionSequence++}`;
    sessionIds.push(sessionId);
    await db.insert(cli_sessions_v2).values({
      session_id: sessionId,
      kilo_user_id: user.id,
      organization_id: organization,
      title: 'Verified activity',
      created_on_platform: 'cli',
    });
    await db.insert(agent_briefing_events).values({
      id: crypto.randomUUID(),
      session_id: sessionId,
      kilo_user_id: user.id,
      organization_id: organization,
      kind: 'activity',
      occurred_at: new Date(now - 3600_000).toISOString(),
    });
  }
  const facts = await collectBriefingEvidence(user.id, organization, start, cutoff, end);
  const [report] = await db
    .insert(agent_briefing_reports)
    .values({
      kilo_user_id: user.id,
      context_key: organization ?? 'personal',
      organization_id: organization,
      local_date: cutoff.slice(0, 10),
      night_start_at: start,
      cutoff_at: cutoff,
      morning_end_at: end,
      facts,
      evidence_hash: 'initial-evidence',
      summary: emptySummary,
      published_at: new Date().toISOString(),
    })
    .returning();
  if (!report) throw new Error('Report fixture was not inserted');
  return { report, sessionIds };
}
describe('agent briefing ownership and lifecycle', () => {
  it('distinguishes Personal, organization and all report scopes and denies another user', async () => {
    const personal = await seedReport();
    const org = await seedReport(organizationId);
    const caller = agentBriefingRouter.createCaller({ user });
    expect((await caller.list({ scope: 'personal' })).reports.map(report => report.id)).toEqual([
      personal.report.id,
    ]);
    expect(
      (await caller.list({ scope: 'organization', organizationId })).reports.map(
        report => report.id
      )
    ).toEqual([org.report.id]);
    expect((await caller.list({ scope: 'all' })).reports).toHaveLength(2);
    await expect(
      agentBriefingRouter.createCaller({ user: other }).get({ reportId: personal.report.id })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await db
      .delete(organization_memberships)
      .where(eq(organization_memberships.kilo_user_id, user.id));
    await expect(caller.get({ reportId: org.report.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect((await caller.list({ scope: 'all' })).reports).toHaveLength(1);
  });
  it('persists dismissal/read state across callers and serializes PostgreSQL timestamps', async () => {
    const { report } = await seedReport();
    const caller = agentBriefingRouter.createCaller({ user });
    await caller.dismiss({ reportId: report.id });
    await caller.read({ reportId: report.id });
    const reread = await agentBriefingRouter.createCaller({ user }).get({ reportId: report.id });
    expect(reread.dismissedAt).toMatch(/Z$/);
    expect(reread.readAt).toMatch(/Z$/);
    expect(reread.cutoffAt).toBe(new Date(report.cutoff_at).toISOString());
    expect(reread.coverage.spend).toBe('unavailable');
  });
  it('reports complete coverage once collection predates the night and all spend is attributed', async () => {
    const { report, sessionIds } = await seedReport();
    const sessionId = sessionIds[0];
    if (!sessionId) throw new Error('Missing source fixture');
    const usageId = crypto.randomUUID();
    await db.insert(microdollar_usage).values({
      id: usageId,
      kilo_user_id: user.id,
      cost: 290_000,
      input_tokens: 10,
      output_tokens: 10,
      cache_write_tokens: 0,
      cache_hit_tokens: 0,
      created_at: new Date(Date.now() - 3600_000).toISOString(),
    });
    await db
      .insert(microdollar_usage_metadata)
      .values({ id: usageId, session_id: sessionId, message_id: 'overnight-charge' });
    const collect = () =>
      collectBriefingEvidence(
        user.id,
        null,
        report.night_start_at,
        report.cutoff_at,
        report.morning_end_at
      );
    expect((await collect()).coverage).toEqual({
      activity: 'partial',
      spend: 'partial',
      blockers: 'partial',
      pullRequests: 'partial',
    });
    await db.insert(agent_briefing_preferences).values({
      kilo_user_id: user.id,
      timezone: 'UTC',
      next_run_at: new Date().toISOString(),
      created_at: new Date(Date.parse(report.night_start_at) - 3600_000).toISOString(),
    });
    const facts = await collect();
    expect(facts.coverage).toEqual({
      activity: 'complete',
      spend: 'complete',
      blockers: 'complete',
      pullRequests: 'complete',
    });
    expect(facts.scorecard.spendMicrodollars).toBe(290_000);
  });
  it.each(['ready', 'running'] as const)(
    'clears %s AI content when the sweep removes a deleted source before a read',
    async status => {
      const { report, sessionIds } = await seedReport(null, 2);
      await db
        .update(agent_briefing_reports)
        .set({
          summary: {
            ...emptySummary,
            status,
            text: status === 'ready' ? 'Private deleted outcome' : null,
          },
          generation_id: status === 'running' ? 'agent-briefing:deleted-source' : null,
          generation_deadline_at: new Date(Date.now() + 600_000).toISOString(),
        })
        .where(eq(agent_briefing_reports.id, report.id));
      const [deletedSessionId, retainedSessionId] = sessionIds;
      if (!deletedSessionId || !retainedSessionId) throw new Error('Missing source fixtures');
      await db
        .delete(cli_sessions_v2)
        .where(
          and(
            eq(cli_sessions_v2.session_id, deletedSessionId),
            eq(cli_sessions_v2.kilo_user_id, user.id)
          )
        );
      await sweepAgentBriefings();
      const [swept] = await db
        .select()
        .from(agent_briefing_reports)
        .where(eq(agent_briefing_reports.id, report.id));
      expect(swept.summary).toMatchObject({ status: 'outdated', text: null, canRetry: false });
      const reread = await agentBriefingRouter.createCaller({ user }).get({ reportId: report.id });
      expect(reread.sessions.map(session => session.sessionId)).toEqual([retainedSessionId]);
      expect(reread.summary.text).toBeNull();
      expect(reread.summary.status).toBe('outdated');
      expect(reread.revised).toBe(true);
    }
  );
  it('clears Personal AI text when a source moves into an organization before the sweep', async () => {
    const { report, sessionIds } = await seedReport(null, 2);
    const movedSessionId = sessionIds[0];
    if (!movedSessionId) throw new Error('Missing source fixture');
    await db
      .update(agent_briefing_reports)
      .set({ summary: { ...emptySummary, status: 'ready', text: 'Private moved outcome' } })
      .where(eq(agent_briefing_reports.id, report.id));
    await db
      .update(cli_sessions_v2)
      .set({ organization_id: organizationId })
      .where(
        and(
          eq(cli_sessions_v2.session_id, movedSessionId),
          eq(cli_sessions_v2.kilo_user_id, user.id)
        )
      );
    await sweepAgentBriefings();
    const reportAfterSweep = await agentBriefingRouter
      .createCaller({ user })
      .get({ reportId: report.id });
    expect(reportAfterSweep.sessions.some(session => session.sessionId === movedSessionId)).toBe(
      false
    );
    expect(reportAfterSweep.summary).toMatchObject({ status: 'outdated', text: null });
  });
  it('keeps an existing frozen window when timezone and schedule preferences change', async () => {
    const { report } = await seedReport();
    const caller = agentBriefingRouter.createCaller({ user });
    await caller.updatePreferences({
      timezone: 'America/New_York',
      nightStart: '00:00',
      morningStart: '08:00',
      morningEnd: '12:00',
    });
    const reread = await caller.get({ reportId: report.id });
    expect(reread.nightStartAt).toBe(new Date(report.night_start_at).toISOString());
    expect(reread.cutoffAt).toBe(new Date(report.cutoff_at).toISOString());
    expect(reread.morningEndAt).toBe(new Date(report.morning_end_at).toISOString());
  });
  it('selects the same source-ordered historical baseline that aggregation uses for equal timestamps', async () => {
    const { report, sessionIds } = await seedReport();
    const sessionId = sessionIds[0];
    if (!sessionId) throw new Error('Missing source fixture');
    const occurredAt = new Date(Date.parse(report.night_start_at) - 1).toISOString();
    const base = {
      kilo_user_id: user.id,
      session_id: sessionId,
      kind: 'status',
      occurred_at: occurredAt,
    };
    await db.insert(agent_briefing_events).values([
      { ...base, id: 'zz-legacy-baseline', status: 'retry', payload: null },
      {
        ...base,
        id: 'zz-older-transition',
        status: 'busy',
        payload: {
          previousStatus: 'idle',
          previousStatusKnown: true,
          transitionId: '01ARZ3NDEKTSV4RRFFQ69G5FA1',
        },
      },
      {
        ...base,
        id: 'aa-latest-transition',
        status: 'question',
        payload: {
          previousStatus: 'busy',
          previousStatusKnown: true,
          transitionId: '01ARZ3NDEKTSV4RRFFQ69G5FA2',
        },
      },
    ]);
    const facts = await collectBriefingEvidence(
      user.id,
      null,
      report.night_start_at,
      report.cutoff_at,
      report.morning_end_at
    );
    expect(facts.sessions[0]?.status).toBe('question');
    expect(facts.scorecard.blockers).toBe(0);
  });
  it('finalizes evidence at morning end and excludes events recorded afterwards', async () => {
    const { report, sessionIds } = await seedReport();
    const sessionId = sessionIds[0];
    if (!sessionId) throw new Error('Missing source fixture');
    const end = new Date();
    await db
      .update(agent_briefing_reports)
      .set({ morning_end_at: end.toISOString(), next_refresh_at: end.toISOString() })
      .where(eq(agent_briefing_reports.id, report.id));
    await sweepAgentBriefings(end);
    const initial = await agentBriefingRouter.createCaller({ user }).get({ reportId: report.id });
    await db.insert(agent_briefing_events).values({
      id: 'after-morning',
      kilo_user_id: user.id,
      session_id: sessionId,
      kind: 'activity',
      occurred_at: new Date(end.getTime() - 3600_000).toISOString(),
      recorded_at: new Date(end.getTime() + 1000).toISOString(),
    });
    await sweepAgentBriefings(new Date(end.getTime() + 120_000));
    const final = await agentBriefingRouter.createCaller({ user }).get({ reportId: report.id });
    expect(final.revision).toBe(initial.revision);
    expect(final.sources.some(source => source.id === 'after-morning')).toBe(false);
    expect(
      (await agentBriefingRouter.createCaller({ user }).list({ currentOnly: true })).reports
    ).toHaveLength(0);
  });
  it('requires estimate consent and finite per-context safeguards before paid generation', async () => {
    const caller = agentBriefingRouter.createCaller({ user });
    await expect(caller.updateContextPreferences({ aiEnabled: true })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    for (const maxSpendMicrodollars of [0, -1, Infinity, NaN])
      await expect(caller.estimateSummary({ maxSpendMicrodollars })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    await expect(
      caller.updateContextPreferences({ aiEnabled: false, maxDurationSeconds: 601 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const { report } = await seedReport();
    await expect(
      caller.retrySummary({ reportId: report.id, estimateToken: 'not-consent' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('publishes after five minutes waiting while generation remains running', async () => {
    const { report } = await seedReport();
    const now = new Date();
    await db
      .update(agent_briefing_reports)
      .set({
        published_at: null,
        generation_id: 'agent-briefing:waiting',
        generation_deadline_at: new Date(now.getTime() + 60_000).toISOString(),
        next_refresh_at: now.toISOString(),
        summary: {
          ...emptySummary,
          status: 'running',
          chargeStatus: 'pending',
          waitStartedAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
        },
      })
      .where(eq(agent_briefing_reports.id, report.id));
    await sweepAgentBriefings(now);
    const result = await agentBriefingRouter.createCaller({ user }).get({ reportId: report.id });
    expect(result.publishedAt).not.toBeNull();
    expect(result.summary.status).toBe('running');
    expect(result.summary.chargeStatus).toBe('pending');
  });
  it('publishes late eligible structured facts and closes unstarted AI when morning ends before five minutes', async () => {
    const { report } = await seedReport();
    const now = new Date();
    const end = new Date(now.getTime() + 30_000);
    await db.insert(agent_briefing_context_preferences).values({
      kilo_user_id: user.id,
      context_key: 'personal',
      model: 'test/bounded',
      ai_enabled: true,
    });
    await db
      .update(agent_briefing_reports)
      .set({
        published_at: null,
        morning_end_at: end.toISOString(),
        next_refresh_at: now.toISOString(),
      })
      .where(eq(agent_briefing_reports.id, report.id));
    jest.mocked(dispatchAgentBriefingPush).mockClear();
    await sweepAgentBriefings(now);
    const waiting = await agentBriefingRouter.createCaller({ user }).get({ reportId: report.id });
    expect(waiting.publishedAt).toBeNull();
    expect(waiting.summary.status).toBe('pending');
    await sweepAgentBriefings(new Date(now.getTime() + 60_000));
    const closed = await agentBriefingRouter.createCaller({ user }).get({ reportId: report.id });
    expect(closed.publishedAt).not.toBeNull();
    expect(closed.summary).toMatchObject({
      status: 'unavailable',
      error: 'time_limit',
      chargeStatus: 'settled',
      canRetry: false,
    });
    expect(
      (await agentBriefingRouter.createCaller({ user }).list({ scope: 'personal' })).reports
    ).toHaveLength(1);
    expect(jest.mocked(dispatchAgentBriefingPush)).not.toHaveBeenCalled();
    const [persisted] = await db
      .select()
      .from(agent_briefing_reports)
      .where(eq(agent_briefing_reports.id, report.id));
    expect(persisted.next_refresh_at).toBeNull();
    expect(persisted.generation_id).toBeNull();
  });
  it('reconciles delayed real ledger rows without clobbering summary state and enables only billable retry', async () => {
    const { report } = await seedReport();
    const generationId = `agent-briefing:${crypto.randomUUID()}`;
    const [failed] = await db
      .update(agent_briefing_reports)
      .set({
        generation_id: generationId,
        summary: { ...emptySummary, status: 'failed', chargeStatus: 'pending' },
      })
      .where(eq(agent_briefing_reports.id, report.id))
      .returning();
    if (!failed) throw new Error('Failed fixture was not inserted');
    expect((await reconcileBriefingCharge(failed)).summary.canRetry).toBe(false);
    const usageId = crypto.randomUUID();
    await db.insert(microdollar_usage).values({
      id: usageId,
      kilo_user_id: user.id,
      cost: 12345,
      input_tokens: 10,
      output_tokens: 10,
      cache_write_tokens: 0,
      cache_hit_tokens: 0,
    });
    await db
      .insert(microdollar_usage_metadata)
      .values({ id: usageId, session_id: generationId, message_id: 'billable-failure' });
    const reconciled = await reconcileBriefingCharge(failed);
    expect(reconciled.summary).toMatchObject({
      status: 'failed',
      chargeStatus: 'settled',
      costMicrodollars: 12345,
      canRetry: true,
    });
    expect(reconciled.next_charge_check_at).toBeNull();
    expect(
      (
        await collectBriefingEvidence(
          user.id,
          null,
          new Date(Date.now() - 86400_000).toISOString(),
          new Date().toISOString()
        )
      ).scorecard.spendMicrodollars
    ).toBe(0);
  });
});
