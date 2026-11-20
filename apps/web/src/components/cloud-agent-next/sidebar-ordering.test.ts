import { describe, expect, it } from '@jest/globals';
import {
  comparePositionKeys,
  getPositionBetween,
  groupWorkspaceGroupsByDestination,
  isValidPositionKey,
  sortWorkspaceGroups,
  sortSmartFolderGroups,
  type SidebarWorkspaceGroup,
  type SidebarWorkspaceRow,
} from './sidebar-ordering';

const AT = '2026-01-01T00:00:00.000Z';

function row(
  worktreeId: string,
  overrides: Partial<SidebarWorkspaceRow> = {}
): SidebarWorkspaceRow {
  return {
    worktreeId,
    createdAt: AT,
    lastActivityAt: AT,
    sidebarPosition: null,
    folderId: null,
    parentWorktreeId: null,
    prState: null,
    status: null,
    statusUpdatedAt: null,
    hasPendingQuestion: false,
    lastTurnFailed: false,
    destination: { kind: 'ungrouped' },
    ...overrides,
  };
}

function group(
  worktreeId: string,
  overrides: Partial<SidebarWorkspaceRow> = {},
  layers: SidebarWorkspaceRow[] = []
): SidebarWorkspaceGroup {
  return { root: row(worktreeId, overrides), layers };
}

describe('workspace ordering', () => {
  it('orders manual rows with the unpositioned first, then bytewise positions', () => {
    const groups = [
      group('positioned-9', { sidebarPosition: 'a9' }),
      group('unpositioned-old', {
        createdAt: '2025-01-01T00:00:00.000Z',
      }),
      group('positioned-8', { sidebarPosition: 'a8' }),
      group('unpositioned-new'),
    ];
    expect(sortWorkspaceGroups(groups, 'manual').map(item => item.root.worktreeId)).toEqual([
      'unpositioned-new',
      'unpositioned-old',
      'positioned-8',
      'positioned-9',
    ]);
    expect(comparePositionKeys('a8', 'a9')).toBeLessThan(0);
  });

  it('orders activity rows by last activity and falls back to created order on ties', () => {
    const groups = [
      group('old', { createdAt: '2025-01-01T00:00:00.000Z' }),
      group('newer', {
        createdAt: '2025-02-01T00:00:00.000Z',
        lastActivityAt: '2026-02-01T00:00:00.000Z',
      }),
      group('newest', { lastActivityAt: '2026-03-01T00:00:00.000Z' }),
    ];
    expect(sortWorkspaceGroups(groups, 'activity').map(item => item.root.worktreeId)).toEqual([
      'newest',
      'newer',
      'old',
    ]);
  });

  it('creates and validates fractional positions with the shared helper', () => {
    const between = getPositionBetween('a2', null);
    expect(isValidPositionKey(between)).toBe(true);
    expect(comparePositionKeys(between, 'a2')).toBeGreaterThan(0);
    expect(isValidPositionKey('a0')).toBe(false);
    expect(isValidPositionKey(null)).toBe(false);
  });

  it('orders a stack by the newest layer activity', () => {
    const stacked = group('stack', {}, [
      row('layer', { lastActivityAt: '2026-03-01T00:00:00.000Z' }),
    ]);
    expect(sortWorkspaceGroups([group('other'), stacked], 'activity')[0]).toBe(stacked);
  });
});

describe('smart folder ordering', () => {
  it('uses its own saved order, not positions from regular folders or Ungrouped', () => {
    const groups = [
      group('first', { sidebarPosition: 'a2' }),
      group('second', { sidebarPosition: 'a1' }),
    ];
    expect(sortSmartFolderGroups(groups, 'manual', ['first', 'second'])).toEqual(groups);
    expect(groups.map(item => item.root.sidebarPosition)).toEqual(['a2', 'a1']);
  });

  it('puts new members above the saved order, even if they already have sidebar positions', () => {
    const groups = [
      group('saved-first'),
      group('new-old-workspace', {
        sidebarPosition: 'z',
        createdAt: '2025-01-01T00:00:00.000Z',
        statusUpdatedAt: '2026-03-01T00:00:00.000Z',
      }),
      group('saved-second'),
      group('other-new', { statusUpdatedAt: '2026-02-01T00:00:00.000Z' }),
    ];
    expect(
      sortSmartFolderGroups(groups, 'manual', ['saved-first', 'saved-second']).map(
        item => item.root.worktreeId
      )
    ).toEqual(['new-old-workspace', 'other-new', 'saved-first', 'saved-second']);
  });

  it('uses stack activity for new arrivals and ignores saved members that no longer match', () => {
    const root = group('stack', {}, [
      row('layer', { statusUpdatedAt: '2026-02-01T00:00:00.000Z' }),
    ]);
    expect(sortSmartFolderGroups([group('other'), root], 'manual', ['absent'])).toEqual([
      root,
      group('other'),
    ]);
  });

  it.each(['created', 'activity'] as const)(
    'keeps %s sorting independent of manual order',
    order => {
      const groups = [group('old', { createdAt: '2025-01-01T00:00:00.000Z' }), group('new')];
      expect(sortSmartFolderGroups(groups, order, ['old', 'new'])).toEqual(
        sortWorkspaceGroups(groups, order)
      );
    }
  );
});

describe('groupWorkspaceGroupsByDestination', () => {
  const needsYou = group('needs', { destination: { kind: 'smart', preset: 'needs_you' } });
  const manual = group('manual', { destination: { kind: 'manual', folderId: 'manual-folder' } });
  const inReview = group('review', { destination: { kind: 'smart', preset: 'in_review' } });
  const done = group('done', { destination: { kind: 'smart', preset: 'done' } });

  it('groups rows by the destination selected by the server', () => {
    const destinations = groupWorkspaceGroupsByDestination([needsYou, manual, inReview, done]);
    expect(destinations.smart.get('needs_you')?.map(item => item.root.worktreeId)).toEqual([
      'needs',
    ]);
    expect(destinations.manual.get('manual-folder')?.map(item => item.root.worktreeId)).toEqual([
      'manual',
    ]);
    expect(destinations.smart.get('in_review')?.map(item => item.root.worktreeId)).toEqual([
      'review',
    ]);
    expect(destinations.smart.get('done')?.map(item => item.root.worktreeId)).toEqual(['done']);
    expect(destinations.unfiled).toEqual([]);
  });

  it('does not recalculate destinations from live status or PR information', () => {
    const destinations = groupWorkspaceGroupsByDestination([
      group('ungrouped', { status: 'question', prState: 'open' }),
      { ...manual, layers: [row('running', { status: 'failed' })] },
    ]);
    expect(destinations.smart.size).toBe(0);
    expect(destinations.manual.get('manual-folder')?.map(item => item.root.worktreeId)).toEqual([
      'manual',
    ]);
    expect(destinations.unfiled.map(item => item.root.worktreeId)).toEqual(['ungrouped']);
  });
});
