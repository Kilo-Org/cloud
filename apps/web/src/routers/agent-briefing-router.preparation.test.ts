import { and, eq, sql } from 'drizzle-orm';
import type * as NextServer from 'next/server';
import { db, cleanupDbForTest } from '@kilocode/web-shared/lib/drizzle';
import {
  agent_briefing_events,
  agent_briefing_preferences,
  agent_briefing_reports,
  cli_sessions_v2,
  organization_memberships,
  organizations,
  type User,
} from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import * as evidence from '@/lib/agent-briefing/evidence';
import type * as Preparation from '@/lib/agent-briefing/preparation';
import type * as Summary from '@/lib/agent-briefing/summary';
import {
  generatePendingOneOffBriefingPreparations,
  runOneOffBriefingPreparation,
} from '@/lib/agent-briefing/preparation';
import { runBriefingSummary } from '@/lib/agent-briefing/summary';
import { generatePendingAgentBriefings, sweepAgentBriefings } from '@/lib/agent-briefing/sweep';
import { agentBriefingRouter } from './agent-briefing-router';

jest.mock('@/lib/agent-briefing/evidence', () => {
  const actual = jest.requireActual<typeof evidence>('@/lib/agent-briefing/evidence');
  return { ...actual, collectBriefingEvidence: jest.fn(actual.collectBriefingEvidence) };
});
jest.mock('@/lib/agent-briefing/preparation', () => {
  const actual = jest.requireActual<typeof Preparation>('@/lib/agent-briefing/preparation');
  return {
    ...actual,
    generatePendingOneOffBriefingPreparations: jest.fn(
      actual.generatePendingOneOffBriefingPreparations
    ),
  };
});
jest.mock('@/lib/agent-briefing/summary', () => {
  const actual = jest.requireActual<typeof Summary>('@/lib/agent-briefing/summary');
  return { ...actual, runBriefingSummary: jest.fn(actual.runBriefingSummary) };
});
const realCollect = jest.requireActual<typeof evidence>(
  '@/lib/agent-briefing/evidence'
).collectBriefingEvidence;
jest.mock('next/server', () => ({
  ...jest.requireActual<typeof NextServer>('next/server'),
  after: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/organizations/effective-model-access.server', () => ({
  resolveOrganizationMemberModelDecision: jest
    .fn()
    .mockResolvedValue({ decision: { allowed: true } }),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  getOpenRouterModelsMetadataFromDatabase: jest.fn().mockResolvedValue({
    '~deepseek/deepseek-flash-latest': {
      id: '~deepseek/deepseek-flash-latest',
      endpoints: [{ pricing: { prompt: '0.000001', completion: '0.000002', request: '0' } }],
    },
  }),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/openrouter', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/ai-gateway/providers/openrouter'),
  getRawOpenRouterModels: jest.fn().mockResolvedValue({
    data: [
      {
        id: '~deepseek/deepseek-flash-latest',
        pricing: { prompt: '0.000001', completion: '0.000002', request: '0' },
      },
    ],
  }),
}));

let user: User;
let other: User;
beforeEach(async () => {
  await cleanupDbForTest();
  jest.clearAllMocks();
  jest.mocked(evidence.collectBriefingEvidence).mockReset().mockImplementation(realCollect);
  user = await insertTestUser({
    id: 'oauth/background-briefing',
    total_microdollars_acquired: 100_000_000,
  });
  other = await insertTestUser({ id: 'oauth/background-briefing-other' });
});
afterEach(() => jest.restoreAllMocks());

function period() {
  const end = Date.now() - 86400_000;
  return {
    requestId: crypto.randomUUID(),
    startAt: new Date(end - 86400_000).toISOString(),
    endAt: new Date(end).toISOString(),
    timezone: 'UTC',
    language: 'en',
  };
}

async function seedActivity(startAt: string, organizationId: string | null = null) {
  const sessionId = `ses_background_${crypto.randomUUID()}`;
  await db.insert(cli_sessions_v2).values({
    session_id: sessionId,
    kilo_user_id: user.id,
    organization_id: organizationId,
    created_on_platform: 'cli',
    title: 'Background activity',
  });
  await db.insert(agent_briefing_events).values({
    id: crypto.randomUUID(),
    session_id: sessionId,
    kilo_user_id: user.id,
    organization_id: organizationId,
    kind: 'activity',
    occurred_at: startAt,
    payload: { excerpt: 'Collected historical activity' },
  });
  return sessionId;
}

