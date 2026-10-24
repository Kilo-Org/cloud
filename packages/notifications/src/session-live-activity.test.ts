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
        permissionCommand: 'pnpm drizzle migrate',
      },
      options
    );
    expect(permission).toMatchObject({
      sessionId: 'ses_1',
      title: 'Deploy',
      statusKind: 'needsInput',
      statusSince: '2026-10-12T09:30:00.000Z',
      scheduledAt: null,
      awaitingPermission: true,
      approvalKey: options.approvalKey,
      permissionCommand: 'pnpm drizzle migrate',
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

  it('carries the derived facts and keeps the server-only ones on a local update', () => {
    const step = { verb: 'editing' as const, target: 'auth.ts' };
    const plan = { done: 3, total: 7, current: 'Write tests' };
    const pushed = buildSessionLiveActivityContentState(
      {
        id: 'ses_2',
        title: 'Ship it',
        status: 'busy',
        statusUpdatedAt: '2026-10-12T09:50:00.000Z',
        currentStep: step,
        plan,
        changes: { files: 4, added: 120, removed: 30 },
        lastActivityAt: '2026-10-12T09:59:00.000Z',
        costMicrodollars: 24_000,
        startedAt: '2026-10-12T09:00:00.000Z',
      },
      options
    );
    expect(pushed).toMatchObject({
      currentStep: step,
      plan,
      changes: { files: 4, added: 120, removed: 30 },
      costMicrodollars: 24_000,
      outcome: null,
      failure: null,
    });

    // A foreground tray row carries none of the server-only facts. The local
    // build must keep every one of them, and never lower the cost.
    const local = buildSessionLiveActivityContentState(
      { id: 'ses_2', title: 'Ship it', status: 'busy', costMicrodollars: 20_000 },
      { ...options, previous: pushed }
    );
    expect(local).toMatchObject({
      currentStep: step,
      plan,
      changes: { files: 4, added: 120, removed: 30 },
      lastActivityAt: '2026-10-12T09:59:00.000Z',
      costMicrodollars: 24_000,
      startedAt: '2026-10-12T09:00:00.000Z',
    });
    expect(local.permissionCommand).toBeNull();
  });

  it('drops the permission command with the key it belongs to', () => {
    const question = buildSessionLiveActivityContentState(
      { id: 'ses_3', status: 'question', permissionCommand: 'rm -rf build' },
      options
    );
    expect(question.permissionCommand).toBeNull();
    const answered = buildSessionLiveActivityContentState(
      { id: 'ses_3', status: 'busy' },
      {
        ...options,
        previous: buildSessionLiveActivityContentState(
          { id: 'ses_3', status: 'permission', permissionCommand: 'rm -rf build' },
          options
        ),
      }
    );
    expect(answered.permissionCommand).toBeNull();
  });

  it('reads a finished row as failed with its reason, and as outcome otherwise', () => {
    const failed = buildSessionLiveActivityContentState(
      {
        id: 'ses_4',
        status: 'idle',
        failure: 'provider',
        changes: { files: 2, added: 5, removed: 1 },
      },
      options
    );
    expect(failed).toMatchObject({
      statusKind: 'failed',
      failure: { kind: 'provider' },
      outcome: { kind: 'changes' },
    });
    expect(sessionLiveActivityRelevance(failed.statusKind, failed.statusSince)).toBeLessThan(
      LIVE_ACTIVITY_RELEVANCE.sessionActive
    );

    const pr = buildSessionLiveActivityContentState(
      { id: 'ses_5', status: 'idle', prOpened: true },
      options
    );
    expect(pr).toMatchObject({ statusKind: 'idle', failure: null, outcome: { kind: 'pr_opened' } });

    const nothing = buildSessionLiveActivityContentState({ id: 'ses_6', status: 'idle' }, options);
    expect(nothing).toMatchObject({ outcome: { kind: 'none' } });

    // A running row never carries an outcome.
    expect(
      buildSessionLiveActivityContentState({ id: 'ses_7', status: 'busy' }, options).outcome
    ).toBeNull();
  });

  it('keeps the failure only while the finished row shows it', () => {
    const reasoning = { id: 'ses_8', status: 'busy' };
    const failed = buildSessionLiveActivityContentState(
      { id: 'ses_8', status: 'idle', failure: 'cancelled' },
      options
    );
    expect(failed.failure).toEqual({ kind: 'cancelled' });
    expect(buildSessionLiveActivityContentState(reasoning, options).failure).toBeNull();
    // A new turn clears the failure the previous turn left behind.
    expect(
      buildSessionLiveActivityContentState(reasoning, { ...options, previous: failed }).failure
    ).toBeNull();
  });

  it('clears a remembered failure when the row reports none of its own', () => {
    const previous = buildSessionLiveActivityContentState(
      { id: 'ses_9', status: 'idle', failure: 'provider' },
      options
    );
    const idle = buildSessionLiveActivityContentState(
      { id: 'ses_9', status: 'idle', failure: null },
      { ...options, previous }
    );
    expect(idle.statusKind).toBe('idle');
    expect(idle.failure).toBeNull();
    expect(idle.outcome).toEqual({ kind: 'none' });
  });

  it('keeps a remembered failure for a row that cannot report one', () => {
    // A tray row carries no failure fact at all, so a foreground rebuild must
    // not wipe the failed card a push delivered.
    const previous = buildSessionLiveActivityContentState(
      { id: 'ses_10', status: 'idle', failure: 'tool' },
      options
    );
    const idle = buildSessionLiveActivityContentState(
      { id: 'ses_10', status: 'idle' },
      { ...options, previous }
    );
    expect(idle.statusKind).toBe('failed');
    expect(idle.failure).toEqual({ kind: 'tool' });
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
