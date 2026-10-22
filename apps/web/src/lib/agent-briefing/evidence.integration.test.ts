import { eq } from 'drizzle-orm';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import {
  agent_briefing_events,
  agent_briefing_preferences,
  agent_briefing_reports,
  cli_sessions_v2,
  microdollar_usage,
  microdollar_usage_metadata,
  type User,
} from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  BRIEFING_MAX_SESSIONS,
  BRIEFING_MAX_SOURCES,
  BRIEFING_MAX_SOURCES_PER_SESSION,
  briefingReportSchema,
  type BriefingReport,
  type BriefingSource,
} from '@kilocode/app-shared/agent-briefing';
import { agentBriefingRouter } from '@/routers/agent-briefing-router';
import {
  BRIEFING_MAX_EVENT_ROWS,
  BRIEFING_MAX_USAGE_ROWS,
  collectBriefingEvidence,
} from './evidence';
import { emptySummary, refreshBriefingEvidence } from './store';

type Facts = Pick<BriefingReport, 'sessions' | 'sources' | 'scorecard' | 'coverage'>;
const factsSchema = briefingReportSchema.pick({
  sessions: true,
  sources: true,
  scorecard: true,
  coverage: true,
});
const completeCoverage = {
  activity: 'complete',
  spend: 'complete',
  blockers: 'complete',
  pullRequests: 'complete',
} satisfies Facts['coverage'];
const partialCoverage = {
  activity: 'partial',
  spend: 'partial',
  blockers: 'partial',
  pullRequests: 'partial',
} satisfies Facts['coverage'];
let user: User;
let nightStartAt: string;
let cutoffAt: string;
let morningEndAt: string;
let activityAt: string;

beforeEach(async () => {
  await cleanupDbForTest();
  user = await insertTestUser({ id: 'oauth/briefing-collection-owner', is_admin: false });
  const cutoff = Date.now() - 3600_000;
  cutoffAt = new Date(cutoff).toISOString();
  nightStartAt = new Date(cutoff - 10 * 3600_000).toISOString();
  morningEndAt = new Date(cutoff + 3 * 3600_000).toISOString();
  activityAt = new Date(cutoff - 9 * 3600_000).toISOString();
  await db.insert(agent_briefing_preferences).values({
    kilo_user_id: user.id,
    timezone: 'UTC',
    next_run_at: morningEndAt,
    created_at: new Date(Date.parse(nightStartAt) - 3600_000).toISOString(),
  });
});

async function seedSessions(ids: string[]) {
  await db.insert(cli_sessions_v2).values(
    ids.map(sessionId => ({
      session_id: sessionId,
      kilo_user_id: user.id,
      title: `Session ${sessionId}`,
      created_on_platform: 'cli',
    }))
  );
}

async function seedUsage(
  rows: { id: string; sessionId: string; cost: number; occurredAt: string }[]
) {
  await db.insert(microdollar_usage).values(
    rows.map(row => ({
      id: row.id,
      kilo_user_id: user.id,
      cost: row.cost,
      input_tokens: 10,
      output_tokens: 5,
      cache_write_tokens: 0,
      cache_hit_tokens: 0,
      created_at: row.occurredAt,
    }))
  );
  await db.insert(microdollar_usage_metadata).values(
    rows.map(row => ({
      id: row.id,
      session_id: row.sessionId,
      message_id: `message:${row.id}`,
    }))
  );
}

function collect() {
  return collectBriefingEvidence(user.id, null, nightStartAt, cutoffAt, morningEndAt);
}

async function persistFacts(facts: Facts) {
  const [report] = await db
    .insert(agent_briefing_reports)
    .values({
      kilo_user_id: user.id,
      context_key: 'personal',
      kind: 'scheduled',
      local_date: cutoffAt.slice(0, 10),
      night_start_at: nightStartAt,
      cutoff_at: cutoffAt,
      morning_end_at: morningEndAt,
      facts,
      evidence_hash: 'collected-evidence',
      summary: emptySummary,
      published_at: new Date().toISOString(),
    })
    .returning();
  if (!report) throw new Error('Report fixture was not inserted');
  return report.id;
}

