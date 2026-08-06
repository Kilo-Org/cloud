import { describe, expect, it } from 'vitest';
import {
  activeSessionsQueryKey,
  mapActiveSessionRow,
  mapHistorySessionRow,
  sessionHistoryQueryKey,
  sessionSearchQueryKey,
  sessionStatusBadge,
} from './agents-session-list';

// ---- sessionStatusBadge ----

describe('sessionStatusBadge()', () => {
  it('returns null for null status', () => {
    expect(sessionStatusBadge(null)).toBeNull();
  });

  it('returns "Needs input" for question status (case insensitive)', () => {
    const badge = sessionStatusBadge('question');
    expect(badge).not.toBeNull();
    expect(badge!.label).toBe('Needs input');
  });

  it('returns "Needs input" for uppercase QUESTION', () => {
    const badge = sessionStatusBadge('QUESTION');
    expect(badge).not.toBeNull();
    expect(badge!.label).toBe('Needs input');
  });

  it('returns "Needs input" for permission status', () => {
    const badge = sessionStatusBadge('permission');
    expect(badge).not.toBeNull();
    expect(badge!.label).toBe('Needs input');
  });

  it('returns "Running" for running status', () => {
    const badge = sessionStatusBadge('running');
    expect(badge).not.toBeNull();
    expect(badge!.label).toBe('Running');
  });

  it('returns "Running" for uppercase RUNNING', () => {
    const badge = sessionStatusBadge('RUNNING');
    expect(badge).not.toBeNull();
    expect(badge!.label).toBe('Running');
  });

  it('capitalizes an unrecognized status label', () => {
    const badge = sessionStatusBadge('idle');
    expect(badge).not.toBeNull();
    expect(badge!.label).toBe('Idle');
  });

  it('returns "Needs input" with yellow styling for question', () => {
    const badge = sessionStatusBadge('question');
    expect(badge!.className).toContain('bg-status-yellow');
    expect(badge!.className).toContain('text-status-yellow');
  });

  it('returns "Running" with green styling', () => {
    const badge = sessionStatusBadge('running');
    expect(badge!.className).toContain('bg-status-green');
    expect(badge!.className).toContain('text-status-green');
  });

  it('returns fallback with muted styling for unknown status', () => {
    const badge = sessionStatusBadge('unknown');
    expect(badge!.className).toContain('bg-surface-selected');
    expect(badge!.className).toContain('text-foreground-muted');
  });

  // An empty-string status renders no badge — an empty pill carries no signal.
  it('returns null for empty string status', () => {
    expect(sessionStatusBadge('')).toBeNull();
  });
});

// ---- mapActiveSessionRow ----

describe('mapActiveSessionRow()', () => {
  const baseSession = {
    connectionId: 'cli-owner-1',
    id: 'ses_test1234567890123456789A',
    status: 'idle',
    title: 'Test Session',
  };

  it('maps id, title, and status through typed fields', () => {
    const row = mapActiveSessionRow(baseSession);
    expect(row.id).toBe('ses_test1234567890123456789A');
    expect(row.title).toBe('Test Session');
    expect(row.status).toBe('idle');
  });

  it('maps gitUrl to repository and null when absent', () => {
    expect(mapActiveSessionRow(baseSession).repository).toBeNull();
    expect(
      mapActiveSessionRow({ ...baseSession, gitUrl: 'https://github.com/org/repo' }).repository
    ).toBe('https://github.com/org/repo');
  });

  it('maps gitBranch to gitBranch and null when absent', () => {
    expect(mapActiveSessionRow(baseSession).gitBranch).toBeNull();
    expect(mapActiveSessionRow({ ...baseSession, gitBranch: 'feature/branch' }).gitBranch).toBe(
      'feature/branch'
    );
  });

  it('marks isCloudAgent: true when connectionId === "cloud-agent"', () => {
    const cloud = mapActiveSessionRow({ ...baseSession, connectionId: 'cloud-agent' });
    expect(cloud.isCloudAgent).toBe(true);
  });

  it('marks isCloudAgent: false for any other connectionId', () => {
    expect(mapActiveSessionRow({ ...baseSession, connectionId: 'cli-owner-1' }).isCloudAgent).toBe(
      false
    );
    expect(mapActiveSessionRow({ ...baseSession, connectionId: 'uuid-other' }).isCloudAgent).toBe(
      false
    );
  });

  it('passes through empty string title (UI handles fallback)', () => {
    const row = mapActiveSessionRow({ ...baseSession, title: '' });
    // ?? null does NOT coalesce empty strings — the UI layers its own fallback.
    expect(row.title).toBe('');
  });
});

// ---- mapHistorySessionRow ----

describe('mapHistorySessionRow()', () => {
  const wireRow = {
    session_id: 'ses_history12345678901234567',
    title: 'History Title',
    updated_at: '2026-07-30T12:00:00.000Z',
  };

  it('maps session_id → id, title → title, updated_at → updatedAt', () => {
    const row = mapHistorySessionRow(wireRow);
    expect(row.id).toBe('ses_history12345678901234567');
    expect(row.title).toBe('History Title');
    expect(row.updatedAt).toBe('2026-07-30T12:00:00.000Z');
  });

  it('passes through null title', () => {
    const row = mapHistorySessionRow({ ...wireRow, title: null });
    expect(row.title).toBeNull();
  });
});

// ---- Query key functions ----

describe('query key functions', () => {
  describe('activeSessionsQueryKey()', () => {
    it('produces the expected key for personal (null org)', () => {
      expect(activeSessionsQueryKey(null)).toStrictEqual(['agents', 'active-sessions', null]);
    });

    it('produces the expected key for an organization', () => {
      expect(activeSessionsQueryKey('org-123')).toStrictEqual([
        'agents',
        'active-sessions',
        'org-123',
      ]);
    });
  });

  describe('sessionHistoryQueryKey()', () => {
    it('produces the expected key for personal (null org)', () => {
      expect(sessionHistoryQueryKey(null)).toStrictEqual(['agents', 'session-history', null]);
    });

    it('produces the expected key for an organization', () => {
      expect(sessionHistoryQueryKey('org-456')).toStrictEqual([
        'agents',
        'session-history',
        'org-456',
      ]);
    });
  });

  describe('sessionSearchQueryKey()', () => {
    it('produces the expected key for personal (null org) with a query string', () => {
      expect(sessionSearchQueryKey(null, 'test query')).toStrictEqual([
        'agents',
        'session-search',
        null,
        'test query',
      ]);
    });

    it('produces the expected key for an organization with a query string', () => {
      expect(sessionSearchQueryKey('org-789', 'search term')).toStrictEqual([
        'agents',
        'session-search',
        'org-789',
        'search term',
      ]);
    });
  });
});
