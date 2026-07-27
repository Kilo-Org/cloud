import { describe, expect, it } from 'vitest';

import { type StoredSession } from '@/lib/hooks/use-agent-sessions';

import { selectShareDestinations, SHARE_DESTINATION_CAP } from './share-destinations';

function session(id: string, over: Partial<StoredSession> = {}): StoredSession {
  return {
    session_id: id,
    title: id,
    cloud_agent_session_id: null,
    parent_session_id: null,
    organization_id: null,
    created_on_platform: 'cloud-agent',
    git_url: null,
    git_branch: null,
    status: null,
    status_updated_at: null,
    total_cost_microdollars: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    version: 0,
    associatedPr: null,
    ...over,
  };
}

describe('selectShareDestinations', () => {
  it('hoists live rows to the top while preserving relative order', () => {
    const stored = [session('a'), session('b'), session('c'), session('d')];
    const active = new Set(['c', 'a']);
    const rows = selectShareDestinations(stored, active);
    expect(rows.map(r => r.session_id)).toEqual(['a', 'c', 'b', 'd']);
    expect(rows.filter(r => r.live).map(r => r.session_id)).toEqual(['a', 'c']);
  });

  it('marks live by id membership only', () => {
    const stored = [session('a'), session('b')];
    const rows = selectShareDestinations(stored, new Set(['b']));
    expect(rows.find(r => r.session_id === 'a')?.live).toBe(false);
    expect(rows.find(r => r.session_id === 'b')?.live).toBe(true);
  });

  it('caps at 30 after ordering', () => {
    const stored = Array.from({ length: 40 }, (_, i) => session(`s${i}`));
    const active = new Set(['s35', 's36']);
    const rows = selectShareDestinations(stored, active);
    expect(rows).toHaveLength(SHARE_DESTINATION_CAP);
    // Live rows that appear in the stored page are hoisted first.
    expect(rows[0]?.session_id).toBe('s35');
    expect(rows[1]?.session_id).toBe('s36');
    expect(rows.every(r => r.session_id.startsWith('s'))).toBe(true);
  });

  it('never invents a row for an active id absent from the stored page', () => {
    const stored = [session('a')];
    const rows = selectShareDestinations(stored, new Set(['ghost', 'a']));
    expect(rows.map(r => r.session_id)).toEqual(['a']);
    expect(rows).toHaveLength(1);
  });

  it('returns an empty list when the stored page is empty', () => {
    expect(selectShareDestinations([], new Set(['x']))).toEqual([]);
  });

  it('preserves organization_id on each row for navigation', () => {
    const stored = [session('a', { organization_id: 'org_1' })];
    const rows = selectShareDestinations(stored, new Set());
    expect(rows[0]?.organization_id).toBe('org_1');
  });
});
