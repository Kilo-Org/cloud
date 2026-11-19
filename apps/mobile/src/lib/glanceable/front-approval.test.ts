import { describe, expect, it } from 'vitest';

import { type FrontApprovableRow, pickFrontApprovableSession } from './front-approval';

function row(id: string, status: string, statusUpdatedAt?: string): FrontApprovableRow {
  return statusUpdatedAt === undefined ? { id, status } : { id, status, statusUpdatedAt };
}

describe('pickFrontApprovableSession', () => {
  it('returns null for an empty list', () => {
    expect(pickFrontApprovableSession([])).toBeNull();
  });

  it('returns null when no row waits on a permission', () => {
    const rows = [
      row('running', 'busy', '2026-01-01T00:00:00.000Z'),
      row('idle', 'idle', '2026-01-01T00:00:00.000Z'),
      row('starting', 'starting'),
    ];

    expect(pickFrontApprovableSession(rows)).toBeNull();
  });

  it('returns null for a question-only front', () => {
    const rows = [
      row('question-old', 'question', '2026-01-01T00:00:00.000Z'),
      row('question-new', 'question', '2026-01-02T00:00:00.000Z'),
      row('retry', 'retry', '2026-01-03T00:00:00.000Z'),
    ];

    expect(pickFrontApprovableSession(rows)).toBeNull();
  });

  it('picks the permission row with the earliest status timestamp', () => {
    const rows = [
      row('question', 'question', '2025-12-31T00:00:00.000Z'),
      row('permission-new', 'permission', '2026-01-02T00:00:00.000Z'),
      row('permission-old', 'permission', '2026-01-01T00:00:00.000Z'),
      row('busy', 'busy', '2026-01-03T00:00:00.000Z'),
    ];

    expect(pickFrontApprovableSession(rows)?.id).toBe('permission-old');
  });

  it('ranks a PostgreSQL-form timestamp by its real time', () => {
    // The backend sends PostgreSQL timestamps, which Hermes' own Date.parse
    // rejects. The shared timestampMs reader parses them, so the older row wins
    // on its real time instead of sorting last as unparseable.
    const rows = [
      row('permission-iso', 'permission', '2026-10-12T10:00:00.000Z'),
      row('permission-postgres', 'permission', '2026-10-12 09:45:12.945+00'),
    ];

    expect(pickFrontApprovableSession(rows)?.id).toBe('permission-postgres');
  });

  it('sorts permission rows without a usable timestamp last', () => {
    const rows = [
      row('permission-no-timestamp', 'permission'),
      row('permission-unparseable', 'permission', 'not-a-date'),
      row('permission-dated', 'permission', '2026-01-01T00:00:00.000Z'),
    ];

    expect(pickFrontApprovableSession(rows)?.id).toBe('permission-dated');
  });

  it('breaks a timestamp tie by list order', () => {
    const rows = [
      row('first', 'permission', '2026-01-01T00:00:00.000Z'),
      row('second', 'permission', '2026-01-01T00:00:00.000Z'),
    ];

    expect(pickFrontApprovableSession(rows)?.id).toBe('first');
  });

  it('breaks a missing-timestamp tie by list order', () => {
    const rows = [row('first', 'permission'), row('second', 'permission')];

    expect(pickFrontApprovableSession(rows)?.id).toBe('first');
  });

  it('prefers a dated row that appears later over an undated row that appears first', () => {
    const rows = [
      row('undated', 'permission'),
      row('dated', 'permission', '2026-01-01T00:00:00.000Z'),
    ];

    expect(pickFrontApprovableSession(rows)?.id).toBe('dated');
  });
});