async function expectStoredAndReadable(reportId: string, facts: Facts) {
  const [stored] = await db
    .select({ facts: agent_briefing_reports.facts })
    .from(agent_briefing_reports)
    .where(eq(agent_briefing_reports.id, reportId));
  expect(stored?.facts).toEqual(facts);
  expect(factsSchema.parse(stored?.facts)).toEqual(facts);
  const caller = agentBriefingRouter.createCaller({ user });
  const report = await caller.get({ reportId });
  expect(factsSchema.parse(report)).toEqual(facts);
  const listed = await caller.list({ scope: 'personal' });
  expect(listed.reports).toHaveLength(1);
  expect(listed.reports[0]).toEqual(report);
  return report;
}

function expectBoundedFacts(facts: Facts) {
  expect(facts.sessions.length).toBeLessThanOrEqual(BRIEFING_MAX_SESSIONS);
  expect(facts.sources.length).toBeLessThanOrEqual(BRIEFING_MAX_SOURCES);
  expect(facts.sources.length).toBeGreaterThan(0);
  for (const session of facts.sessions) {
    expect(session.sources.length).toBeLessThanOrEqual(BRIEFING_MAX_SOURCES_PER_SESSION);
  }
}

describe('scheduled briefing evidence collection', () => {
  it('stores complete exact facts for a normal owned session window', async () => {
    const rootId = 'ses_collection_root';
    const childId = 'ses_collection_child';
    const rootUrl = `/cloud/sessions/${rootId}`;
    await seedSessions([rootId]);
    await db.insert(cli_sessions_v2).values({
      session_id: childId,
      kilo_user_id: user.id,
      parent_session_id: rootId,
      title: 'Child session',
      created_on_platform: 'cli',
    });
    const pullRequestAt = new Date(Date.parse(activityAt) + 1000).toISOString();
    const usageAt = new Date(Date.parse(activityAt) + 2000).toISOString();
    await db.insert(agent_briefing_events).values([
      {
        id: 'normal-activity',
        kilo_user_id: user.id,
        session_id: childId,
        kind: 'activity',
        occurred_at: activityAt,
        recorded_at: cutoffAt,
        payload: { excerpt: 'Completed the requested changes' },
      },
      {
        id: 'normal-pull-request',
        kilo_user_id: user.id,
        session_id: rootId,
        kind: 'pull_request',
        title: 'Requested changes',
        url: 'https://github.com/example/project/pull/1',
        occurred_at: pullRequestAt,
        recorded_at: cutoffAt,
      },
      ...[new Date(Date.parse(nightStartAt) - 1).toISOString(), cutoffAt].map(
        (occurredAt, index) => ({
          id: `outside-window-${index}`,
          kilo_user_id: user.id,
          session_id: rootId,
          kind: 'pull_request',
          title: 'Other window',
          url: `https://github.com/example/project/pull/${index + 2}`,
          occurred_at: occurredAt,
          recorded_at: cutoffAt,
        })
      ),
    ]);
    const chargeId = crypto.randomUUID();
    await seedUsage([
      { id: chargeId, sessionId: childId, cost: 29_000, occurredAt: usageAt },
      { id: crypto.randomUUID(), sessionId: childId, cost: 99_000, occurredAt: cutoffAt },
    ]);
    const sources: BriefingSource[] = [
      {
        id: 'normal-activity',
        sessionId: childId,
        kind: 'activity',
        title: 'Session activity',
        url: rootUrl,
        occurredAt: activityAt,
        excerpt: 'Completed the requested changes',
      },
      {
        id: 'normal-pull-request',
        sessionId: rootId,
        kind: 'pull_request',
        title: 'Requested changes',
        url: 'https://github.com/example/project/pull/1',
        occurredAt: pullRequestAt,
      },
      {
        id: `usage:${chargeId}`,
        sessionId: childId,
        kind: 'cost',
        title: 'Recorded usage charge',
        url: rootUrl,
        occurredAt: usageAt,
      },
    ];
    const expected: Facts = {
      scorecard: { sessions: 1, pullRequests: 1, blockers: 0, spendMicrodollars: 29_000 },
      coverage: completeCoverage,
      sessions: [
        {
          sessionId: rootId,
          title: `Session ${rootId}`,
          url: rootUrl,
          status: null,
          spendMicrodollars: 29_000,
          sources,
        },
      ],
      sources,
    };
    const facts = await collect();
    expect(facts).toEqual(expected);
    const reportId = await persistFacts(facts);
    await expectStoredAndReadable(reportId, expected);
  });

  it('consumes the scheduled event row budget and stores partial bounded facts', async () => {
    const sessionId = 'ses_event_budget';
    await seedSessions([sessionId]);
    await db.insert(agent_briefing_events).values([
      {
        id: 'prior-question',
        kilo_user_id: user.id,
        session_id: sessionId,
        kind: 'status',
        status: 'question',
        occurred_at: new Date(Date.parse(nightStartAt) - 1).toISOString(),
      },
      {
        id: 'resolved-question',
        kilo_user_id: user.id,
        session_id: sessionId,
        kind: 'status',
        status: 'idle',
        occurred_at: new Date(Date.parse(activityAt) - 1).toISOString(),
      },
    ]);
    await db.insert(agent_briefing_events).values(
      Array.from({ length: BRIEFING_MAX_EVENT_ROWS + 1 }, (_, index) => ({
        id: `scheduled-event-${index}`,
        kilo_user_id: user.id,
        session_id: sessionId,
        kind: 'pull_request',
        title: `Change ${index}`,
        url: `https://github.com/example/project/pull/${index + 1}`,
        occurred_at: new Date(Date.parse(activityAt) + index).toISOString(),
        recorded_at: cutoffAt,
      }))
    );
    const facts = await collect();
    expect(facts.scorecard).toEqual({
      sessions: 1,
      pullRequests: BRIEFING_MAX_EVENT_ROWS,
      blockers: 0,
      spendMicrodollars: 0,
    });
    expect(facts.coverage).toEqual(partialCoverage);
    expect(facts.sessions[0]?.status).toBeNull();
    expect(
      facts.sources.some(source => source.id === `scheduled-event-${BRIEFING_MAX_EVENT_ROWS}`)
    ).toBe(true);
    expect(facts.sources.some(source => source.id === 'scheduled-event-0')).toBe(false);
    expectBoundedFacts(facts);
    const reportId = await persistFacts(facts);
    expectBoundedFacts(await expectStoredAndReadable(reportId, facts));
  });

  it('applies scheduled usage accounting', async () => {
    const sessionId = 'ses_usage_budget';
    await seedSessions([sessionId]);
    await seedUsage(
      Array.from({ length: BRIEFING_MAX_USAGE_ROWS + 1 }, (_, index) => ({
        id: crypto.randomUUID(),
        sessionId,
        cost: index === 0 ? 1_000_000 : 7,
        occurredAt: new Date(Date.parse(activityAt) + index).toISOString(),
      }))
    );
    const facts = await collect();
    expect(facts.scorecard).toEqual({
      sessions: 1,
      pullRequests: 0,
      blockers: 0,
      spendMicrodollars: BRIEFING_MAX_USAGE_ROWS * 7,
    });
    expect(facts.sessions[0]?.spendMicrodollars).toBe(BRIEFING_MAX_USAGE_ROWS * 7);
    expect(facts.coverage).toEqual(partialCoverage);
    expectBoundedFacts(facts);
    const reportId = await persistFacts(facts);
    expectBoundedFacts(await expectStoredAndReadable(reportId, facts));
  });

  it('refreshes scheduled facts and retires the previous summary', async () => {
    const sessionId = 'ses_refresh_contract';
    await seedSessions([sessionId]);
    const facts = await collect();
    const reportId = await persistFacts(facts);
    const [stored] = await db
      .update(agent_briefing_reports)
      .set({
        facts: {
          ...facts,
          sessions: [
            {
              sessionId,
              title: 'Title '.repeat(40),
              url: `/cloud/sessions/${sessionId}`,
              status: null,
              spendMicrodollars: 0,
              sources: [],
            },
          ],
        },
        summary: { ...emptySummary, status: 'ready', text: 'Previous summary' },
      })
      .where(eq(agent_briefing_reports.id, reportId))
      .returning();
    if (!stored) throw new Error('Missing scheduled fixture');
    const refreshed = await refreshBriefingEvidence(stored);
    expect(refreshed.facts).toEqual(facts);
    expect(refreshed.revision).toBe(stored.revision + 1);
    expect(refreshed.summary).toMatchObject({ status: 'outdated', text: null, canRetry: false });
  });

  it('resolves parents when every active session is a child', async () => {
    const roots = Array.from({ length: 256 }, (_, index) => `ses_root_${index}`);
    const children = roots.map((_, index) => `ses_child_${index}`);
    await seedSessions(roots);
    await db.insert(cli_sessions_v2).values(
      children.map((sessionId, index) => ({
        session_id: sessionId,
        kilo_user_id: user.id,
        parent_session_id: roots[index],
        title: `Child ${index}`,
        created_on_platform: 'cli',
      }))
    );
    await db.insert(agent_briefing_events).values(
      children.map((sessionId, index) => ({
        id: `child-activity-${index}`,
        kilo_user_id: user.id,
        session_id: sessionId,
        kind: 'activity',
        occurred_at: new Date(Date.parse(activityAt) + index).toISOString(),
      }))
    );
    const facts = await collect();
    expect(facts.scorecard.sessions).toBe(256);
    expect(facts.sessions).toHaveLength(BRIEFING_MAX_SESSIONS);
    expect(facts.sessions.every(session => session.sessionId.startsWith('ses_root_'))).toBe(true);
    expect(await expectStoredAndReadable(await persistFacts(facts), facts)).toBeTruthy();
  });

  it('selects recently active sessions for the report', async () => {
    const sessionIds = Array.from({ length: 257 }, (_, index) => `ses_recent_${index}`);
    await seedSessions(sessionIds);
    await db.insert(agent_briefing_events).values(
      sessionIds.map((sessionId, index) => ({
        id: `recent-${index}`,
        kilo_user_id: user.id,
        session_id: sessionId,
        kind: 'activity',
        occurred_at: new Date(Date.parse(activityAt) + index).toISOString(),
      }))
    );
    const facts = await collect();
    expect(facts.sessions).toHaveLength(BRIEFING_MAX_SESSIONS);
    expect(facts.sessions.some(session => session.sessionId === 'ses_recent_256')).toBe(true);
    expect(facts.sessions.some(session => session.sessionId === 'ses_recent_0')).toBe(false);
    expect(facts.scorecard.sessions).toBe(256);
    expect(facts.coverage.activity).toBe('partial');
  });
});

