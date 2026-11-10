import { describe, expect, it } from '@jest/globals';
import type { WorkspaceFolder } from '@/lib/cloud-agent/workspace-folders';
import {
  comparePositionKeys,
  getPositionBetween,
  groupWorkspaceGroupsByDestination,
  isValidPositionKey,
  sortSmartFolderGroups,
  sortWorkspaceGroups,
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

function folder(id: string, overrides: Partial<WorkspaceFolder> = {}): WorkspaceFolder {
  return {
    id,
    name: id,
    color: 'default',
    kind: 'manual',
    smartPreset: null,
    sortMode: 'manual',
    worktreeIds: [],
    ...overrides,
  };
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
});

describe('groupWorkspaceGroupsByDestination', () => {
  const needsYou = group('needs', { status: 'question', statusUpdatedAt: AT });
  const manual = group('manual', { folderId: 'manual-folder', prState: 'open' });
  const inReview = group('review', { prState: 'draft' });
  const done = group('done', { prState: 'merged' }, [row('done-layer', { prState: 'merged' })]);

  it('puts urgent stacks in an enabled Needs you folder before manual folders', () => {
    const destinations = groupWorkspaceGroupsByDestination(
      [needsYou, manual, inReview, done],
      [
        folder('needs-folder', { kind: 'smart', smartPreset: 'needs_you' }),
        folder('review-folder', { kind: 'smart', smartPreset: 'in_review' }),
        folder('done-folder', { kind: 'smart', smartPreset: 'done' }),
        folder('manual-folder'),
      ]
    );
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

  it('falls back to manual and unfiled when automatic folders are disabled', () => {
    const destinations = groupWorkspaceGroupsByDestination(
      [needsYou, manual, inReview, done],
      [folder('manual-folder')]
    );
    expect(destinations.smart.size).toBe(0);
    expect(destinations.manual.get('manual-folder')?.map(item => item.root.worktreeId)).toEqual([
      'manual',
    ]);
    expect(destinations.unfiled.map(item => item.root.worktreeId)).toEqual([
      'needs',
      'review',
      'done',
    ]);
  });

  it('sorts Needs you by the oldest waiting status', () => {
    const older = group('older', {
      status: 'failed',
      statusUpdatedAt: '2026-01-01T00:00:00.000Z',
    });
    const newer = group('newer', {
      hasPendingQuestion: true,
      statusUpdatedAt: '2026-02-01T00:00:00.000Z',
    });
    expect(
      sortSmartFolderGroups([newer, older], 'needs_you', 'manual').map(item => item.root.worktreeId)
    ).toEqual(['older', 'newer']);
  });
});
