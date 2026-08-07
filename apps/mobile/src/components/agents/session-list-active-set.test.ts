import { describe, expect, it } from 'vitest';

import { type AgentSessionDateGroup, groupAgentSessionsByDate } from '@/lib/agent-session-groups';
import {
  filterActiveSessionsByOrganization,
  selectActiveExclusionIds,
} from '@/lib/active-sessions-live';
import {
  excludeActiveFromGroups,
  selectPinnedActiveSessions,
} from '@/components/agents/session-list-helpers';
import { type AgentSessionSortBy } from '@/lib/agent-session-sort';

// ── Helpers ───────────────────────────────────────────────────────────

type Row = { session_id: string; created_at: string; updated_at: string };

/** Minimal `ActiveSession`-shaped row; `organizationId` is set only after enrichment. */
type ActiveRow = {
  id: string;
  status: string;
  title: string;
  connectionId: string;
  organizationId?: string | null;
};

function makeActive(id: string, over: { organizationId?: string | null } = {}): ActiveRow {
  return { id, status: 'running', title: `Session ${id}`, connectionId: 'c1', ...over };
}

function makeSessions(ids: string[], baseTimestamp: string): Row[] {
  return ids.map((id, i) => ({
    session_id: id,
    created_at: baseTimestamp,
    // Stagger updated_at so ordering is deterministic within a group.
    updated_at: new Date(`2026-01-${String(10 - i).padStart(2, '0')}T12:00:00Z`).toISOString(),
  }));
}

/**
 * Return the stable row order for a list of groups — a flat array of
 * session_ids in their section-first, group-order-preserving sequence.
 */
function rowOrder(groups: AgentSessionDateGroup<Row>[]): string[] {
  return groups.flatMap(g => g.sessions.map(s => s.session_id));
}

