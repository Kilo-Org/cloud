import { describe, expect, it } from 'vitest';

import { type StoredSession } from '@/lib/hooks/use-agent-sessions';

import { flattenSessionSections } from './session-list-rows';
import { sectionAwareTimeMeta } from './session-row-time-meta';

/**
 * Sunday 21:00 UTC. Read at Tuesday 09:00 UTC it is two calendar dates back in
 * UTC, and only the previous local date in Kiritimati (UTC+14), so the two
 * zones disagree about the word the row must show.
 */
const ROW = '2026-11-08T21:00:00.000Z';
const NOW_MS = Date.parse('2026-11-10T09:00:00.000Z');

const SESSION: StoredSession = {
  session_id: 'old',
  title: 'old title',
  organization_id: 'org-1',
  cloud_agent_session_id: null,
  cloud_agent_worktree_id: null,
  parent_session_id: null,
  created_on_platform: 'cli',
  git_url: null,
  git_branch: null,
  status: null,
  status_updated_at: null,
  latest_run_status: null,
  latest_run_failure_kind: null,
  latest_run_terminal_at: null,
  total_cost_microdollars: null,
  created_at: ROW,
  updated_at: ROW,
  last_activity_at: null,
  version: 0,
  associatedPr: null,
};

describe('a section row names the day its own heading was grouped in', () => {
  it('carries the section zone to the row and reads that day', () => {
    // The production shape: the zone is resolved once, the grouping and the row
    // under it are handed that same value, and nothing re-probes a zone while
    // the row renders.
    const rows = flattenSessionSections([
      { title: 'Monday', data: [SESSION], timeZone: 'Pacific/Kiritimati' },
    ]);
    const row = rows.find(candidate => candidate.kind === 'session');
    expect(row?.kind).toBe('session');
    if (row?.kind !== 'session') {
      return;
    }

    expect(row.timeZone).toBe('Pacific/Kiritimati');
    expect(
      sectionAwareTimeMeta(row.session.updated_at, row.sectionTitle, {
        nowMs: NOW_MS,
        timeZone: row.timeZone,
      }).spoken
    ).toBe('yesterday');
  });

  it('would name a different day from another zone, so the zone is what decides', () => {
    // The control for the case above: the same row read in UTC is two dates back.
    expect(sectionAwareTimeMeta(ROW, 'Monday', { nowMs: NOW_MS, timeZone: 'UTC' }).spoken).toBe(
      '2 days ago'
    );
  });
});
