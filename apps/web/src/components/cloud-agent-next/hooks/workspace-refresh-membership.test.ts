import {
  UNGROUPED_WORKSPACE_LIMIT,
  WORKSPACE_FOLDER_LIMIT,
} from '@/lib/cloud-agent/workspace-activity';
import type { WorkspaceSummary } from './useWorkspaceSummaries';
import { workspaceSummaryFixture } from './workspace-summary-test-fixtures';
import {
  acceptsSidebarStatusUpdate,
  workspaceRefreshChangesMembership,
} from './workspace-refresh-membership';

const BASE = Date.parse('2026-11-16T12:00:00.000Z');
const at = (offset: number) => new Date(BASE + offset).toISOString();

function roots(
  count: number,
  destination: WorkspaceSummary['destination'] = { kind: 'ungrouped' }
) {
  return Array.from({ length: count }, (_, index) =>
    workspaceSummaryFixture({
      worktreeId: `synthetic-root-${index}`,
      stackRootId: `synthetic-root-${index}`,
      destination,
      lastActivityAt: at(index * 1_000),
    })
  );
}

describe('workspaceRefreshChangesMembership', () => {
  it('does not refresh membership for a known workspace status or activity change', () => {
    const [current] = roots(1);
    const refreshed = { ...current, sessionStatus: 'busy', lastActivityAt: at(60_000) };
    expect(workspaceRefreshChangesMembership([current], [refreshed], [current.worktreeId])).toBe(
      false
    );
  });

  it('ignores an unknown old ungrouped workspace below the 50-root cutoff', () => {
    const current = roots(UNGROUPED_WORKSPACE_LIMIT);
    const old = workspaceSummaryFixture({ lastActivityAt: at(-1_000) });
    expect(workspaceRefreshChangesMembership(current, [old], [old.worktreeId])).toBe(false);
  });

  it('refreshes membership when a new workspace fits below the destination limit', () => {
    const current = roots(UNGROUPED_WORKSPACE_LIMIT - 1);
    const old = workspaceSummaryFixture({ lastActivityAt: at(-1_000) });
    expect(workspaceRefreshChangesMembership(current, [old], [old.worktreeId])).toBe(true);
  });

  it('refreshes membership when new activity enters the visible ungrouped roots', () => {
    const current = roots(UNGROUPED_WORKSPACE_LIMIT);
    const recent = workspaceSummaryFixture({ lastActivityAt: at(100_000) });
    expect(workspaceRefreshChangesMembership(current, [recent], [recent.worktreeId])).toBe(true);
  });

  it('uses stack activity, not only root activity, for the visibility cutoff', () => {
    const current = roots(UNGROUPED_WORKSPACE_LIMIT);
    const layer = workspaceSummaryFixture({
      worktreeId: 'synthetic-layer',
      stackRootId: current[0].worktreeId,
      parentWorktreeId: current[0].worktreeId,
      lastActivityAt: at(100_000),
    });
    const hidden = workspaceSummaryFixture({ lastActivityAt: at(500) });
    expect(
      workspaceRefreshChangesMembership([...current, layer], [hidden], [hidden.worktreeId])
    ).toBe(false);
    const eligible = { ...hidden, lastActivityAt: at(1_500) };
    expect(
      workspaceRefreshChangesMembership([...current, layer], [eligible], [eligible.worktreeId])
    ).toBe(true);
  });

  it('always refreshes membership for an unknown Needs You workspace', () => {
    const current = roots(WORKSPACE_FOLDER_LIMIT, { kind: 'smart', preset: 'needs_you' });
    const needsYou = workspaceSummaryFixture({
      destination: { kind: 'smart', preset: 'needs_you' },
      lastActivityAt: at(-1_000),
    });
    expect(workspaceRefreshChangesMembership(current, [needsYou], [needsYou.worktreeId])).toBe(
      true
    );
  });

  it('applies the 500-root limit independently to a manual destination', () => {
    const destination = { kind: 'manual', folderId: 'synthetic-folder' } as const;
    const current = roots(WORKSPACE_FOLDER_LIMIT, destination);
    const old = workspaceSummaryFixture({ destination, lastActivityAt: at(-1_000) });
    expect(workspaceRefreshChangesMembership(current, [old], [old.worktreeId])).toBe(false);
    expect(workspaceRefreshChangesMembership(current.slice(1), [old], [old.worktreeId])).toBe(true);
  });

  it.each<WorkspaceSummary['destination']>([
    { kind: 'manual', folderId: 'synthetic-folder' },
    { kind: 'smart', preset: 'needs_you' },
    { kind: 'smart', preset: 'in_review' },
  ])('refreshes membership when a known workspace changes destination to %j', destination => {
    const [current] = roots(1);
    expect(
      workspaceRefreshChangesMembership(
        [current],
        [{ ...current, destination }],
        [current.worktreeId]
      )
    ).toBe(true);
  });

  it('refreshes membership when a known workspace moves into another stack', () => {
    const [current] = roots(1);
    expect(
      workspaceRefreshChangesMembership(
        [current],
        [{ ...current, stackRootId: 'synthetic-other-root' }],
        [current.worktreeId]
      )
    ).toBe(true);
  });

  it('refreshes membership for a new layer in an already visible stack', () => {
    const [current] = roots(1);
    const layer = workspaceSummaryFixture({ stackRootId: current.worktreeId });
    expect(workspaceRefreshChangesMembership([current], [layer], [layer.worktreeId])).toBe(true);
  });

  it('refreshes membership only when a missing requested workspace was loaded', () => {
    const [current] = roots(1);
    expect(workspaceRefreshChangesMembership([current], [], [current.worktreeId])).toBe(true);
    expect(workspaceRefreshChangesMembership([current], [], ['synthetic-hidden-root'])).toBe(false);
  });
});

describe('acceptsSidebarStatusUpdate', () => {
  it.each([
    {
      currentStatusAt: at(2_000),
      incomingStatusAt: at(1_000),
      incomingUpdatedAt: at(3_000),
      accepts: false,
    },
    { currentStatusAt: null, incomingStatusAt: null, incomingUpdatedAt: at(1_000), accepts: false },
    {
      currentStatusAt: at(2_000),
      incomingStatusAt: at(2_000),
      incomingUpdatedAt: at(2_000),
      accepts: true,
    },
    { currentStatusAt: null, incomingStatusAt: null, incomingUpdatedAt: at(3_000), accepts: true },
  ])(
    'uses the status timestamp with updatedAt as its fallback: %j',
    ({ currentStatusAt, incomingStatusAt, incomingUpdatedAt, accepts }) => {
      expect(
        acceptsSidebarStatusUpdate(
          { statusUpdatedAt: currentStatusAt, updatedAt: at(2_000) },
          { statusUpdatedAt: incomingStatusAt, updatedAt: incomingUpdatedAt }
        )
      ).toBe(accepts);
    }
  );
});
