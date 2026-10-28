import { eq } from 'drizzle-orm';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import {
  agent_briefing_context_preferences,
  agent_briefing_preferences,
  agent_briefing_snapshots,
  cli_sessions_v2,
  microdollar_usage,
  microdollar_usage_metadata,
} from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { dispatchAgentBriefingPush } from '@kilocode/web-shared/lib/notifications-worker-client';
import { sweepAgentBriefings, generatePendingAgentBriefings } from './sweep';
import { reconcileBriefingCharge, runBriefingSummary } from './summary';
import { briefingFactsSchema, buildBriefingSnapshot, collectBriefingSnapshot } from './evidence';
import { agentBriefingRouter } from '@/routers/agent-briefing-router';
import { emptySummary } from './store';

jest.mock('@kilocode/web-shared/lib/notifications-worker-client', () => ({
  dispatchAgentBriefingPush: jest.fn().mockResolvedValue(false),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  getOpenRouterModelsMetadataFromDatabase: jest.fn().mockResolvedValue({}),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/unavailable-models', () => ({
  getUnavailableModelIds: jest.fn().mockResolvedValue(new Set()),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/preferred-provider-order-config', () => ({
  getPreferredProviderOrderConfig: jest.fn().mockResolvedValue({ rules: [] }),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/custom-pricing-config', () => ({
  getCustomPricingConfig: jest.fn().mockResolvedValue({ models: [] }),
}));
jest.mock('@kilocode/web-shared/lib/organizations/organization-usage', () => ({
  getBalanceAndOrgSettings: jest.fn().mockResolvedValue({ payer: {}, balance: 10 }),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/openrouter', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/ai-gateway/providers/openrouter'),
  getRawOpenRouterModels: jest.fn().mockResolvedValue({
    data: [
      {
        id: 'test/snapshot',
        name: 'Snapshot test model',
        created: 0,
        description: '',
        architecture: {
          input_modalities: ['text'],
          output_modalities: ['text'],
          tokenizer: 'Other',
        },
        top_provider: { is_moderated: false },
        pricing: { prompt: '0.000001', completion: '0.000002' },
        context_length: 128000,
      },
    ],
  }),
}));
beforeEach(cleanupDbForTest);
afterEach(() => jest.restoreAllMocks());
async function scheduled(active = true) {
  const user = await insertTestUser({ total_microdollars_acquired: 10_000_000 });
  const now = new Date();
  const clock = (date: Date) => date.toISOString().slice(11, 16);
  const morning = new Date(now.getTime() - 5 * 60_000);
  morning.setUTCSeconds(0, 0);
  await db.insert(agent_briefing_preferences).values({
    kilo_user_id: user.id,
    timezone: 'UTC',
    night_start: clock(new Date(morning.getTime() - 3 * 3600_000)),
    morning_start: clock(morning),
    morning_end: clock(new Date(morning.getTime() + 3 * 3600_000)),
    next_run_at: morning.toISOString(),
  });
  await db.insert(agent_briefing_context_preferences).values({
    kilo_user_id: user.id,
    context_key: 'personal',
    enabled: true,
    model: 'test/snapshot',
  });
  if (active)
    await db.insert(cli_sessions_v2).values({
      session_id: `ses_${crypto.randomUUID()}`,
      kilo_user_id: user.id,
      title: 'Captured session',
      last_activity_at: new Date(morning.getTime() - 3600_000).toISOString(),
      briefing_excerpt: {
        messageId: 'completed',
        completedAt: new Date(morning.getTime() - 3600_000).toISOString(),
        text: 'Completed final response',
      },
    });
  return { user, now };
}
it('atomically captures one occurrence only for explicitly enabled contexts', async () => {
  const { user, now } = await scheduled();
  const org = await createTestOrganization('Disabled context', user.id, 0);
  await db.insert(cli_sessions_v2).values({
    session_id: 'ses_org',
    kilo_user_id: user.id,
    organization_id: org.id,
    last_activity_at: now.toISOString(),
  });
  await Promise.all([sweepAgentBriefings(now), sweepAgentBriefings(now)]);
  const rows = await db.select().from(agent_briefing_snapshots);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.context_key).toBe('personal');
  expect(rows[0]?.facts.scorecard).toEqual({ sessions: 1, pullRequests: 0, blockers: 0 });
  await sweepAgentBriefings(new Date(now.getTime() + 60_000));
  expect(await db.select().from(agent_briefing_snapshots)).toHaveLength(1);
});
it('publishes a quiet structured snapshot without any model call', async () => {
  const { now } = await scheduled(false);
  const fetcher = jest.spyOn(globalThis, 'fetch');
  await sweepAgentBriefings(now);
  const [row] = await db.select().from(agent_briefing_snapshots);
  expect(row?.published_at).not.toBeNull();
  expect(row?.summary.status).toBe('unavailable');
  expect(row?.job_due_at).toBeNull();
  await generatePendingAgentBriefings();
  expect(fetcher).not.toHaveBeenCalled();
});
it('claims paid generation once across simultaneous workers and never refreshes its input', async () => {
  const { now } = await scheduled();
  await sweepAgentBriefings(now);
  const [row] = await db.select().from(agent_briefing_snapshots);
  if (!row) throw new Error('No captured snapshot');
  const fetcher = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      Response.json({ choices: [{ message: { content: 'Captured final response summarized.' } }] })
    );
  await Promise.all([runBriefingSummary(row.id), runBriefingSummary(row.id)]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [finished] = await db.select().from(agent_briefing_snapshots);
  expect(finished?.summary.status).toBe('ready');
  expect(finished?.facts).toEqual(row.facts);
  await runBriefingSummary(row.id);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('publishes failure while preserving facts and refuses automatic paid retries', async () => {
  const { now } = await scheduled();
  await sweepAgentBriefings(now);
  const [row] = await db.select().from(agent_briefing_snapshots);
  if (!row) throw new Error('No captured snapshot');
  const fetcher = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('gateway_declined'));
  await runBriefingSummary(row.id);
  await generatePendingAgentBriefings();
  const [failed] = await db.select().from(agent_briefing_snapshots);
  expect(failed?.summary.status).toBe('failed');
  expect(failed?.published_at).not.toBeNull();
  expect(failed?.facts).toEqual(row.facts);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('settles a delayed usage delivery against its immutable occurrence generation', async () => {
  const { now, user } = await scheduled();
  await sweepAgentBriefings(now);
  const [row] = await db.select().from(agent_briefing_snapshots);
  if (!row) throw new Error('No captured snapshot');
  jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ choices: [{ message: { content: 'Summary' } }] }));
  await runBriefingSummary(row.id);
  const [generated] = await db.select().from(agent_briefing_snapshots);
  if (!generated?.generation_id) throw new Error('No generation');
  const usageId = crypto.randomUUID();
  await db.insert(microdollar_usage).values({
    id: usageId,
    kilo_user_id: user.id,
    cost: 42,
    input_tokens: 10,
    output_tokens: 5,
    cache_write_tokens: 0,
    cache_hit_tokens: 0,
  });
  await db
    .insert(microdollar_usage_metadata)
    .values({ id: usageId, session_id: generated.generation_id, message_id: 'summary-response' });
  await db
    .update(agent_briefing_snapshots)
    .set({
      summary: {
        ...generated.summary,
        chargeAccounting: {
          baselineCostMicrodollars: 0,
          generations: [{ id: generated.generation_id, usageId }],
        },
      },
    })
    .where(eq(agent_briefing_snapshots.id, row.id));
  const [receipt] = await db.select().from(agent_briefing_snapshots);
  if (!receipt) throw new Error('No receipt');
  const settled = await reconcileBriefingCharge(receipt);
  expect(settled.summary.costMicrodollars).toBe(42);
  expect(settled.summary.chargeStatus).toBe('settled');
  expect(settled.next_charge_check_at).toBeNull();
});
it('selects latest activity deterministically and keeps organization scope exact', async () => {
  const { user, now } = await scheduled(false);
  const org = await createTestOrganization('Other context', user.id, 0);
  const activity = now.toISOString();
  await db.insert(cli_sessions_v2).values([
    { session_id: 'ses_b', kilo_user_id: user.id, last_activity_at: activity },
    { session_id: 'ses_a', kilo_user_id: user.id, last_activity_at: activity },
    {
      session_id: 'ses_other',
      kilo_user_id: user.id,
      organization_id: org.id,
      last_activity_at: activity,
    },
  ]);
  const facts = await collectBriefingSnapshot(
    user.id,
    null,
    new Date(now.getTime() - 86400_000).toISOString(),
    activity
  );
  expect(facts.sessions.map(session => session.sessionId)).toEqual(['ses_a', 'ses_b']);
});
it('deletes snapshots after bounded retention', async () => {
  const { user, now } = await scheduled(false);
  await sweepAgentBriefings(now);
  await db
    .update(agent_briefing_snapshots)
    .set({ expires_at: new Date(now.getTime() - 1).toISOString() })
    .where(eq(agent_briefing_snapshots.kilo_user_id, user.id));
  await sweepAgentBriefings(now);
  expect(await db.select().from(agent_briefing_snapshots)).toHaveLength(0);
});

