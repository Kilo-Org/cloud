jest.mock('@kilocode/web-shared/lib/drizzle', () => ({ db: {} }));

import { aggregateBriefingEvidence } from './evidence';
import {
  freezeBriefingEvidence,
  ONE_OFF_ANCESTRY_LIMIT,
  ONE_OFF_BUCKETS,
  ONE_OFF_ROWS_PER_BUCKET,
  ONE_OFF_SESSION_LIMIT,
} from './one-off-evidence';
import type { agent_briefing_events } from '@kilocode/db/schema';

const start = '2026-10-14T22:00:00.000Z';
const cutoff = '2026-10-15T08:00:00.000Z';
const night = '2026-10-15T02:00:00.000Z';
const rows = [
  { session_id: 'root', parent_session_id: null, title: 'Root' },
  { session_id: 'child', parent_session_id: 'root', title: 'Child' },
];
const collectedBeforeNight = '2026-10-14T12:00:00.000Z';
function event(
  id: string,
  overrides: Partial<typeof agent_briefing_events.$inferSelect> = {}
): typeof agent_briefing_events.$inferSelect {
  return {
    id,
    kilo_user_id: 'user',
    session_id: 'root',
    organization_id: null,
    kind: 'activity',
    occurred_at: night,
    recorded_at: cutoff,
    status: null,
    title: null,
    url: null,
    payload: null,
    ...overrides,
  };
}

describe('freezeBriefingEvidence', () => {
  it('keeps complete provenance at the collection caps without failing the snapshot', () => {
    const report = aggregateBriefingEvidence(rows, [event('activity')], [], start, cutoff, {
      collectionStartedAt: collectedBeforeNight,
      legacyStatusInWindow: false,
    });
    const eventIds = Array.from(
      {
        length:
          ONE_OFF_BUCKETS * ONE_OFF_ROWS_PER_BUCKET +
          ONE_OFF_SESSION_LIMIT +
          ONE_OFF_ANCESTRY_LIMIT,
      },
      (_, index) => JSON.stringify(['oauth/user', `ses_${'x'.repeat(140)}`, 'activity', index])
    );
    const sessionIds = Array.from({ length: ONE_OFF_ANCESTRY_LIMIT }, (_, index) => `ses_${index}`);
    const frozen = freezeBriefingEvidence(report, { eventIds, sessionIds, partial: false });
    expect(frozen.evidenceEventIds).toEqual(eventIds);
    expect(frozen.evidenceSessionIds).toEqual(sessionIds);
    expect(frozen.sessions.map(session => session.sessionId)).toEqual(['root']);
  });
});

