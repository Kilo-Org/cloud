import { and, eq, sql } from 'drizzle-orm';
import { after } from 'next/server';
import type * as NextServer from 'next/server';
import { db, cleanupDbForTest } from '@kilocode/web-shared/lib/drizzle';
import {
  agent_briefing_context_preferences,
  agent_briefing_events,
  agent_briefing_preferences,
  agent_briefing_reports,
  cli_sessions_v2,
  kilocode_users,
  microdollar_usage,
  microdollar_usage_metadata,
  organization_memberships,
  organizations,
  type User,
} from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { dispatchAgentBriefingPush } from '@kilocode/web-shared/lib/notifications-worker-client';
import { resolveOrganizationMemberModelDecision } from '@kilocode/web-shared/lib/organizations/effective-model-access.server';
import { reconcileBriefingCharge, runBriefingSummary } from '@/lib/agent-briefing/summary';
import { sweepAgentBriefings } from '@/lib/agent-briefing/sweep';
import { agentBriefingRouter } from './agent-briefing-router';

jest.mock('next/server', () => ({
  ...jest.requireActual<typeof NextServer>('next/server'),
  after: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/notifications-worker-client', () => ({
  dispatchAgentBriefingPush: jest.fn().mockResolvedValue(true),
}));
jest.mock('@kilocode/web-shared/lib/organizations/effective-model-access.server', () => ({
  resolveOrganizationMemberModelDecision: jest
    .fn()
    .mockResolvedValue({ decision: { allowed: true } }),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  getOpenRouterModelsMetadataFromDatabase: jest.fn().mockResolvedValue({
    'test/bounded': {
      id: 'test/bounded',
      name: 'Bounded test model',
      endpoints: [{ pricing: { prompt: '0.000001', completion: '0.000002', request: '0' } }],
    },
  }),
}));

let user: User;
let other: User;
let organizationId: string;
beforeEach(async () => {
  await cleanupDbForTest();
  jest.clearAllMocks();
  user = await insertTestUser({
    id: 'oauth/one-off-owner',
    total_microdollars_acquired: 100_000_000,
  });
  other = await insertTestUser({ id: 'oauth/one-off-other' });
  organizationId = crypto.randomUUID();
  await db.insert(organizations).values({
    id: organizationId,
    name: 'One-off organization',
    created_by_kilo_user_id: user.id,
    total_microdollars_acquired: 100_000_000,
  });
  await db.insert(organization_memberships).values({
    organization_id: organizationId,
    kilo_user_id: user.id,
    role: 'member',
  });
  await db.insert(agent_briefing_context_preferences).values({
    kilo_user_id: user.id,
    context_key: 'personal',
    model: 'test/bounded',
    ai_enabled: false,
  });
});
afterEach(() => jest.restoreAllMocks());

type OneOffPeriod = {
  requestId: string;
  startAt: string;
  endAt: string;
  timezone: string;
  language: string;
};
function period(daysAgo = 1) {
  const end = Date.now() - daysAgo * 86400_000;
  return {
    requestId: crypto.randomUUID(),
    startAt: new Date(end - 86400_000).toISOString(),
    endAt: new Date(end).toISOString(),
    timezone: 'Europe/Belgrade',
    language: 'sr',
  };
}
async function seedActivity(input: OneOffPeriod, organization: string | null = null) {
  const sessionId = `ses_one_off_${crypto.randomUUID()}`;
  const eventId = crypto.randomUUID();
  const occurredAt = new Date(Date.parse(input.startAt) + 3600_000).toISOString();
  await db.insert(cli_sessions_v2).values({
    session_id: sessionId,
    kilo_user_id: user.id,
    organization_id: organization,
    title: 'Historical work',
    created_on_platform: 'cli',
    status: 'question',
  });
  await db.insert(agent_briefing_events).values([
    {
      id: eventId,
      session_id: sessionId,
      kilo_user_id: user.id,
      organization_id: organization,
      kind: 'activity',
      occurred_at: occurredAt,
      payload: { excerpt: 'Implemented the selected-period change' },
    },
    {
      id: crypto.randomUUID(),
      session_id: sessionId,
      kilo_user_id: user.id,
      organization_id: organization,
      kind: 'status',
      status: 'idle',
      occurred_at: occurredAt,
      payload: {
        transitionId: 'historical-idle',
        previousStatusKnown: true,
        previousStatus: 'busy',
      },
    },
    {
      id: crypto.randomUUID(),
      session_id: sessionId,
      kilo_user_id: user.id,
      organization_id: organization,
      kind: 'status',
      status: 'question',
      occurred_at: new Date(Date.parse(input.endAt) + 1).toISOString(),
      payload: {
        transitionId: 'later-question',
        previousStatusKnown: true,
        previousStatus: 'idle',
      },
    },
  ]);
  return { sessionId, eventId, occurredAt };
}