const arrayBoundaries = [
  { field: 'sessions', maximum: BRIEFING_MAX_SESSIONS },
  { field: 'sources', maximum: BRIEFING_MAX_SOURCES },
  { field: 'sessionSources', maximum: BRIEFING_MAX_SOURCES_PER_SESSION },
] as const;

describe('stored briefing array boundaries', () => {
  it.each(arrayBoundaries)(
    'reads $field at the maximum and skips a longer stored array',
    async ({ field, maximum }) => {
      const sessionIds = Array.from(
        { length: field === 'sessions' ? maximum + 1 : 1 },
        (_, index) => `ses_schema_boundary_${index}`
      );
      await seedSessions(sessionIds);
      const sessionId = sessionIds[0];
      if (!sessionId) throw new Error('Missing session fixture');
      const factsForLength = (length: number): Facts => {
        const sources: BriefingSource[] =
          field === 'sessions'
            ? []
            : Array.from({ length }, (_, index) => ({
                id: `source-${index}`,
                sessionId,
                kind: 'activity',
                title: 'Session activity',
                url: `/cloud/sessions/${sessionId}`,
                occurredAt: activityAt,
              }));
        return {
          scorecard: {
            sessions: field === 'sessions' ? length : 1,
            pullRequests: 0,
            blockers: 0,
            spendMicrodollars: 0,
          },
          coverage: completeCoverage,
          sessions: (field === 'sessions' ? sessionIds.slice(0, length) : [sessionId]).map(id => ({
            sessionId: id,
            title: `Session ${id}`,
            url: `/cloud/sessions/${id}`,
            status: null,
            spendMicrodollars: 0,
            sources: field === 'sessionSources' ? sources : [],
          })),
          sources,
        };
      };
      const maximumFacts = factsForLength(maximum);
      const reportId = await persistFacts(maximumFacts);
      await expectStoredAndReadable(reportId, maximumFacts);
      const longerFacts = factsForLength(maximum + 1);
      expect(factsSchema.safeParse(longerFacts).success).toBe(false);
      await db
        .update(agent_briefing_reports)
        .set({ facts: longerFacts })
        .where(eq(agent_briefing_reports.id, reportId));
      const caller = agentBriefingRouter.createCaller({ user });
      await expect(caller.get({ reportId })).rejects.toThrow();
      const log = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect((await caller.list({ scope: 'personal' })).reports).toEqual([]);
        expect(log).toHaveBeenCalledWith(
          'Agent briefing report skipped',
          expect.objectContaining({ reportId })
        );
      } finally {
        log.mockRestore();
      }
    }
  );
});