it('limits paid model requests across overlapping scheduler invocations', async () => {
  const first = await scheduled();
  await scheduled();
  await scheduled();
  await sweepAgentBriefings(first.now);
  const rows = await db.select().from(agent_briefing_snapshots);
  const { promise: responseGate, resolve: release } = Promise.withResolvers<void>();
  const { promise: twoStarted, resolve: started } = Promise.withResolvers<void>();
  let requests = 0;
  const fetcher = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    requests += 1;
    if (requests === 2) started();
    await responseGate;
    return Response.json({ choices: [{ message: { content: 'Summary' } }] });
  });
  const runs = rows.map(row => runBriefingSummary(row.id));
  try {
    await twoStarted;
    const statuses = await db.select().from(agent_briefing_snapshots);
    expect(statuses.filter(row => row.summary.status === 'running')).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    release();
    await Promise.all(runs);
  }
  expect(
    (await db.select().from(agent_briefing_snapshots)).filter(
      row => row.summary.status === 'pending'
    )
  ).toHaveLength(1);
});

it('preserves saved snapshot readability while disabling future paid generation', async () => {
  const { now, user } = await scheduled();
  await sweepAgentBriefings(now);
  const [row] = await db.select().from(agent_briefing_snapshots);
  if (!row) throw new Error('No captured snapshot');
  const caller = agentBriefingRouter.createCaller({ user });
  await caller.updateContextPreferences({ enabled: false });
  const saved = await caller.get({ reportId: row.id });
  expect(saved.sessions[0]?.title).toBe('Captured session');
  expect(saved.sources.some(source => source.excerpt === 'Completed final response')).toBe(true);
  const fetcher = jest.spyOn(globalThis, 'fetch');
  await runBriefingSummary(row.id);
  expect(fetcher).not.toHaveBeenCalled();
  const [failed] = await db.select().from(agent_briefing_snapshots);
  expect(failed?.summary.error).toBe('permission_unavailable');
  expect(failed?.summary.costMicrodollars).toBe(0);
  expect(failed?.facts).toEqual(row.facts);
  expect((await caller.get({ reportId: row.id })).summary.error).toBe('permission_unavailable');
});