describe('aggregateBriefingEvidence', () => {
  it('rolls children into their root and counts each real usage id once within the night', () => {
    const usage = { id: 'charge', sessionId: 'child', cost: 1200, occurredAt: night };
    const report = aggregateBriefingEvidence(
      rows,
      [event('activity', { session_id: 'child' })],
      [
        usage,
        usage,
        { ...usage, id: 'before', occurredAt: '2026-10-14T21:59:59.999Z' },
        { ...usage, id: 'at-cutoff', occurredAt: cutoff },
        { ...usage, id: 'foreign', sessionId: 'not-owned' },
      ],
      start,
      cutoff
    );
    expect(report.scorecard).toEqual({
      sessions: 1,
      pullRequests: 0,
      blockers: 0,
      spendMicrodollars: 1200,
    });
    expect(report.sessions[0]).toMatchObject({ sessionId: 'root', spendMicrodollars: 1200 });
    expect(report.sources.filter(source => source.kind === 'cost')).toHaveLength(1);
    expect(report.coverage).toEqual({
      activity: 'partial',
      spend: 'partial',
      blockers: 'partial',
      pullRequests: 'partial',
    });
  });

  it('does not present an unchanged old blocker as overnight work', () => {
    const report = aggregateBriefingEvidence(
      rows,
      [
        event('old', {
          kind: 'status',
          status: 'question',
          occurred_at: '2026-10-14T20:00:00.000Z',
        }),
      ],
      [],
      start,
      cutoff
    );
    expect(report.scorecard.sessions).toBe(0);
    expect(report.scorecard.blockers).toBe(0);
    expect(report.coverage.spend).toBe('unavailable');
  });

  it('does not invent a blocker onset when collection starts during an existing blocker', () => {
    const report = aggregateBriefingEvidence(
      rows,
      [
        event('existing', {
          kind: 'status',
          status: 'permission',
          payload: { previousStatus: 'question' },
        }),
      ],
      [],
      start,
      cutoff
    );
    expect(report.scorecard.blockers).toBe(0);
  });
  it('keeps an unknown initial predecessor unknown instead of inventing a fresh blocker', () => {
    const unknown = event('unknown-onset', {
      kind: 'status',
      status: 'question',
      payload: { previousStatus: null, previousStatusKnown: false },
    });
    expect(aggregateBriefingEvidence(rows, [unknown], [], start, cutoff).scorecard.blockers).toBe(
      0
    );
    const known = {
      ...unknown,
      id: 'known-onset',
      payload: { previousStatus: 'busy', previousStatusKnown: true },
    };
    expect(aggregateBriefingEvidence(rows, [known], [], start, cutoff).scorecard.blockers).toBe(1);
  });
  it('uses the actual source predecessor rather than a stale historical projection', () => {
    const oldBlocked = event('old-blocked', {
      kind: 'status',
      status: 'question',
      occurred_at: '2026-10-14T21:00:00.000Z',
    });
    const reentered = event('new-blocker', {
      kind: 'status',
      status: 'permission',
      payload: { previousStatus: 'busy', previousStatusKnown: true },
    });
    expect(
      aggregateBriefingEvidence(rows, [oldBlocked, reentered], [], start, cutoff).scorecard.blockers
    ).toBe(1);
    const oldBusy = { ...oldBlocked, status: 'busy' };
    const unknownExisting = {
      ...reentered,
      payload: { previousStatus: 'question', previousStatusKnown: true },
    };
    expect(
      aggregateBriefingEvidence(rows, [oldBusy, unknownExisting], [], start, cutoff).scorecard
        .blockers
    ).toBe(0);
  });
  it('orders equal-millisecond transitions by source identity rather than event insertion or status', () => {
    const first = event('z-first', {
      kind: 'status',
      status: 'busy',
      payload: {
        previousStatus: 'idle',
        previousStatusKnown: true,
        transitionId: '01ARZ3NDEKTSV4RRFFQ69G5FA1',
      },
    });
    const second = event('m-second', {
      kind: 'status',
      status: 'question',
      payload: {
        previousStatus: 'busy',
        previousStatusKnown: true,
        transitionId: '01ARZ3NDEKTSV4RRFFQ69G5FA2',
      },
    });
    const third = event('a-last', {
      kind: 'status',
      status: 'permission',
      payload: {
        previousStatus: 'question',
        previousStatusKnown: true,
        transitionId: '01ARZ3NDEKTSV4RRFFQ69G5FA3',
      },
    });
    const report = aggregateBriefingEvidence(rows, [third, second, first], [], start, cutoff);
    expect(report.sessions[0]?.status).toBe('permission');
    expect(report.scorecard.blockers).toBe(1);
    expect(report.sources.find(source => source.kind === 'blocker')?.id).toBe('m-second');
  });

  it('uses status at cutoff, records clearing transitions, and excludes later state', () => {
    const report = aggregateBriefingEvidence(
      rows,
      [
        event('blocked', { kind: 'status', status: 'permission' }),
        event('clear', { kind: 'status', status: 'busy', occurred_at: cutoff }),
        event('future', {
          kind: 'status',
          status: 'question',
          occurred_at: '2026-10-15T09:00:00.000Z',
        }),
      ],
      [],
      start,
      cutoff
    );
    expect(report.scorecard.blockers).toBe(0);
    expect(report.sessions[0]?.status).toBe('busy');
  });

  it('counts re-entered blockers but not uninterrupted pre-night blocker intervals', () => {
    const old = event('old', {
      kind: 'status',
      status: 'question',
      occurred_at: '2026-10-14T21:00:00.000Z',
    });
    const current = event('current', { kind: 'status', status: 'permission' });
    expect(
      aggregateBriefingEvidence(rows, [old, current], [], start, cutoff).scorecard.blockers
    ).toBe(0);
    const cleared = event('cleared', { kind: 'status', status: 'idle', occurred_at: start });
    expect(
      aggregateBriefingEvidence(rows, [old, cleared, current], [], start, cutoff).scorecard.blockers
    ).toBe(1);
  });

  it('counts verified PR creation once by URL, not verification time or child session', () => {
    const pr = event('pr', { kind: 'pull_request', url: 'https://github.com/kilo/repo/pull/7' });
    const report = aggregateBriefingEvidence(
      rows,
      [
        pr,
        { ...pr, id: 'child-pr', session_id: 'child' },
        {
          ...pr,
          id: 'old-pr',
          url: 'https://github.com/kilo/repo/pull/8',
          occurred_at: '2026-10-14T21:00:00.000Z',
        },
      ],
      [],
      start,
      cutoff
    );
    expect(report.scorecard.pullRequests).toBe(1);
    expect(report.sources.filter(source => source.kind === 'pull_request')).toHaveLength(1);
  });

  it('does not adopt another context ancestor or attribute unknown evidence', () => {
    const report = aggregateBriefingEvidence(
      [{ ...rows[1], parent_session_id: 'foreign-root' }],
      [event('child', { session_id: 'child' }), event('foreign', { session_id: 'foreign-root' })],
      [],
      start,
      cutoff
    );
    expect(report.sessions.map(session => session.sessionId)).toEqual(['child']);
    expect(report.sources.map(source => source.id)).toEqual(['child']);
  });
  it('surfaces selected redacted excerpts, bounded again at the persisted-data boundary', () => {
    const report = aggregateBriefingEvidence(
      rows,
      [
        event('excerpt', {
          payload: {
            excerpt: 'Parser updated person@example.com token=secret ' + 'Details '.repeat(200),
          },
        }),
      ],
      [],
      start,
      cutoff
    );
    expect(report.sources[0]?.excerpt).toContain('Parser updated');
    expect(report.sources[0]?.excerpt?.length).toBeLessThanOrEqual(600);
    expect(report.sources[0]?.excerpt).not.toMatch(/person@example.com|token=secret/);
  });

  it('derives the group status from every merged session, preferring a blocked child', () => {
    const base = (id: string, sessionId: string, status: string, at: string) =>
      event(id, { kind: 'status', session_id: sessionId, status, occurred_at: at });
    const blockedChild = aggregateBriefingEvidence(
      rows,
      [
        base('root-idle', 'root', 'idle', '2026-10-15T03:00:00.000Z'),
        {
          ...base('child-blocked', 'child', 'question', '2026-10-15T02:00:00.000Z'),
          payload: { previousStatus: 'busy', previousStatusKnown: true },
        },
      ],
      [],
      start,
      cutoff
    );
    expect(blockedChild.scorecard.blockers).toBe(1);
    expect(blockedChild.sessions[0]?.status).toBe('question');
    const childOnly = aggregateBriefingEvidence(
      rows,
      [base('child-busy', 'child', 'busy', night)],
      [],
      start,
      cutoff
    );
    expect(childOnly.sessions[0]?.status).toBe('busy');
    const newest = aggregateBriefingEvidence(
      rows,
      [
        base('root-busy', 'root', 'busy', '2026-10-15T01:00:00.000Z'),
        base('child-idle', 'child', 'idle', '2026-10-15T03:00:00.000Z'),
      ],
      [],
      start,
      cutoff
    );
    expect(newest.sessions[0]?.status).toBe('idle');
  });

  it('applies the report display contract', () => {
    const sessionRows = Array.from({ length: 65 }, (_, index) => ({
      session_id: `session-${String(index).padStart(3, '0')}`,
      parent_session_id: null,
      title: 'Title '.repeat(40),
    }));
    const events = sessionRows.flatMap(row =>
      Array.from({ length: 33 }, (_, index) =>
        event(`${row.session_id}-${index}`, {
          session_id: row.session_id,
          kind: 'artifact',
          title: 'Artifact '.repeat(40),
          url: `https://example.com/${'path/'.repeat(500)}`,
        })
      )
    );
    const report = aggregateBriefingEvidence(sessionRows, events, [], start, cutoff, {
      collectionStartedAt: collectedBeforeNight,
    });
    expect(report.scorecard.sessions).toBe(65);
    expect(report.sessions).toHaveLength(64);
    expect(report.sources).toHaveLength(256);
    expect(report.sessions.every(session => session.sources.length <= 32)).toBe(true);
    expect(report.sessions.every(session => session.title.length <= 160)).toBe(true);
    expect(
      report.sources.every(source => source.title.length <= 160 && source.url.length <= 2048)
    ).toBe(true);
    expect(
      report.sessions
        .flatMap(session => session.sources)
        .map(source => source.id)
        .sort()
    ).toEqual(report.sources.map(source => source.id).sort());
    expect(report.coverage).toEqual({
      activity: 'partial',
      spend: 'partial',
      blockers: 'partial',
      pullRequests: 'partial',
    });
  });

  describe('coverage', () => {
    const charged = { id: 'charge', sessionId: 'root', cost: 290_000, occurredAt: night };
    const timestampedBlocker = event('blocked', {
      kind: 'status',
      status: 'question',
      payload: {
        previousStatus: 'busy',
        previousStatusKnown: true,
        transitionId: '01ARZ3NDEKTSV4RRFFQ69G5FA1',
      },
    });
    const aggregate = (
      events: Parameters<typeof aggregateBriefingEvidence>[1],
      usage: Parameters<typeof aggregateBriefingEvidence>[2] = [charged],
      context: Parameters<typeof aggregateBriefingEvidence>[5] = {
        collectionStartedAt: collectedBeforeNight,
      },
      sessionRows: Parameters<typeof aggregateBriefingEvidence>[0] = rows
    ) => aggregateBriefingEvidence(sessionRows, events, usage, start, cutoff, context);

    it('is complete when collection was live before the night and every source is attributed', () => {
      const report = aggregate([event('activity'), timestampedBlocker]);
      expect(report.coverage).toEqual({
        activity: 'complete',
        spend: 'complete',
        blockers: 'complete',
        pullRequests: 'complete',
      });
      expect(report.scorecard).toMatchObject({ blockers: 1, spendMicrodollars: 290_000 });
    });

    it('stays partial when collection started during the night or is unknown', () => {
      for (const collectionStartedAt of [null, '2026-10-15T01:00:00.000Z']) {
        expect(
          aggregate([event('activity'), timestampedBlocker], [charged], { collectionStartedAt })
            .coverage
        ).toEqual({
          activity: 'partial',
          spend: 'partial',
          blockers: 'partial',
          pullRequests: 'partial',
        });
      }
    });

    it('marks blockers partial for producer transitions without ordering identity or predecessor', () => {
      for (const payload of [
        { previousStatus: 'busy', previousStatusKnown: true },
        {
          previousStatus: null,
          previousStatusKnown: false,
          transitionId: '01ARZ3NDEKTSV4RRFFQ69G5FA2',
        },
      ]) {
        const report = aggregate([
          event('activity'),
          event('legacy', { kind: 'status', status: 'question', payload }),
        ]);
        expect(report.coverage.blockers).toBe('partial');
        expect(report.coverage.activity).toBe('complete');
      }
    });

    it('keeps server-observed status resets complete', () => {
      const report = aggregate([
        event('activity'),
        event('reset', { kind: 'status', status: 'retry', payload: null }),
      ]);
      expect(report.coverage.blockers).toBe('complete');
    });

    it('marks blockers partial when the collector saw a legacy untimestamped status in the night', () => {
      expect(
        aggregate([event('activity')], [charged], {
          collectionStartedAt: collectedBeforeNight,
          legacyStatusInWindow: true,
        }).coverage.blockers
      ).toBe('partial');
    });

    it('marks spend partial when an active session has no attributed usage', () => {
      const report = aggregate(
        [event('activity'), event('uncharged', { session_id: 'other' })],
        [charged],
        { collectionStartedAt: collectedBeforeNight },
        [...rows, { session_id: 'other', parent_session_id: null, title: 'Other' }]
      );
      expect(report.coverage.spend).toBe('partial');
    });

    it('is unavailable only when no usage exists for active sessions', () => {
      expect(aggregate([event('activity')], []).coverage.spend).toBe('unavailable');
      expect(
        aggregate(
          [event('pr', { kind: 'pull_request', url: 'https://github.com/kilo/repo/pull/9' })],
          []
        ).coverage.spend
      ).toBe('complete');
    });
  });
});
