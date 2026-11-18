import {
  aggregateWorkspaceActivity,
  selectVisibleWorkspaceGroups,
  workspaceDestination,
  WORKSPACE_STALE_STATUS_MS,
  type WorkspaceSessionActivity,
} from './workspace-activity';

const now = Date.parse('2026-11-16T12:00:00Z');
function chat(
  sessionId: string,
  values: Partial<WorkspaceSessionActivity> = {}
): WorkspaceSessionActivity {
  return {
    sessionId,
    sessionStatus: 'idle',
    sessionStatusUpdatedAt: '2026-11-16 11:00:00+00',
    latestRunFailureKind: null,
    latestRunTerminalAt: null,
    createdAt: '2026-11-16T10:00:00Z',
    lastActivityAt: null,
    updatedAt: '2026-11-16T11:00:00Z',
    ...values,
  };
}

it('ranks running above failure, and attention above running', () => {
  const rows = [
    chat('failure', {
      createdAt: '2026-11-16T11:00:00Z',
      latestRunFailureKind: 'failed',
      latestRunTerminalAt: '2026-11-16 11:30:00+00',
    }),
    chat('running', { sessionStatus: 'busy' }),
  ];
  expect(aggregateWorkspaceActivity(rows, now)).toMatchObject({
    kind: 'running',
    sessionId: 'running',
  });
  expect(
    aggregateWorkspaceActivity([...rows, chat('attention', { sessionStatus: 'permission' })], now)
  ).toMatchObject({ kind: 'attention', sessionId: 'attention' });
});

it('only counts failure on the latest active chat', () => {
  expect(
    aggregateWorkspaceActivity(
      [
        chat('old', {
          latestRunFailureKind: 'failed',
          latestRunTerminalAt: '2026-11-16T11:30:00Z',
        }),
        chat('new', { lastActivityAt: '2026-11-16T11:45:00Z' }),
      ],
      now
    ).kind
  ).toBe('idle');
});

it('hides failure after a newer status, including idle', () => {
  expect(
    aggregateWorkspaceActivity(
      [
        chat('chat', {
          latestRunFailureKind: 'failed',
          latestRunTerminalAt: '2026-11-16T10:30:00Z',
        }),
      ],
      now
    ).kind
  ).toBe('idle');
});

it.each(['busy', 'retry'])('expires %s at three hours, not twenty minutes', sessionStatus => {
  expect(aggregateWorkspaceActivity([chat('chat', { sessionStatus })], now).kind).toBe('running');
  expect(
    aggregateWorkspaceActivity(
      [
        chat('chat', {
          sessionStatus,
          sessionStatusUpdatedAt: new Date(now - WORKSPACE_STALE_STATUS_MS).toISOString(),
        }),
      ],
      now
    ).kind
  ).toBe('idle');
});

it.each(['busy', 'retry'])(
  'uses the last record update when %s has no status timestamp',
  sessionStatus => {
    expect(
      aggregateWorkspaceActivity(
        [chat('chat', { sessionStatus, sessionStatusUpdatedAt: null })],
        now
      ).kind
    ).toBe('running');
    expect(
      aggregateWorkspaceActivity(
        [
          chat('chat', {
            sessionStatus,
            sessionStatusUpdatedAt: null,
            updatedAt: new Date(now - WORKSPACE_STALE_STATUS_MS).toISOString(),
          }),
        ],
        now
      ).kind
    ).toBe('idle');
  }
);

it.each(['queued', 'accepted'])('does not turn a %s run into activity', latestRunStatus => {
  const session = { ...chat('chat'), latestRunStatus };
  expect(aggregateWorkspaceActivity([session], now).kind).toBe('idle');
});

it('uses the root folder and gives Needs you precedence', () => {
  const folders = [
    { id: 'manual', kind: 'manual', smartPreset: null },
    { id: 'needs', kind: 'smart', smartPreset: 'needs_you' as const },
  ];
  const group = {
    root: { folderId: 'manual', prState: 'open', status: null },
    layers: [{ folderId: null, prState: null, status: 'question' }],
  };
  expect(workspaceDestination(group, folders)).toEqual({ kind: 'smart', preset: 'needs_you' });
  expect(workspaceDestination({ ...group, layers: [] }, folders)).toEqual({
    kind: 'manual',
    folderId: 'manual',
  });
});

it('selects the last fifty stacks by any layer activity and reports folder totals', () => {
  const groups = Array.from({ length: 501 }, (_, index) => ({
    root: {
      worktreeId: String(index),
      lastActivityAt: new Date(index * 1000).toISOString(),
      destination: { kind: 'manual' as const, folderId: 'manual' },
    },
    layers: [] as { lastActivityAt: string }[],
  }));
  expect(selectVisibleWorkspaceGroups(groups).groups.map(group => group.root.worktreeId)).toEqual(
    groups
      .slice(1)
      .toReversed()
      .map(group => group.root.worktreeId)
  );
  expect(selectVisibleWorkspaceGroups(groups).totals).toEqual({ manual: 501 });
  const ungrouped = groups.map(group => ({
    ...group,
    root: { ...group.root, destination: { kind: 'ungrouped' as const } },
  }));
  ungrouped[0].layers.push({ lastActivityAt: new Date(1_000_000).toISOString() });
  const selected = selectVisibleWorkspaceGroups(ungrouped);
  expect(selected.groups).toHaveLength(50);
  expect(selected.groups[0].root.worktreeId).toBe('0');
  expect(selected.groups[49].root.worktreeId).toBe('452');
  expect(selected.totals).toEqual({ ungrouped: 501 });
  const needsYou = groups.map(group => ({
    ...group,
    root: { ...group.root, destination: { kind: 'smart' as const, preset: 'needs_you' as const } },
  }));
  expect(selectVisibleWorkspaceGroups(needsYou).groups).toHaveLength(501);
});
