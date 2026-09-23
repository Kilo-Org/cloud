import { describe, expect, it } from 'vitest';

import { namedSessionTitle, titleFromSessionUpdatedEvent } from './session-detail-rename-state';

function sessionUpdatedPayload(
  over: { sessionId?: string; title?: string | null; source?: string } = {}
) {
  return {
    source: over.source ?? 'v2',
    session: {
      sessionId: over.sessionId ?? 'ses-1',
      title: over.title === undefined ? 'Auto Title' : over.title,
    },
  };
}

describe('titleFromSessionUpdatedEvent', () => {
  it('returns the title for this session', () => {
    expect(titleFromSessionUpdatedEvent('ses-1', sessionUpdatedPayload())).toBe('Auto Title');
  });

  it('ignores another session', () => {
    expect(
      titleFromSessionUpdatedEvent('ses-1', sessionUpdatedPayload({ sessionId: 'ses-2' }))
    ).toBeUndefined();
  });

  it('ignores a blank or null title', () => {
    expect(
      titleFromSessionUpdatedEvent('ses-1', sessionUpdatedPayload({ title: null }))
    ).toBeUndefined();
    expect(
      titleFromSessionUpdatedEvent('ses-1', sessionUpdatedPayload({ title: '  ' }))
    ).toBeUndefined();
  });

  it('ignores the backend placeholder title', () => {
    expect(
      titleFromSessionUpdatedEvent(
        'ses-1',
        sessionUpdatedPayload({ title: 'New session - 2026-09-22T02:05:22.778Z' })
      )
    ).toBeUndefined();
    expect(
      titleFromSessionUpdatedEvent(
        'ses-1',
        sessionUpdatedPayload({ title: 'Child session - 2026-09-22T02:05:22.778Z' })
      )
    ).toBeUndefined();
  });
});

describe('namedSessionTitle', () => {
  it('returns undefined for a missing, null or blank title', () => {
    expect(namedSessionTitle(undefined)).toBeUndefined();
    expect(namedSessionTitle(null)).toBeUndefined();
    expect(namedSessionTitle('   ')).toBeUndefined();
  });

  it('returns undefined for the backend placeholder titles', () => {
    expect(namedSessionTitle('New session - 2026-09-22T02:05:22.778Z')).toBeUndefined();
    expect(namedSessionTitle('Child session - 2026-09-22T02:05:22.778Z')).toBeUndefined();
  });

  it('returns the trimmed title for a real name', () => {
    expect(namedSessionTitle('  Fix login  ')).toBe('Fix login');
  });

  it('ignores the backend placeholder so a live event cannot repaint the machine string', () => {
    expect(
      titleFromSessionUpdatedEvent(
        'ses-1',
        sessionUpdatedPayload({ title: 'New session - 2026-09-22T01:09:45.623Z' })
      )
    ).toBeUndefined();
  });
});
