import { describe, expect, it } from 'vitest';

import { LIVE_ACTIVITY_RELEVANCE, sessionLiveActivityContentStateSchema } from './push-data';
import {
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
      { id: 'ses_1', title: 'Deploy', status: 'permission', statusUpdatedAt: '2026-10-12 09:30:00+00' },
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
  it('orders needs input over work over finished', () => {
    expect(sessionLiveActivityRelevance('needsInput')).toBe(LIVE_ACTIVITY_RELEVANCE.sessionNeedsInput);
    expect(sessionLiveActivityRelevance('running')).toBe(LIVE_ACTIVITY_RELEVANCE.sessionActive);
    expect(sessionLiveActivityRelevance('scheduled')).toBe(LIVE_ACTIVITY_RELEVANCE.sessionActive);
    expect(sessionLiveActivityRelevance('idle')).toBe(LIVE_ACTIVITY_RELEVANCE.sessionIdle);
  });
});