it('keeps declined notification delivery due until a later accepted morning dispatch', async () => {
  const { user, now } = await scheduled();
  await db
    .update(agent_briefing_preferences)
    .set({ notifications_enabled: true })
    .where(eq(agent_briefing_preferences.kilo_user_id, user.id));
  const dispatch = jest.mocked(dispatchAgentBriefingPush);
  dispatch.mockClear();
  dispatch.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await sweepAgentBriefings(now);
  const [declined] = await db.select().from(agent_briefing_snapshots);
  expect(declined?.notification_sent_at).toBeNull();
  expect(dispatch).toHaveBeenCalledTimes(1);
  await sweepAgentBriefings(new Date(now.getTime() + 60_000));
  const [accepted] = await db.select().from(agent_briefing_snapshots);
  expect(accepted?.notification_sent_at).not.toBeNull();
  expect(dispatch).toHaveBeenCalledTimes(2);
  await sweepAgentBriefings(new Date(now.getTime() + 120_000));
  expect(dispatch).toHaveBeenCalledTimes(2);
});

it('does not retry declined notifications after the morning window ends', async () => {
  const { user, now } = await scheduled();
  await db
    .update(agent_briefing_preferences)
    .set({ notifications_enabled: true })
    .where(eq(agent_briefing_preferences.kilo_user_id, user.id));
  const dispatch = jest.mocked(dispatchAgentBriefingPush);
  dispatch.mockClear();
  dispatch.mockResolvedValue(false);
  await sweepAgentBriefings(now);
  await db
    .update(agent_briefing_snapshots)
    .set({ morning_end_at: new Date(now.getTime() + 30_000).toISOString() })
    .where(eq(agent_briefing_snapshots.kilo_user_id, user.id));
  await sweepAgentBriefings(new Date(now.getTime() + 60_000));
  expect(dispatch).toHaveBeenCalledTimes(1);
});