it('returns a persisted draft before collecting evidence, survives navigation, and never queues paid work without confirmation', async () => {
  const input = period();
  await seedActivity(input.startAt);
  const collect = jest.mocked(evidence.collectBriefingEvidence);
  const caller = agentBriefingRouter.createCaller({ user });
  const [draft, duplicate] = await Promise.all([
    caller.startOneOffPreparation(input),
    caller.startOneOffPreparation(input),
  ]);
  expect(draft).toMatchObject({ id: input.requestId, status: 'pending', error: null });
  expect(duplicate.id).toBe(draft.id);
  expect(collect).not.toHaveBeenCalled();
  expect((await caller.oneOffDrafts({})).drafts).toEqual([draft]);
  expect((await caller.list()).reports).toEqual([]);
  expect((await caller.oneOffPreparation({ reportId: draft.id })).prepared).toBeNull();
  await expect(caller.createOneOff({ reportId: draft.id })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
  });
  await expect(caller.get({ reportId: draft.id })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
  });
  await expect(caller.prepareOneOff(input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  await expect(
    caller.generateSummary({ reportId: draft.id, estimateToken: 'unused' })
  ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  await expect(
    caller.retrySummary({ reportId: draft.id, estimateToken: 'unused' })
  ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  collect.mockImplementation(realCollect);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const collecting = jest
    .mocked(evidence.collectBriefingEvidence)
    .mockImplementation(async (...args) => {
      started.resolve();
      await release.promise;
      return realCollect(...args);
    });
  const running = runOneOffBriefingPreparation(draft.id);
  await started.promise;
  await runOneOffBriefingPreparation(draft.id);
  expect((await caller.oneOffPreparation({ reportId: draft.id })).draft.status).toBe('running');
  release.resolve();
  await running;
  expect(collecting).toHaveBeenCalledTimes(1);
  const resumedCaller = agentBriefingRouter.createCaller({ user });
  const ready = await resumedCaller.oneOffPreparation({ reportId: draft.id });
  expect(ready.draft.status).toBe('ready');
  expect(ready.prepared?.report.scorecard.sessions).toBe(1);
  expect(ready.prepared?.estimate?.canGenerate).toBe(true);
  const [stored] = await db
    .select()
    .from(agent_briefing_reports)
    .where(eq(agent_briefing_reports.id, draft.id));
  expect(stored).toMatchObject({
    published_at: null,
    generation_id: null,
    summary: { status: 'disabled' },
  });
  expect(await db.select().from(agent_briefing_preferences)).toEqual([]);
  await expect(caller.createOneOff({ reportId: draft.id })).rejects.toMatchObject({
    code: 'BAD_REQUEST',
  });
  const published = await caller.createOneOff({
    reportId: draft.id,
    estimateToken: ready.prepared?.estimate?.estimateToken,
  });
  expect(published.summary.status).toBe('pending');
  expect((await caller.oneOffDrafts({})).drafts).toEqual([]);
});

it('rejects owner, context and input collisions and keeps draft status owner-scoped', async () => {
  const caller = agentBriefingRouter.createCaller({ user });
  const input = period();
  await caller.startOneOffPreparation(input);
  await expect(caller.startOneOffPreparation({ ...input, language: 'sr' })).rejects.toMatchObject({
    code: 'CONFLICT',
  });
  const otherCaller = agentBriefingRouter.createCaller({ user: other });
  await expect(otherCaller.startOneOffPreparation(input)).rejects.toMatchObject({
    code: 'CONFLICT',
  });
  await expect(otherCaller.oneOffPreparation({ reportId: input.requestId })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  expect((await otherCaller.oneOffDrafts({})).drafts).toEqual([]);
  expect(await db.select().from(agent_briefing_reports)).toHaveLength(1);
});

it('persists terminal failures and retries only after another explicit start with the same identity', async () => {
  const caller = agentBriefingRouter.createCaller({ user });
  const input = period();
  await caller.startOneOffPreparation(input);
  const collect = jest
    .mocked(evidence.collectBriefingEvidence)
    .mockRejectedValueOnce(new Error('Database unavailable'));
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  await runOneOffBriefingPreparation(input.requestId);
  expect((await caller.oneOffPreparation({ reportId: input.requestId })).draft).toMatchObject({
    status: 'failed',
    error: 'collection_failed',
  });
  await generatePendingOneOffBriefingPreparations();
  expect(collect).toHaveBeenCalledTimes(1);
  collect.mockImplementation(realCollect);
  expect((await caller.startOneOffPreparation(input)).status).toBe('pending');
  await runOneOffBriefingPreparation(input.requestId);
  const result = await caller.oneOffPreparation({ reportId: input.requestId });
  expect(result.draft.status).toBe('ready');
  expect(result.prepared?.estimate).toBeNull();
  expect(await db.select().from(agent_briefing_reports)).toHaveLength(1);
});

it('marks abandoned work as timed out on read and fences a stale worker after an explicit retry', async () => {
  const caller = agentBriefingRouter.createCaller({ user });
  const input = period();
  await seedActivity(input.startAt);
  await caller.startOneOffPreparation(input);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  jest.mocked(evidence.collectBriefingEvidence).mockImplementationOnce(async (...args) => {
    started.resolve();
    await release.promise;
    return realCollect(...args);
  });
  const stale = runOneOffBriefingPreparation(input.requestId);
  await started.promise;
  await db
    .update(agent_briefing_reports)
    .set({
      facts: sql`jsonb_set(${agent_briefing_reports.facts}, '{preparation,deadlineAt}', ${JSON.stringify(new Date(Date.now() - 1000).toISOString())}::jsonb)`,
      next_refresh_at: new Date(Date.now() - 1000).toISOString(),
    })
    .where(eq(agent_briefing_reports.id, input.requestId));
  const failed = await caller.oneOffPreparation({ reportId: input.requestId });
  expect(failed.draft).toMatchObject({ status: 'failed', error: 'time_limit' });
  await caller.startOneOffPreparation(input);
  await runOneOffBriefingPreparation(input.requestId);
  const ready = await caller.oneOffPreparation({ reportId: input.requestId });
  release.resolve();
  await stale;
  expect((await caller.oneOffPreparation({ reportId: input.requestId })).prepared?.report).toEqual(
    ready.prepared?.report
  );
  expect(ready.draft.status).toBe('ready');
});

it('recovers a pending draft through the existing summary scheduler without scheduling or paying for a summary', async () => {
  const caller = agentBriefingRouter.createCaller({ user });
  const input = period();
  await caller.startOneOffPreparation(input);
  expect(await generatePendingAgentBriefings()).toMatchObject({
    attempted: 0,
    preparations: { attempted: 1, rejected: 0 },
  });
  const ready = await caller.oneOffPreparation({ reportId: input.requestId });
  expect(ready.draft.status).toBe('ready');
  const [stored] = await db.select().from(agent_briefing_reports);
  expect(stored).toMatchObject({
    next_refresh_at: null,
    published_at: null,
    generation_id: null,
    summary: { status: 'disabled' },
  });
});

it('returns completed summary jobs when preparation scheduling rejects', async () => {
  const caller = agentBriefingRouter.createCaller({ user });
  const input = period();
  await seedActivity(input.startAt);
  await caller.startOneOffPreparation(input);
  await runOneOffBriefingPreparation(input.requestId);
  const ready = await caller.oneOffPreparation({ reportId: input.requestId });
  await caller.createOneOff({
    reportId: input.requestId,
    estimateToken: ready.prepared?.estimate?.estimateToken,
  });
  const schedulingError = new Error('Preparation scheduling unavailable');
  const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.mocked(generatePendingOneOffBriefingPreparations).mockRejectedValueOnce(schedulingError);
  jest.mocked(runBriefingSummary).mockResolvedValueOnce();
  expect(await generatePendingAgentBriefings()).toEqual({
    attempted: 1,
    fulfilled: 1,
    rejected: 0,
    preparations: null,
  });
  expect(runBriefingSummary).toHaveBeenCalledWith(input.requestId);
  expect(logged).toHaveBeenCalledWith(
    'Agent briefing preparation scheduler rejected',
    schedulingError
  );
});

it('returns a published report when an owner resumes its preparation link', async () => {
  const caller = agentBriefingRouter.createCaller({ user });
  const input = period();
  await seedActivity(input.startAt);
  await caller.startOneOffPreparation(input);
  await runOneOffBriefingPreparation(input.requestId);
  const ready = await caller.oneOffPreparation({ reportId: input.requestId });
  const published = await caller.createOneOff({
    reportId: input.requestId,
    estimateToken: ready.prepared?.estimate?.estimateToken,
  });
  const resumedCaller = agentBriefingRouter.createCaller({ user });
  const resumed = await resumedCaller.oneOffPreparation({ reportId: input.requestId });
  expect(resumed.prepared?.report).toEqual(published);
  expect(resumed.prepared?.report.publishedAt).not.toBeNull();
  expect((await resumedCaller.oneOffDrafts({})).drafts).toEqual([]);
  expect(await resumedCaller.createOneOff({ reportId: input.requestId })).toEqual(published);
});

it('expires abandoned pending and running attempts and clears their due markers', async () => {
  const caller = agentBriefingRouter.createCaller({ user });
  const pending = await caller.startOneOffPreparation(period());
  const running = await caller.startOneOffPreparation(period());
  const expiredAt = new Date(Date.now() - 1000).toISOString();
  await db
    .update(agent_briefing_reports)
    .set({
      next_refresh_at: expiredAt,
      facts: sql`jsonb_set(${agent_briefing_reports.facts}, '{preparation,deadlineAt}', ${JSON.stringify(expiredAt)}::jsonb)`,
    })
    .where(eq(agent_briefing_reports.kilo_user_id, user.id));
  await db
    .update(agent_briefing_reports)
    .set({
      facts: sql`jsonb_set(${agent_briefing_reports.facts}, '{preparation,status}', '"running"'::jsonb)`,
    })
    .where(eq(agent_briefing_reports.id, running.id));
  expect(await generatePendingOneOffBriefingPreparations()).toEqual({ attempted: 0, rejected: 0 });
  expect((await caller.oneOffPreparation({ reportId: pending.id })).draft).toMatchObject({
    status: 'failed',
    error: 'time_limit',
  });
  expect((await caller.oneOffPreparation({ reportId: running.id })).draft).toMatchObject({
    status: 'failed',
    error: 'time_limit',
  });
  expect(
    await db.select({ dueAt: agent_briefing_reports.next_refresh_at }).from(agent_briefing_reports)
  ).toEqual([{ dueAt: null }, { dueAt: null }]);
  expect(evidence.collectBriefingEvidence).not.toHaveBeenCalled();
});

it('keeps one-off preparations out of scheduled refresh and processes five due drafts per batch', async () => {
  const caller = agentBriefingRouter.createCaller({ user });
  const future = await caller.startOneOffPreparation(period());
  await db
    .update(agent_briefing_reports)
    .set({ next_refresh_at: new Date(Date.now() + 60_000).toISOString() })
    .where(eq(agent_briefing_reports.id, future.id));
  await Promise.all(Array.from({ length: 6 }, () => caller.startOneOffPreparation(period())));
  expect(await sweepAgentBriefings()).toMatchObject({ activeReports: 0 });
  expect(evidence.collectBriefingEvidence).not.toHaveBeenCalled();
  expect(await generatePendingOneOffBriefingPreparations()).toEqual({ attempted: 5, rejected: 0 });
  expect(await generatePendingOneOffBriefingPreparations()).toEqual({ attempted: 1, rejected: 0 });
  expect(
    (await db.select({ revision: agent_briefing_reports.revision }).from(agent_briefing_reports))
      .map(row => row.revision)
      .sort()
  ).toEqual([0, 1, 1, 1, 1, 1, 1]);
});

it('stops exposing an organization draft when membership is revoked before collection', async () => {
  const organizationId = crypto.randomUUID();
  await db
    .insert(organizations)
    .values({ id: organizationId, name: 'Draft organization', created_by_kilo_user_id: user.id });
  await db
    .insert(organization_memberships)
    .values({ organization_id: organizationId, kilo_user_id: user.id, role: 'member' });
  const caller = agentBriefingRouter.createCaller({ user });
  const input = { ...period(), organizationId };
  await seedActivity(input.startAt, organizationId);
  await caller.startOneOffPreparation(input);
  await db
    .delete(organization_memberships)
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(organization_memberships.kilo_user_id, user.id)
      )
    );
  const collect = jest.mocked(evidence.collectBriefingEvidence);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  await runOneOffBriefingPreparation(input.requestId);
  expect(collect).not.toHaveBeenCalled();
  expect((await caller.oneOffDrafts({})).drafts).toEqual([]);
  await expect(caller.oneOffPreparation({ reportId: input.requestId })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
});

it('paginates unconfirmed drafts without publishing any of them', async () => {
  const caller = agentBriefingRouter.createCaller({ user });
  const drafts = await Promise.all(
    Array.from({ length: 3 }, () => caller.startOneOffPreparation(period()))
  );
  const first = await caller.oneOffDrafts({ limit: 2 });
  expect(first.drafts).toHaveLength(2);
  expect(first.nextCursor).not.toBeNull();
  const second = await caller.oneOffDrafts({ limit: 2, cursor: first.nextCursor ?? undefined });
  expect(second.drafts).toHaveLength(1);
  expect(new Set([...first.drafts, ...second.drafts].map(draft => draft.id))).toEqual(
    new Set(drafts.map(draft => draft.id))
  );
  expect(second.nextCursor).toBeNull();
});