/** Build active-set-aware sections the same way `useAgentSessionListData` does. */
function activeAwareSections(groups: AgentSessionDateGroup<Row>[], activeIds: Set<string>) {
  return excludeActiveFromGroups(groups, activeIds);
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('active-set order regression', () => {
  // Build a stable set of history rows across two date groups.  The
  // groupAgentSessionsByDate helper sorts by the chosen timestamp so
  // the sequence is fully deterministic.
  const baseDate = '2026-01-01T12:00:00Z';
  const sortBy: AgentSessionSortBy = 'updated_at';
  const allRows = makeSessions(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], baseDate);

  // All rows land in "Older" (they're months before the mock "now").
  const groups = groupAgentSessionsByDate(allRows, sortBy, new Date('2026-08-01T12:00:00Z'));

  it('removes only the session matching the active ID and preserves remaining order', () => {
    const active = new Set(['c']);
    const sections = activeAwareSections(groups, active);

    // Row 'c' is gone; every other row keeps its original relative position.
    expect(rowOrder(sections)).toEqual(['a', 'b', 'd', 'e', 'f', 'g', 'h']);
  });

  it('removes multiple active sessions and preserves remaining order', () => {
    const active = new Set(['a', 'e', 'h']);
    const sections = activeAwareSections(groups, active);

    expect(rowOrder(sections)).toEqual(['b', 'c', 'd', 'f', 'g']);
  });

  it('preserves order when no sessions are active (empty active set)', () => {
    const active = new Set<string>();
    const sections = activeAwareSections(groups, active);

    // Empty active set — no rows removed, original order unchanged.
    expect(rowOrder(sections)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  });

  it('adding a session to the active set only removes that one row', () => {
    // Start with a subset active.
    const before = activeAwareSections(groups, new Set(['b']));
    expect(rowOrder(before)).toEqual(['a', 'c', 'd', 'e', 'f', 'g', 'h']);

    // Add 'd' to the active set — only 'd' drops out; all others stay.
    const after = activeAwareSections(groups, new Set(['b', 'd']));
    expect(rowOrder(after)).toEqual(['a', 'c', 'e', 'f', 'g', 'h']);
  });

  it('removing a session from the active set inserts only that row back in order', () => {
    // Two sessions active.
    const before = activeAwareSections(groups, new Set(['c', 'f']));
    expect(rowOrder(before)).toEqual(['a', 'b', 'd', 'e', 'g', 'h']);

    // Remove 'f' from active — 'f' reappears between 'e' and 'g'.
    const after = activeAwareSections(groups, new Set(['c']));
    expect(rowOrder(after)).toEqual(['a', 'b', 'd', 'e', 'f', 'g', 'h']);
  });

  it('handles an active ID not present in history (no-op)', () => {
    const active = new Set(['z']);
    const sections = activeAwareSections(groups, active);

    // A foreign active ID does not touch history rows.
    expect(rowOrder(sections)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  });

  it('returns empty when every history row is active', () => {
    const allIds = new Set(allRows.map(r => r.session_id));
    const sections = activeAwareSections(groups, allIds);

    expect(sections).toEqual([]);
  });
});

// ── first-history-then-active sequence ────────────────────────────────

describe('first-history-then-active sequence', () => {
  // `x` is the only stored row; the sequence below moves it between history
  // and the tray as the live cache fills, enriches, and drops it.
  const baseDate = '2026-01-01T12:00:00Z';
  const sortBy: AgentSessionSortBy = 'updated_at';
  const groups = groupAgentSessionsByDate(
    makeSessions(['x'], baseDate),
    sortBy,
    new Date('2026-08-01T12:00:00Z')
  );

  /**
   * Same composition as `useAgentSessionListData`: the tray side runs the
   * org-filtered rows through `selectPinnedActiveSessions`; the history side
   * drops ids in the chosen exclusion set from the stored groups. `narrowing`
   * replicates the `sections` memo's switch — a committed search
   * (`isSearching`, including the pending first-fetch window where the
   * effective query is still `''`) or a platform/project filter selects the
   * org-filtered set; none of the three selects the unfiltered cache set.
   */
  function reconcile(
    cache: ActiveRow[],
    narrowing: { isSearching?: boolean; platformFilter?: string[]; projectFilter?: string[] } = {}
  ) {
    const { isSearching = false, platformFilter = [], projectFilter = [] } = narrowing;
    const trayRows = filterActiveSessionsByOrganization(cache, 'org-1');
    const pinned = selectPinnedActiveSessions({
      activeSessions: trayRows,
      projectFilter: [],
      platformFilter: [],
      searchQuery: '',
    });
    const activeSessionIds = new Set(trayRows.map(s => s.id));
    const activeExclusionIds = selectActiveExclusionIds(cache);
    const narrowed = isSearching || platformFilter.length > 0 || projectFilter.length > 0;
    const exclusionIds = narrowed ? activeSessionIds : activeExclusionIds;
    return {
      pinned: pinned.map(s => s.id),
      history: rowOrder(excludeActiveFromGroups(groups, exclusionIds)),
      exclusionIds,
    };
  }

  it('moves a session from history to the tray through the unenriched window without duplicates', () => {
    // 1. Live cache empty → `x` renders in history; the tray is empty.
    let cache: ActiveRow[] = [];
    let result = reconcile(cache);
    expect(result.history).toEqual(['x']);
    expect(result.pinned).toEqual([]);
    expect(result.pinned.every(id => result.exclusionIds.has(id))).toBe(true);

    // 2. WS write lands UNENRICHED (no `organizationId`): the org filter
    //    hides it from the tray, and the unfiltered exclusion set drops it
    //    from history — the direct-move window renders it in neither surface.
    cache = [makeActive('x')];
    result = reconcile(cache);
    expect(filterActiveSessionsByOrganization(cache, 'org-1')).toEqual([]);
    expect(result.pinned).toEqual([]);
    expect(result.history).toEqual([]);
    expect(result.pinned.every(id => result.exclusionIds.has(id))).toBe(true);

    // 3. Enrichment attributes the row to org-1 → pinned in the tray, still
    //    excluded from history.
    cache = [makeActive('x', { organizationId: 'org-1' })];
    result = reconcile(cache);
    expect(result.pinned).toEqual(['x']);
    expect(result.history).toEqual([]);
    expect(result.pinned.every(id => result.exclusionIds.has(id))).toBe(true);

    // 4. Departure drops the row from the cache → history re-renders it at
    //    its original position; the tray is empty again.
    cache = [];
    result = reconcile(cache);
    expect(result.pinned).toEqual([]);
    expect(result.history).toEqual(['x']);
    expect(result.pinned.every(id => result.exclusionIds.has(id))).toBe(true);
  });

  describe('narrowing matrix', () => {
    it('full view excludes the unenriched row; every narrowed view keeps it in history', () => {
      const cache = [makeActive('x')];

      // None of the three narrowing inputs active → unfiltered cache set.
      expect(reconcile(cache).history).toEqual([]);

      // Committed search text — including the pending first-fetch window
      // where the effective query is still `''` — keeps the org-filtered set.
      expect(reconcile(cache, { isSearching: true }).history).toEqual(['x']);

      // Platform filter.
      expect(reconcile(cache, { platformFilter: ['cli'] }).history).toEqual(['x']);

      // Project filter.
      expect(reconcile(cache, { projectFilter: ['https://example.com/r'] }).history).toEqual(['x']);
    });

    it('narrowed views still exclude an org-attributed row (the org-filtered set covers it)', () => {
      const cache = [makeActive('x', { organizationId: 'org-1' })];
      expect(reconcile(cache, { isSearching: true }).history).toEqual([]);
      expect(reconcile(cache, { platformFilter: ['cli'] }).history).toEqual([]);
    });

    it('keeps exclusivity in both modes: pinned is always a subset of the exclusion set', () => {
      const unenriched = [makeActive('x')];
      expect(
        reconcile(unenriched).pinned.every(id => reconcile(unenriched).exclusionIds.has(id))
      ).toBe(true);
      const enriched = [makeActive('x', { organizationId: 'org-1' })];
      expect(reconcile(enriched).pinned.every(id => reconcile(enriched).exclusionIds.has(id))).toBe(
        true
      );
    });
  });
});