it('atomically initializes a fresh enabled context schedule in the requested timezone', async () => {
  const user = await insertTestUser({ total_microdollars_acquired: 10_000_000 });
  const caller = agentBriefingRouter.createCaller({ user });
  await caller.preferences({ timezone: 'Europe/Berlin', language: 'de' });
  expect(await db.select().from(agent_briefing_preferences)).toHaveLength(0);
  const estimate = await caller.estimateSummary({ model: 'test/snapshot' });
  expect(estimate.canGenerate).toBe(true);
  await expect(
    caller.updateContextPreferences({
      enabled: true,
      model: 'test/snapshot',
      estimateToken: estimate.estimateToken,
      timezone: 'invalid/timezone',
    })
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(await db.select().from(agent_briefing_preferences)).toHaveLength(0);
  const beforeEnable = Date.now();
  await caller.updateContextPreferences({
    enabled: true,
    model: 'test/snapshot',
    estimateToken: estimate.estimateToken,
    timezone: 'Europe/Berlin',
    language: 'de',
  });
  const [schedule] = await db.select().from(agent_briefing_preferences);
  if (!schedule) throw new Error('Missing initial schedule');
  expect(schedule.timezone).toBe('Europe/Berlin');
  expect(schedule.language).toBe('de');
  expect(Date.parse(schedule.next_run_at)).toBeGreaterThan(beforeEnable);
  expect(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Berlin',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(schedule.next_run_at))
  ).toBe('08:00');
  expect((await db.select().from(agent_briefing_context_preferences))[0]?.enabled).toBe(true);
  await caller.updateContextPreferences({
    enabled: true,
    model: 'test/snapshot',
    estimateToken: estimate.estimateToken,
    timezone: 'America/Los_Angeles',
    language: 'ja',
  });
  expect((await db.select().from(agent_briefing_preferences))[0]).toEqual(schedule);
});

function maintenanceSnapshot(
  userId: string,
  localDate: string
): typeof agent_briefing_snapshots.$inferInsert {
  return {
    kilo_user_id: userId,
    context_key: 'personal',
    timezone: 'UTC',
    language: 'en',
    local_date: localDate,
    night_start_at: '2026-10-27T22:00:00.000Z',
    cutoff_at: '2026-10-28T08:00:00.000Z',
    morning_end_at: '2026-10-28T12:00:00.000Z',
    captured_at: '2026-10-28T08:00:00.000Z',
    published_at: '2026-10-28T08:00:00.000Z',
    expires_at: '2026-11-27T08:00:00.000Z',
    facts: buildBriefingSnapshot([]),
    summary: emptySummary,
  };
}

it('terminally suppresses revoked notification sources so later eligible reports reach delivery', async () => {
  const user = await insertTestUser();
  await db.insert(agent_briefing_preferences).values({
    kilo_user_id: user.id,
    timezone: 'UTC',
    notifications_enabled: true,
    next_run_at: '2026-10-29T08:00:00.000Z',
  });
  const sources = await db
    .insert(cli_sessions_v2)
    .values(
      ['revoked', 'accessible'].map(id => ({
        kilo_user_id: user.id,
        session_id: `ses_${id}`,
        title: id,
        last_activity_at: '2026-10-28T07:00:00.000Z',
      }))
    )
    .returning();
  const revoked = sources.find(source => source.session_id === 'ses_revoked');
  const accessible = sources.find(source => source.session_id === 'ses_accessible');
  if (!revoked || !accessible) throw new Error('Missing source fixture');
  await db.insert(agent_briefing_snapshots).values(
    Array.from({ length: 100 }, (_, index) => ({
      ...maintenanceSnapshot(user.id, `revoked-${index}`),
      facts: buildBriefingSnapshot([revoked]),
    }))
  );
  const [eligible] = await db
    .insert(agent_briefing_snapshots)
    .values({
      ...maintenanceSnapshot(user.id, 'eligible'),
      cutoff_at: '2026-10-28T08:01:00.000Z',
      facts: buildBriefingSnapshot([accessible]),
    })
    .returning();
  if (!eligible) throw new Error('Missing eligible report');
  await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, revoked.session_id));
  const dispatch = jest.mocked(dispatchAgentBriefingPush);
  dispatch.mockClear();
  dispatch.mockResolvedValue(true);
  await sweepAgentBriefings(new Date('2026-10-28T08:10:00.000Z'));
  expect(dispatch).not.toHaveBeenCalled();
  const suppressed = await db.select().from(agent_briefing_snapshots);
  expect(suppressed.filter(row => row.summary.notificationSuppressed === true)).toHaveLength(100);
  expect(
    suppressed
      .filter(row => row.summary.notificationSuppressed === true)
      .every(row => row.notification_sent_at === null)
  ).toBe(true);
  await sweepAgentBriefings(new Date('2026-10-28T08:11:00.000Z'));
  expect(dispatch).toHaveBeenCalledTimes(1);
  const [delivered] = await db
    .select()
    .from(agent_briefing_snapshots)
    .where(eq(agent_briefing_snapshots.id, eligible.id));
  expect(delivered?.notification_sent_at).not.toBeNull();
});