it.each([
  { startAt: 'not-a-date' },
  { endAt: 'not-a-date' },
  { endAt: new Date(Date.now() + 86400_000).toISOString() },
  { startAt: new Date(Date.now() - 40 * 86400_000).toISOString() },
  { timezone: 'Not/A_Timezone' },
])('rejects invalid selected periods and timezones: %j', async overrides => {
  await expect(
    agentBriefingRouter.createCaller({ user }).prepareOneOff({ ...period(), ...overrides })
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

it('prepares an empty historical draft without scheduling, billing, history visibility or AI work', async () => {
  const caller = agentBriefingRouter.createCaller({ user });
  const input = period(90);
  const prepared = await caller.prepareOneOff(input);
  expect(prepared.estimate).toBeNull();
  expect(prepared.report).toMatchObject({
    kind: 'one_off',
    publishedAt: null,
    timezone: input.timezone,
  });
  expect(prepared.report.coverage.activity).toBe('partial');
  expect(Date.parse(prepared.report.expiresAt) - Date.parse(prepared.report.createdAt)).toBe(
    30 * 86400_000
  );
  expect((await caller.list()).reports).toHaveLength(0);
  expect(await db.select().from(agent_briefing_preferences)).toHaveLength(0);
  expect(after).not.toHaveBeenCalled();
  const saved = await caller.createOneOff({ reportId: prepared.report.id });
  expect(saved.publishedAt).not.toBeNull();
  expect(saved.summary.status).toBe('disabled');
  expect((await caller.list()).reports.map(report => report.id)).toEqual([saved.id]);
  expect((await caller.list({ currentOnly: true })).reports).toHaveLength(0);
  expect(await caller.createOneOff({ reportId: saved.id })).toEqual(saved);
  expect(after).not.toHaveBeenCalled();
  await expect(
    caller.generateSummary({ reportId: saved.id, estimateToken: 'unused' })
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

it('freezes evidence and cutoff state across transport retries and rejects request ID parameter/owner collisions', async () => {
  const caller = agentBriefingRouter.createCaller({ user });
  const input = period();
  const { sessionId } = await seedActivity(input);
  const prepared = await caller.prepareOneOff(input);
  expect(prepared.report.sessions[0]?.status).toBe('idle');
  expect(prepared.estimate?.canGenerate).toBe(true);
  await db.insert(agent_briefing_events).values({
    id: 'late-recorded-event',
    kilo_user_id: user.id,
    session_id: sessionId,
    kind: 'activity',
    occurred_at: input.startAt,
    recorded_at: new Date(Date.now() + 1000).toISOString(),
  });
  const again = await caller.prepareOneOff(input);
  expect(again.report).toEqual(prepared.report);
  for (const changes of [
    { language: 'en' },
    { timezone: 'UTC' },
    { organizationId },
    { startAt: new Date(Date.parse(input.startAt) - 1000).toISOString() },
    { endAt: new Date(Date.parse(input.endAt) + 1000).toISOString() },
  ])
    await expect(caller.prepareOneOff({ ...input, ...changes })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  await expect(
    agentBriefingRouter.createCaller({ user: other }).prepareOneOff(input)
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(await db.select().from(agent_briefing_preferences)).toHaveLength(0);
  expect(after).not.toHaveBeenCalled();
});

it('publishes and queues once while scheduled AI is disabled, survives retries and claims only one provider request', async () => {
  const caller = agentBriefingRouter.createCaller({ user });
  const input = period();
  await seedActivity(input);
  const prepared = await caller.prepareOneOff(input);
  if (!prepared.estimate) throw new Error('Missing estimate fixture');
  await expect(caller.createOneOff({ reportId: prepared.report.id })).rejects.toMatchObject({
    code: 'BAD_REQUEST',
  });
  const request = { reportId: prepared.report.id, estimateToken: prepared.estimate.estimateToken };
  const [first, second] = await Promise.all([
    caller.createOneOff(request),
    caller.createOneOff(request),
  ]);
  expect(first.id).toBe(second.id);
  expect(first.publishedAt).not.toBeNull();
  expect(first.summary.status).toBe('pending');
  const [preferences] = await db.select().from(agent_briefing_context_preferences);
  expect(preferences.ai_enabled).toBe(false);
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [{ message: { content: 'Selected-period summary' } }],
      }),
      { status: 200 }
    )
  );
  await caller.updatePreferences({ language: 'de', timezone: 'America/New_York' });
  await Promise.all([runBriefingSummary(first.id), runBriefingSummary(first.id)]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
  expect(body.messages[1].content).toContain('language "sr"');
  expect(body.messages[1].content).toContain('Europe/Belgrade');
  const ready = await caller.get({ reportId: first.id });
  expect(ready.summary.status).toBe('ready');
  expect(await caller.createOneOff({ reportId: first.id, estimateToken: 'expired-retry' })).toEqual(
    ready
  );
  await sweepAgentBriefings();
  expect(dispatchAgentBriefingPush).not.toHaveBeenCalled();
  const [persisted] = await db
    .select()
    .from(agent_briefing_reports)
    .where(eq(agent_briefing_reports.id, first.id));
  expect(persisted.next_refresh_at).toBeNull();
  expect(persisted.evidence_recorded_before).not.toBeNull();
  expect(await db.select().from(microdollar_usage)).toHaveLength(0);
});

it('binds paid consent to report, snapshot revision, prior charge, model and budgets', async () => {
  const caller = agentBriefingRouter.createCaller({ user });
  const input = period();
  await seedActivity(input);
  const prepared = await caller.prepareOneOff(input);
  if (!prepared.estimate) throw new Error('Missing estimate fixture');
  const create = () =>
    caller.createOneOff({
      reportId: prepared.report.id,
      estimateToken: prepared.estimate?.estimateToken,
    });
  for (const changes of [
    { revision: prepared.report.revision + 1 },
    { summary: { ...prepared.report.summary, costMicrodollars: 1 } },
  ]) {
    await db
      .update(agent_briefing_reports)
      .set(changes)
      .where(eq(agent_briefing_reports.id, prepared.report.id));
    await expect(create()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await db
      .update(agent_briefing_reports)
      .set({ revision: prepared.report.revision, summary: prepared.report.summary })
      .where(eq(agent_briefing_reports.id, prepared.report.id));
  }
  for (const changes of [
    { model: 'different/model' },
    { max_spend_microdollars: 3_000_000 },
    { max_duration_seconds: 200 },
  ]) {
    await db
      .update(agent_briefing_context_preferences)
      .set(changes)
      .where(eq(agent_briefing_context_preferences.kilo_user_id, user.id));
    await expect(create()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await db
      .update(agent_briefing_context_preferences)
      .set({ model: 'test/bounded', max_spend_microdollars: 2_000_000, max_duration_seconds: 600 })
      .where(eq(agent_briefing_context_preferences.kilo_user_id, user.id));
  }
  const otherDraft = await caller.prepareOneOff({ ...input, requestId: crypto.randomUUID() });
  await expect(
    caller.createOneOff({
      reportId: otherDraft.report.id,
      estimateToken: prepared.estimate.estimateToken,
    })
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect((await caller.list()).reports).toHaveLength(0);
});

it('does not silently use settings changed after confirmation or send an upstream request', async () => {
  const caller = agentBriefingRouter.createCaller({ user });
  const input = period();
  await seedActivity(input);
  const prepared = await caller.prepareOneOff(input);
  await caller.createOneOff({
    reportId: prepared.report.id,
    estimateToken: prepared.estimate?.estimateToken,
  });
  await db
    .update(agent_briefing_context_preferences)
    .set({ max_spend_microdollars: 3_000_000 })
    .where(eq(agent_briefing_context_preferences.kilo_user_id, user.id));
  const fetchMock = jest
    .spyOn(global, 'fetch')
    .mockRejectedValue(new Error('Unexpected provider request'));
  await runBriefingSummary(prepared.report.id);
  expect(fetchMock).not.toHaveBeenCalled();
  expect((await caller.get({ reportId: prepared.report.id })).summary).toMatchObject({
    status: 'unavailable',
    error: 'permission_unavailable',
    costMicrodollars: 0,
  });
});

it.each(['session', 'event', 'usage'] as const)(
  'clears frozen facts and AI text after %s deletion without collecting later evidence',
  async removed => {
    const caller = agentBriefingRouter.createCaller({ user });
    const input = period();
    const { sessionId, eventId, occurredAt } = await seedActivity(input);
    const usageId = crypto.randomUUID();
    await db.insert(microdollar_usage).values({
      id: usageId,
      kilo_user_id: user.id,
      cost: 10,
      input_tokens: 1,
      output_tokens: 1,
      cache_write_tokens: 0,
      cache_hit_tokens: 0,
      created_at: occurredAt,
    });
    await db
      .insert(microdollar_usage_metadata)
      .values({ id: usageId, session_id: sessionId, message_id: 'historical-cost' });
    const prepared = await caller.prepareOneOff(input);
    await caller.createOneOff({
      reportId: prepared.report.id,
      estimateToken: prepared.estimate?.estimateToken,
    });
    await db
      .update(agent_briefing_reports)
      .set({
        summary: { ...prepared.report.summary, status: 'ready', text: 'Removed private evidence' },
      })
      .where(eq(agent_briefing_reports.id, prepared.report.id));
    await db.insert(agent_briefing_events).values({
      id: 'new-event-must-not-enter-snapshot',
      kilo_user_id: user.id,
      session_id: sessionId,
      kind: 'activity',
      occurred_at: input.startAt,
    });
    if (removed === 'session')
      await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, sessionId));
    if (removed === 'event')
      await db.delete(agent_briefing_events).where(eq(agent_briefing_events.id, eventId));
    if (removed === 'usage')
      await db.delete(microdollar_usage_metadata).where(eq(microdollar_usage_metadata.id, usageId));
    const cleared = await caller.get({ reportId: prepared.report.id });
    expect(cleared.sources).toEqual([]);
    expect(cleared.sessions).toEqual([]);
    expect(cleared.revision).toBeGreaterThan(prepared.report.revision);
    expect(cleared.summary).toMatchObject({
      status: 'outdated',
      text: null,
      error: 'permission_unavailable',
    });
    expect((await caller.list()).reports.map(report => report.id)).toContain(cleared.id);
  }
);

it('uses the existing billable retry flow without scheduled AI and cannot enqueue duplicate retries', async () => {
  const caller = agentBriefingRouter.createCaller({ user });
  const input = period();
  await seedActivity(input);
  const prepared = await caller.prepareOneOff(input);
  await caller.createOneOff({
    reportId: prepared.report.id,
    estimateToken: prepared.estimate?.estimateToken,
  });
  const generationId = `agent-briefing:${crypto.randomUUID()}`;
  const [failed] = await db
    .update(agent_briefing_reports)
    .set({
      generation_id: generationId,
      summary: { ...prepared.report.summary, status: 'failed', chargeStatus: 'pending' },
    })
    .where(eq(agent_briefing_reports.id, prepared.report.id))
    .returning();
  const usageId = crypto.randomUUID();
  await db.insert(microdollar_usage).values({
    id: usageId,
    kilo_user_id: user.id,
    cost: 1234,
    input_tokens: 1,
    output_tokens: 1,
    cache_write_tokens: 0,
    cache_hit_tokens: 0,
  });
  await db
    .insert(microdollar_usage_metadata)
    .values({ id: usageId, session_id: generationId, message_id: 'failed-charge' });
  await reconcileBriefingCharge(failed);
  const estimate = await caller.estimateSummary({ reportId: prepared.report.id });
  const request = { reportId: prepared.report.id, estimateToken: estimate.estimateToken };
  const results = await Promise.all([caller.retrySummary(request), caller.retrySummary(request)]);
  expect(results.every(report => report.summary.status === 'pending')).toBe(true);
  const [queued] = await db
    .select()
    .from(agent_briefing_reports)
    .where(eq(agent_briefing_reports.id, prepared.report.id));
  expect(queued.summary.priorCostMicrodollars).toBe(1234);
  expect(queued.generation_id).toBeNull();
});

it('enforces payer balance and organization access without creating preferences or AI jobs', async () => {
  const caller = agentBriefingRouter.createCaller({ user });
  const input = period();
  await seedActivity(input);
  user.total_microdollars_acquired = 0;
  await db
    .update(kilocode_users)
    .set({ total_microdollars_acquired: 0 })
    .where(eq(kilocode_users.id, user.id));
  const prepared = await caller.prepareOneOff(input);
  expect(prepared.estimate).toMatchObject({
    canGenerate: false,
    unavailableReason: 'balance_unavailable',
  });
  await expect(
    caller.createOneOff({
      reportId: prepared.report.id,
      estimateToken: prepared.estimate?.estimateToken,
    })
  ).rejects.toThrow('balance_unavailable');
  await db
    .update(organization_memberships)
    .set({ role: 'billing_manager' })
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(organization_memberships.kilo_user_id, user.id)
      )
    );
  await expect(caller.prepareOneOff({ ...period(), organizationId })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  expect(await db.select().from(agent_briefing_preferences)).toHaveLength(0);
  expect(after).not.toHaveBeenCalled();
});

it('keeps duplicate selected periods independent, preserves scheduled uniqueness and expires by creation instead of cutoff', async () => {
  const caller = agentBriefingRouter.createCaller({ user });
  const input = period(90);
  const first = await caller.prepareOneOff(input);
  const second = await caller.prepareOneOff({ ...input, requestId: crypto.randomUUID() });
  await caller.createOneOff({ reportId: first.report.id });
  await caller.createOneOff({ reportId: second.report.id });
  await sweepAgentBriefings();
  expect((await caller.list()).reports).toHaveLength(2);
  const [row] = await db
    .select()
    .from(agent_briefing_reports)
    .where(eq(agent_briefing_reports.id, first.report.id));
  const scheduled = { ...row, id: crypto.randomUUID(), kind: 'scheduled' as const };
  await db.insert(agent_briefing_reports).values(scheduled);
  await expect(
    db.insert(agent_briefing_reports).values({ ...scheduled, id: crypto.randomUUID() })
  ).rejects.toThrow();
  const expiredAt = new Date(Date.now() - 1000).toISOString();
  await db
    .update(agent_briefing_reports)
    .set({ morning_end_at: expiredAt })
    .where(eq(agent_briefing_reports.id, first.report.id));
  await expect(caller.get({ reportId: first.report.id })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  await sweepAgentBriefings();
  expect(
    await db
      .select()
      .from(agent_briefing_reports)
      .where(eq(agent_briefing_reports.id, first.report.id))
  ).toHaveLength(0);
});

it('retains report ownership and revocable organization permissions for confirmation', async () => {
  const caller = agentBriefingRouter.createCaller({ user });
  const prepared = await caller.prepareOneOff({ ...period(), organizationId });
  await expect(
    agentBriefingRouter.createCaller({ user: other }).createOneOff({ reportId: prepared.report.id })
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await db
    .delete(organization_memberships)
    .where(eq(organization_memberships.kilo_user_id, user.id));
  await expect(caller.createOneOff({ reportId: prepared.report.id })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  expect(resolveOrganizationMemberModelDecision).not.toHaveBeenCalled();
});

it('reads manual settings without initializing schedules or mutating an existing preference row', async () => {
  const caller = agentBriefingRouter.createCaller({ user });
  const defaults = await caller.oneOffPreferences({ timezone: 'Asia/Tokyo', language: 'ja' });
  expect(defaults).toMatchObject({
    timezone: 'Asia/Tokyo',
    language: 'ja',
    nightStart: '22:00',
    morningStart: '08:00',
    morningEnd: '12:00',
    notificationsEnabled: false,
  });
  expect(defaults.contexts.find(setting => setting.context.id === 'personal')).toMatchObject({
    aiEnabled: false,
    model: 'test/bounded',
  });
  expect(await db.select().from(agent_briefing_preferences)).toHaveLength(0);
  await db.insert(agent_briefing_preferences).values({
    kilo_user_id: user.id,
    timezone: 'Europe/Belgrade',
    language: 'sr',
    next_run_at: new Date(Date.now() + 86400_000).toISOString(),
  });
  const before = await db.select().from(agent_briefing_preferences);
  expect(await caller.oneOffPreferences({ timezone: 'UTC', language: 'en' })).toMatchObject({
    timezone: 'Europe/Belgrade',
    language: 'sr',
  });
  expect(await db.select().from(agent_briefing_preferences)).toEqual(before);
});

it('validates frozen pre-period status provenance without pulling in later status records', async () => {
  const caller = agentBriefingRouter.createCaller({ user });
  const input = period();
  const { sessionId } = await seedActivity(input);
  const baselineId = crypto.randomUUID();
  await db.insert(agent_briefing_events).values({
    id: baselineId,
    kilo_user_id: user.id,
    session_id: sessionId,
    kind: 'status',
    status: 'busy',
    occurred_at: new Date(Date.parse(input.startAt) - 1000).toISOString(),
    payload: { transitionId: 'baseline', previousStatusKnown: true, previousStatus: 'idle' },
  });
  const prepared = await caller.prepareOneOff(input);
  await caller.createOneOff({
    reportId: prepared.report.id,
    estimateToken: prepared.estimate?.estimateToken,
  });
  await db.delete(agent_briefing_events).where(eq(agent_briefing_events.id, baselineId));
  const sanitized = await caller.get({ reportId: prepared.report.id });
  expect(sanitized.sources).toEqual([]);
  expect(sanitized.summary.error).toBe('permission_unavailable');
});

it('does not collect late usage or activity when a frozen session changes context', async () => {
  const caller = agentBriefingRouter.createCaller({ user });
  const input = period();
  const { sessionId, occurredAt } = await seedActivity(input);
  const prepared = await caller.prepareOneOff(input);
  await caller.createOneOff({
    reportId: prepared.report.id,
    estimateToken: prepared.estimate?.estimateToken,
  });
  const usageId = crypto.randomUUID();
  await db.insert(microdollar_usage).values({
    id: usageId,
    kilo_user_id: user.id,
    cost: 999,
    input_tokens: 1,
    output_tokens: 1,
    cache_write_tokens: 0,
    cache_hit_tokens: 0,
    created_at: occurredAt,
  });
  await db.insert(microdollar_usage_metadata).values({
    id: usageId,
    session_id: sessionId,
    message_id: 'late-recorded-usage',
  });
  expect((await caller.get({ reportId: prepared.report.id })).scorecard.spendMicrodollars).toBe(0);
  await db
    .update(cli_sessions_v2)
    .set({ organization_id: organizationId })
    .where(eq(cli_sessions_v2.session_id, sessionId));
  const sanitized = await caller.get({ reportId: prepared.report.id });
  expect(sanitized.sources).toEqual([]);
  expect(sanitized.summary.status).toBe('outdated');
  expect(sanitized.scorecard.spendMicrodollars).toBe(0);
});

it('opens a frozen report with high-volume provenance', async () => {
  const caller = agentBriefingRouter.createCaller({ user });
  const input = period();
  const { sessionId } = await seedActivity(input);
  const prepared = await caller.prepareOneOff(input);
  const eventIds = Array.from({ length: 65_536 }, (_, index) => `volume-${index}`);
  await db.execute(sql`
    INSERT INTO ${agent_briefing_events}
      (id, session_id, kilo_user_id, kind, occurred_at, recorded_at)
    SELECT 'volume-' || n, ${sessionId}, ${user.id}, 'activity',
      ${input.startAt}::timestamptz, ${prepared.report.createdAt}::timestamptz
    FROM generate_series(0, 65535) AS n
  `);
  await db
    .update(agent_briefing_reports)
    .set({
      facts: sql`${agent_briefing_reports.facts} || ${JSON.stringify({ evidenceEventIds: eventIds })}::jsonb`,
    })
    .where(eq(agent_briefing_reports.id, prepared.report.id));
  const report = await caller.get({ reportId: prepared.report.id });
  expect(report.scorecard.sessions).toBe(1);
  expect(report.sessions[0]?.title).toBe('Historical work');
}, 30_000);
