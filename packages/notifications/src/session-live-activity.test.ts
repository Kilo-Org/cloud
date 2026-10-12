import { describe, expect, it } from 'vitest';

import { LIVE_ACTIVITY_RELEVANCE, sessionLiveActivityContentStateSchema } from './push-data';
import {
  aggregateLiveActivityRelevance,
  buildSessionLiveActivityContentState,
  sessionLiveActivityRelevance,
  sessionLiveActivityTitle,
} from './session-live-activity';

const options = {
  approvalKey: 'a'.repeat(64),
  updatedAt: '2026-10-12T10:00:00.000Z',
  statusSinceFallback: '2026-10-12T09:00:00.000Z',
};

describe('sessionLiveActivityTitle', () => {
  it('treats an untitled session and the placeholder as no title', () => {
    expect(sessionLiveActivityTitle(null)).toBeNull();
    expect(sessionLiveActivityTitle('   ')).toBeNull();
    expect(sessionLiveActivityTitle('  New session - 2026-09-22T01:09:45.623Z ')).toBeNull();
  });

  it('trims and caps the title without splitting a surrogate pair', () => {
    expect(sessionLiveActivityTitle('  Fix the login bug\n')).toBe('Fix the login bug');
    const capped = sessionLiveActivityTitle(`${'x'.repeat(119)}😀`);
    expect(capped).toBe('x'.repeat(119));
  });
});

describe('buildSessionLiveActivityContentState', () => {
  it('keeps the approval key only for a permission wait', () => {
    const permission = buildSessionLiveActivityContentState(
      {
        id: 'ses_1',
        title: 'Deploy',
        status: 'permission',
        statusUpdatedAt: '2026-10-12 09:30:00+00',
      },
      options
    );
    expect(permission).toEqual({
      sessionId: 'ses_1',
      title: 'Deploy',
      statusKind: 'needsInput',
      statusSince: '2026-10-12T09:30:00.000Z',
      scheduledAt: null,
      awaitingPermission: true,
      approvalKey: options.approvalKey,
      updatedAt: options.updatedAt,
    });
    expect(sessionLiveActivityContentStateSchema.parse(permission)).toEqual(permission);

    const question = buildSessionLiveActivityContentState(
      { id: 'ses_1', status: 'question' },
      options
    );
    expect(question).toMatchObject({
      statusKind: 'needsInput',
      awaitingPermission: false,
      approvalKey: null,
      statusSince: options.statusSinceFallback,
    });
  });

  it('sets the wake time only for a scheduled session', () => {
    expect(
      buildSessionLiveActivityContentState(
        { id: 's', status: 'scheduled', scheduledAt: '2026-10-12T12:00:00Z' },
        options
      ).scheduledAt
    ).toBe('2026-10-12T12:00:00.000Z');
    expect(
      buildSessionLiveActivityContentState(
        { id: 's', status: 'busy', scheduledAt: '2026-10-12T12:00:00Z' },
        options
      )
    ).toMatchObject({ statusKind: 'running', scheduledAt: null });
  });
});

describe('sessionLiveActivityRelevance', () => {
  const at = '2026-10-12T10:00:00.000Z';

  it('keeps each status kind in its band', () => {
    const inBand = (score: number, band: number) => {
      expect(score).toBeGreaterThanOrEqual(band);
      expect(score).toBeLessThan(band + 20);
    };
    inBand(
      sessionLiveActivityRelevance('needsInput', at),
      LIVE_ACTIVITY_RELEVANCE.sessionNeedsInput
    );
    inBand(sessionLiveActivityRelevance('running', at), LIVE_ACTIVITY_RELEVANCE.sessionActive);
    inBand(sessionLiveActivityRelevance('scheduled', at), LIVE_ACTIVITY_RELEVANCE.sessionActive);
    inBand(sessionLiveActivityRelevance('idle', at), LIVE_ACTIVITY_RELEVANCE.sessionIdle);
    // Even a change far in the future stays below the next band.
    expect(sessionLiveActivityRelevance('idle', '2200-01-01T00:00:00.000Z')).toBeLessThan(
      LIVE_ACTIVITY_RELEVANCE.aggregate
    );
  });

  it('ranks a newer change first inside one band', () => {
    const older = sessionLiveActivityRelevance('running', '2026-10-12T09:59:59.000Z');
    const newer = sessionLiveActivityRelevance('running', at);
    expect(newer).toBeGreaterThan(older);
    expect(sessionLiveActivityRelevance('running', null)).toBe(
      LIVE_ACTIVITY_RELEVANCE.sessionActive
    );
    expect(sessionLiveActivityRelevance('running', 'not a date')).toBe(
      LIVE_ACTIVITY_RELEVANCE.sessionActive
    );
  });
});

describe('aggregateLiveActivityRelevance', () => {
  it('uses the needs-input band only while work waits, with the same tie-break', () => {
    const at = '2026-10-12T10:00:00.000Z';
    expect(aggregateLiveActivityRelevance(1, at)).toBeGreaterThan(
      LIVE_ACTIVITY_RELEVANCE.aggregateNeedsInput
    );
    expect(aggregateLiveActivityRelevance(1, at)).toBeLessThan(
      LIVE_ACTIVITY_RELEVANCE.sessionNeedsInput
    );
    expect(aggregateLiveActivityRelevance(0, null)).toBe(LIVE_ACTIVITY_RELEVANCE.aggregate);
    expect(aggregateLiveActivityRelevance(0, at)).toBeGreaterThan(
      aggregateLiveActivityRelevance(0, '2026-10-12T09:00:00.000Z')
    );
  });
});
