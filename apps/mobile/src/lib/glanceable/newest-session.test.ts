import { describe, expect, it } from 'vitest';

import { newestSessionTitle } from './newest-session';

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

  it('accepts the minimal shared row, which carries no title', () => {
    // The snapshot contract's own row type: the publisher may be handed rows
    // that were never enriched, and the line then shows nothing.
    expect(newestSessionTitle([{ status: 'question' }])).toBeNull();
  });
});
