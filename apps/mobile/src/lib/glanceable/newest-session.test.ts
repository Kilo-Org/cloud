import { describe, expect, it } from 'vitest';

import { newestSessionTitle, pickNewestSession } from './newest-session';

describe('pickNewestSession', () => {
  it('ranks the status-change time above every other clock, like the snapshot', () => {
    // The widget's newest result reads `statusUpdatedAt`; the named session
    // must be the same row even when another row was updated later.
    const rows = [
      { id: 'updated', status: 'busy', updatedAt: '2026-01-09T00:00:00.000Z' },
      {
        id: 'changed',
        status: 'question',
        statusUpdatedAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    expect(pickNewestSession(rows)).toEqual({ row: rows[1], at: '2026-01-02T00:00:00.000Z' });
  });

  it('names the first row when no row carries a usable time', () => {
    const rows = [
      { id: 'a', status: 'busy', statusUpdatedAt: 'not a date' },
      { id: 'b', status: 'idle' },
    ];
    expect(pickNewestSession(rows)).toEqual({ row: rows[0], at: null });
  });

  it('returns null only for an empty tray', () => {
    expect(pickNewestSession([])).toBeNull();
  });
});

describe('newestSessionTitle', () => {
  it('returns null for an empty tray', () => {
    expect(newestSessionTitle([])).toBeNull();
  });

  it('returns the only session title', () => {
    expect(newestSessionTitle([{ title: 'Fix the flaky test', status: 'busy' }])).toBe(
      'Fix the flaky test'
    );
  });

  it('ranks by updatedAt, then lastActivityAt, then createdAt', () => {
    const rows = [
      // updatedAt is the row's own clock even when activity is newer.
      {
        title: 'Updated row',
        status: 'idle',
        updatedAt: '2026-01-03T00:00:00.000Z',
        lastActivityAt: '2026-01-01T00:00:00.000Z',
      },
      { title: 'Activity row', status: 'busy', lastActivityAt: '2026-01-04T00:00:00.000Z' },
      { title: 'Created row', status: 'busy', createdAt: '2026-01-02T00:00:00.000Z' },
    ];
    expect(newestSessionTitle(rows)).toBe('Activity row');
  });

  it('ranks a row that has a timestamp above one that does not', () => {
    const rows = [
      { title: 'Untimed row', status: 'busy' },
      { title: 'Timed row', status: 'busy', createdAt: '2025-12-31T00:00:00.000Z' },
    ];
    expect(newestSessionTitle(rows)).toBe('Timed row');
  });

  it('keeps the earlier row when two rows are equally new', () => {
    const rows = [
      { title: 'First row', status: 'busy', updatedAt: '2026-01-05T00:00:00.000Z' },
      { title: 'Second row', status: 'busy', updatedAt: '2026-01-05T00:00:00.000Z' },
    ];
    expect(newestSessionTitle(rows)).toBe('First row');
  });

  it('returns null when the newest row carries no usable title', () => {
    const rows = [
      { title: 'Named row', status: 'busy', updatedAt: '2026-01-01T00:00:00.000Z' },
      { title: '   ', status: 'busy', updatedAt: '2026-01-06T00:00:00.000Z' },
    ];
    expect(newestSessionTitle(rows)).toBeNull();
  });

  it('returns null when the newest row still carries the backend placeholder', () => {
    // The backend seeds a fresh session with `New session - ${ISO}`; the
    // widget shows nothing rather than the machine string.
    const rows = [
      { title: 'Named row', status: 'busy', updatedAt: '2026-01-01T00:00:00.000Z' },
      {
        title: 'New session - 2026-01-06T00:00:00.000Z',
        status: 'busy',
        updatedAt: '2026-01-06T00:00:00.000Z',
      },
    ];
    expect(newestSessionTitle(rows)).toBeNull();
  });

  it('accepts the minimal shared row, which carries no title', () => {
    // The snapshot contract's own row type: the publisher may be handed rows
    // that were never enriched, and the line then shows nothing.
    expect(newestSessionTitle([{ status: 'question' }])).toBeNull();
  });

  it('hides the backend default title so the newest line is not a timestamp', () => {
    // Explorer session-question/typed-kb-up: the widget line showed the raw
    // `New session - <ISO>` stamp as machine output rather than human copy.
    const rows = [
      {
        title: 'New session - 2026-09-20T08:10:35.172Z',
        status: 'question',
        updatedAt: '2026-01-05T00:00:00.000Z',
      },
      {
        title: 'Refactor the billing webhook',
        status: 'busy',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    expect(newestSessionTitle(rows)).toBeNull();
  });
});
