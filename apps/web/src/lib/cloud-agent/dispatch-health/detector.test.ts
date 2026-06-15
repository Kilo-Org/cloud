import { db } from '@/lib/drizzle';
import { cloud_agent_session_runs, cloud_agent_sessions } from '@kilocode/db/schema';
import { inArray } from 'drizzle-orm';
import { evaluateDispatchHealth } from './detector';

const TEST_PREFIX = `dispatch-health-${Date.now()}`;
const REFERENCE_TIME = new Date('2040-06-10T12:00:00.000Z');
type SessionInsert = typeof cloud_agent_sessions.$inferInsert;
type RunInsert = typeof cloud_agent_session_runs.$inferInsert;

function minutesBeforeReference(minutes: number): string {
  return new Date(REFERENCE_TIME.getTime() - minutes * 60 * 1000).toISOString();
}

describe('dispatch health detector', () => {
  const insertedSessionIds: string[] = [];
  let sessionSequence = 0;
  let runSequence = 0;

  function sessionValues(overrides: Partial<SessionInsert> = {}): SessionInsert {
    const sequence = sessionSequence++;

    return {
      cloud_agent_session_id: `${TEST_PREFIX}-cloud-session-${sequence}`,
      kilo_session_id: `${TEST_PREFIX}-kilo-session-${sequence}`,
      initial_message_id: `${TEST_PREFIX}-initial-message-${sequence}`,
      created_at: minutesBeforeReference(20),
      ...overrides,
    } satisfies SessionInsert;
  }

  function runValues(session: SessionInsert, overrides: Partial<RunInsert> = {}): RunInsert {
    const sequence = runSequence++;
    const queuedAt = minutesBeforeReference(10);

    return {
      cloud_agent_session_id: session.cloud_agent_session_id,
      message_id: `${TEST_PREFIX}-message-${sequence}`,
      status: 'completed',
      queued_at: queuedAt,
      terminal_at: queuedAt,
      ...overrides,
    } satisfies RunInsert;
  }

  async function insertFixtures(sessions: SessionInsert[], runs: RunInsert[]): Promise<void> {
    await db.insert(cloud_agent_sessions).values(sessions);
    insertedSessionIds.push(...sessions.map(session => session.cloud_agent_session_id));
    await db.insert(cloud_agent_session_runs).values(runs);
  }

  async function insertThresholdCohort(
    stuckMinutesBeforeReference: number[] = [14, 12, 10]
  ): Promise<void> {
    const sessions = Array.from({ length: 30 }, () => sessionValues());
    const runs = sessions.map((session, index) =>
      index < stuckMinutesBeforeReference.length
        ? runValues(session, {
            status: 'queued',
            queued_at: minutesBeforeReference(stuckMinutesBeforeReference[index]),
            terminal_at: null,
          })
        : runValues(session)
    );
    await insertFixtures(sessions, runs);
  }

  afterEach(async () => {
    if (insertedSessionIds.length === 0) return;

    await db
      .delete(cloud_agent_sessions)
      .where(inArray(cloud_agent_sessions.cloud_agent_session_id, insertedSessionIds));
    insertedSessionIds.length = 0;
  });

  it('returns healthy for an empty eligible cohort', async () => {
    await expect(evaluateDispatchHealth(db, REFERENCE_TIME)).resolves.toEqual({
      tripped: false,
    });
  });

  it('trips at a 10% stuck rate across three affected sessions', async () => {
    await insertThresholdCohort();

    await expect(evaluateDispatchHealth(db, REFERENCE_TIME)).resolves.toEqual({
      tripped: true,
      details: {
        eligibleRunCount: 30,
        stuckRunCount: 3,
        affectedSessionCount: 3,
        stuckRate: 0.1,
        oldestStuckQueuedAt: '2040-06-10T11:46:00.000Z',
      },
    });
  });

  it('excludes runs younger than the dispatch grace from the cohort', async () => {
    await insertThresholdCohort();
    const session = sessionValues();
    await insertFixtures(
      [session],
      [
        runValues(session, {
          status: 'queued',
          queued_at: minutesBeforeReference(4),
          terminal_at: null,
        }),
      ]
    );

    await expect(evaluateDispatchHealth(db, REFERENCE_TIME)).resolves.toMatchObject({
      tripped: true,
      details: {
        eligibleRunCount: 30,
        stuckRunCount: 3,
        affectedSessionCount: 3,
        stuckRate: 0.1,
      },
    });
  });

  it('excludes runs older than the cohort window', async () => {
    await insertThresholdCohort();
    const session = sessionValues();
    await insertFixtures(
      [session],
      [
        runValues(session, {
          status: 'queued',
          queued_at: minutesBeforeReference(16),
          terminal_at: null,
        }),
      ]
    );

    await expect(evaluateDispatchHealth(db, REFERENCE_TIME)).resolves.toMatchObject({
      tripped: true,
      details: {
        eligibleRunCount: 30,
        stuckRunCount: 3,
        affectedSessionCount: 3,
        stuckRate: 0.1,
      },
    });
  });

  it('includes the cohort lower bound and excludes the grace boundary', async () => {
    await insertThresholdCohort([15, 12, 10]);
    const session = sessionValues();
    await insertFixtures(
      [session],
      [
        runValues(session, {
          status: 'queued',
          queued_at: minutesBeforeReference(5),
          terminal_at: null,
        }),
      ]
    );

    await expect(evaluateDispatchHealth(db, REFERENCE_TIME)).resolves.toEqual({
      tripped: true,
      details: {
        eligibleRunCount: 30,
        stuckRunCount: 3,
        affectedSessionCount: 3,
        stuckRate: 0.1,
        oldestStuckQueuedAt: '2040-06-10T11:45:00.000Z',
      },
    });
  });

  it('excludes runs whose parent session has a classified setup failure', async () => {
    await insertThresholdCohort();
    const session = sessionValues({
      failure_at: minutesBeforeReference(11),
      failure_stage: 'initial_admission',
      failure_code: 'initial_admission_rejected',
    });
    await insertFixtures(
      [session],
      [
        runValues(session, {
          status: 'queued',
          terminal_at: null,
        }),
      ]
    );

    await expect(evaluateDispatchHealth(db, REFERENCE_TIME)).resolves.toMatchObject({
      tripped: true,
      details: {
        eligibleRunCount: 30,
        stuckRunCount: 3,
        affectedSessionCount: 3,
        stuckRate: 0.1,
      },
    });
  });

  it('includes initial and follow-up message runs', async () => {
    const sessions = Array.from({ length: 39 }, () => sessionValues());
    const firstSession = sessions[0];
    const runs = [
      runValues(firstSession, {
        message_id: firstSession.initial_message_id,
        status: 'queued',
        terminal_at: null,
      }),
      runValues(firstSession, { status: 'queued', terminal_at: null }),
      runValues(sessions[1], { status: 'queued', terminal_at: null }),
      runValues(sessions[2], { status: 'queued', terminal_at: null }),
      ...sessions.slice(3).map(session => runValues(session)),
    ];
    await insertFixtures(sessions, runs);

    await expect(evaluateDispatchHealth(db, REFERENCE_TIME)).resolves.toMatchObject({
      tripped: true,
      details: {
        eligibleRunCount: 40,
        stuckRunCount: 4,
        affectedSessionCount: 3,
        stuckRate: 0.1,
      },
    });
  });

  it('keeps non-queued lifecycle statuses in the denominator only', async () => {
    const sessions = Array.from({ length: 30 }, () => sessionValues());
    const milestoneAt = minutesBeforeReference(9);
    const runs = sessions.map((session, index) => {
      if (index < 3) return runValues(session, { status: 'queued', terminal_at: null });
      if (index === 3) {
        return runValues(session, {
          status: 'accepted',
          dispatch_accepted_at: milestoneAt,
          terminal_at: null,
        });
      }
      if (index === 4) return runValues(session, { status: 'completed' });
      if (index === 5) return runValues(session, { status: 'failed' });
      if (index === 6) return runValues(session, { status: 'interrupted' });
      return runValues(session);
    });
    await insertFixtures(sessions, runs);

    await expect(evaluateDispatchHealth(db, REFERENCE_TIME)).resolves.toMatchObject({
      tripped: true,
      details: {
        eligibleRunCount: 30,
        stuckRunCount: 3,
        affectedSessionCount: 3,
        stuckRate: 0.1,
      },
    });
  });

  it('does not count a queued run with dispatch acceptance as stuck', async () => {
    const sessions = Array.from({ length: 30 }, () => sessionValues());
    const runs = sessions.map((session, index) => {
      if (index < 3) return runValues(session, { status: 'queued', terminal_at: null });
      if (index === 3) {
        return runValues(session, {
          status: 'queued',
          dispatch_accepted_at: minutesBeforeReference(9),
          terminal_at: null,
        });
      }
      return runValues(session);
    });
    await insertFixtures(sessions, runs);

    await expect(evaluateDispatchHealth(db, REFERENCE_TIME)).resolves.toMatchObject({
      tripped: true,
      details: {
        eligibleRunCount: 30,
        stuckRunCount: 3,
        affectedSessionCount: 3,
        stuckRate: 0.1,
      },
    });
  });

  it('does not count a queued run with a terminal timestamp as stuck', async () => {
    const sessions = Array.from({ length: 30 }, () => sessionValues());
    const runs = sessions.map((session, index) => {
      if (index < 3) return runValues(session, { status: 'queued', terminal_at: null });
      if (index === 3) return runValues(session, { status: 'queued' });
      return runValues(session);
    });
    await insertFixtures(sessions, runs);

    await expect(evaluateDispatchHealth(db, REFERENCE_TIME)).resolves.toMatchObject({
      tripped: true,
      details: {
        eligibleRunCount: 30,
        stuckRunCount: 3,
        affectedSessionCount: 3,
        stuckRate: 0.1,
      },
    });
  });

  it('stays healthy above the rate threshold when fewer than three sessions are affected', async () => {
    const sessions = Array.from({ length: 10 }, () => sessionValues());
    const runs = sessions.map((session, index) =>
      index < 2 ? runValues(session, { status: 'queued', terminal_at: null }) : runValues(session)
    );
    await insertFixtures(sessions, runs);

    await expect(evaluateDispatchHealth(db, REFERENCE_TIME)).resolves.toEqual({
      tripped: false,
    });
  });

  it('stays healthy with three affected sessions below the rate threshold', async () => {
    const sessions = Array.from({ length: 31 }, () => sessionValues());
    const runs = sessions.map((session, index) =>
      index < 3 ? runValues(session, { status: 'queued', terminal_at: null }) : runValues(session)
    );
    await insertFixtures(sessions, runs);

    await expect(evaluateDispatchHealth(db, REFERENCE_TIME)).resolves.toEqual({
      tripped: false,
    });
  });

  it('counts multiple stuck runs in one session once toward affected sessions', async () => {
    const sessions = Array.from({ length: 39 }, () => sessionValues());
    const runs = [
      runValues(sessions[0], { status: 'queued', terminal_at: null }),
      runValues(sessions[0], { status: 'queued', terminal_at: null }),
      runValues(sessions[1], { status: 'queued', terminal_at: null }),
      runValues(sessions[2], { status: 'queued', terminal_at: null }),
      ...sessions.slice(3).map(session => runValues(session)),
    ];
    await insertFixtures(sessions, runs);

    await expect(evaluateDispatchHealth(db, REFERENCE_TIME)).resolves.toMatchObject({
      tripped: true,
      details: {
        eligibleRunCount: 40,
        stuckRunCount: 4,
        affectedSessionCount: 3,
        stuckRate: 0.1,
      },
    });
  });

  it('normalizes PostgreSQL timestamps and returns aggregate details only', async () => {
    const database = {
      execute: jest.fn().mockResolvedValue({
        rows: [
          {
            eligible_run_count: '30',
            stuck_run_count: '3',
            affected_session_count: 3,
            oldest_stuck_queued_at: '2026-04-29 01:16:12.945+00',
          },
        ],
      }),
    };

    await expect(evaluateDispatchHealth(database as never, REFERENCE_TIME)).resolves.toEqual({
      tripped: true,
      details: {
        eligibleRunCount: 30,
        stuckRunCount: 3,
        affectedSessionCount: 3,
        stuckRate: 0.1,
        oldestStuckQueuedAt: '2026-04-29T01:16:12.945Z',
      },
    });
  });
});
