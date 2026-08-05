import { describe, expect, it } from 'vitest';

import { type AgentSessionDateGroup, groupAgentSessionsByDate } from '@/lib/agent-session-groups';
import { excludeActiveFromGroups } from '@/components/agents/session-list-helpers';
import { type AgentSessionSortBy } from '@/lib/agent-session-sort';

// ── Helpers ───────────────────────────────────────────────────────────

type Row = { session_id: string; created_at: string; updated_at: string };

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