it('repairs an expired running job behind an entire batch of still-open pending reports', async () => {
  const user = await insertTestUser();
  await db.insert(agent_briefing_snapshots).values(
    Array.from({ length: 100 }, (_, index) => ({
      ...maintenanceSnapshot(user.id, `pending-${index}`),
      job_due_at: '2026-10-28T08:00:00.000Z',
      summary: { ...emptySummary, status: 'pending' },
    }))
  );
  const [running] = await db
    .insert(agent_briefing_snapshots)
    .values({
      ...maintenanceSnapshot(user.id, 'running'),
      job_due_at: '2026-10-28T08:05:00.000Z',
      generation_id: 'agent-briefing:expired',
      generation_started_at: '2026-10-28T08:00:00.000Z',
      generation_deadline_at: '2026-10-28T08:05:00.000Z',
      summary: { ...emptySummary, status: 'running' },
    })
    .returning();
  if (!running) throw new Error('Missing running report');
  await sweepAgentBriefings(new Date('2026-10-28T08:10:00.000Z'));
  const rows = await db.select().from(agent_briefing_snapshots);
  expect(rows.find(row => row.id === running.id)?.summary.status).toBe('failed');
  expect(rows.find(row => row.id === running.id)?.job_due_at).toBeNull();
  expect(rows.filter(row => row.summary.status === 'pending')).toHaveLength(100);
});

it('recovers a stale due timestamp into the current morning without capturing multiple nights', async () => {
  const user = await insertTestUser();
  await db.insert(agent_briefing_preferences).values({
    kilo_user_id: user.id,
    timezone: 'UTC',
    next_run_at: '2026-10-27T08:00:00.000Z',
  });
  await db.insert(agent_briefing_context_preferences).values({
    kilo_user_id: user.id,
    context_key: 'personal',
    enabled: true,
    model: 'test/snapshot',
  });
  await db.insert(cli_sessions_v2).values([
    {
      kilo_user_id: user.id,
      session_id: 'ses_previous_night',
      last_activity_at: '2026-10-27T02:00:00.000Z',
    },
    {
      kilo_user_id: user.id,
      session_id: 'ses_current_night',
      last_activity_at: '2026-10-28T02:00:00.000Z',
    },
  ]);
  await sweepAgentBriefings(new Date('2026-10-28T08:05:00.000Z'));
  const [row] = await db.select().from(agent_briefing_snapshots);
  expect(row?.local_date).toBe('2026-10-28');
  expect(new Date(row?.night_start_at ?? '').toISOString()).toBe('2026-10-27T22:00:00.000Z');
  expect(new Date(row?.cutoff_at ?? '').toISOString()).toBe('2026-10-28T08:00:00.000Z');
  if (!row) throw new Error('Missing recovered snapshot');
  expect(row.summary.status).toBe('pending');
  expect(briefingFactsSchema.parse(row.facts).sessions.map(session => session.sessionId)).toEqual([
    'ses_current_night',
  ]);
  const [preferences] = await db.select().from(agent_briefing_preferences);
  expect(new Date(preferences?.next_run_at ?? '').toISOString()).toBe('2026-10-29T08:00:00.000Z');
});

it('does not expand an expired recovery occurrence into the following night', async () => {
  const user = await insertTestUser();
  await db.insert(agent_briefing_preferences).values({
    kilo_user_id: user.id,
    timezone: 'UTC',
    next_run_at: '2026-10-26T08:00:00.000Z',
  });
  await db.insert(agent_briefing_context_preferences).values({
    kilo_user_id: user.id,
    context_key: 'personal',
    enabled: true,
    model: 'test/snapshot',
  });
  await db.insert(cli_sessions_v2).values([
    {
      kilo_user_id: user.id,
      session_id: 'ses_recovered_night',
      last_activity_at: '2026-10-27T02:00:00.000Z',
    },
    {
      kilo_user_id: user.id,
      session_id: 'ses_following_night',
      last_activity_at: '2026-10-27T23:00:00.000Z',
    },
  ]);
  await sweepAgentBriefings(new Date('2026-10-28T07:00:00.000Z'));
  const [row] = await db.select().from(agent_briefing_snapshots);
  if (!row) throw new Error('Missing recovered snapshot');
  expect(row.local_date).toBe('2026-10-27');
  expect(row.summary.status).toBe('unavailable');
  expect(briefingFactsSchema.parse(row.facts).sessions.map(session => session.sessionId)).toEqual([
    'ses_recovered_night',
  ]);
});
