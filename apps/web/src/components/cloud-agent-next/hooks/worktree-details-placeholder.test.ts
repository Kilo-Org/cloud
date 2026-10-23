import { getCachedWorktreeDetails, getLoadingWorktreeIds } from './worktree-details-placeholder';

function key(worktreeIds: string[], organizationId: string | null) {
  return [
    ['cliSessionsV2', 'worktreeDetails'],
    { input: { worktreeIds, organizationId }, type: 'query' },
  ] as const;
}

describe('getCachedWorktreeDetails', () => {
  it('reuses details from an earlier batch while a re-keyed batch loads', () => {
    const cached = [
      [key(['wt_a', 'wt_b'], null), { worktrees: { wt_a: 'Alpha', wt_b: 'Beta' } }],
    ] as const;
    expect(getCachedWorktreeDetails(cached, ['wt_a', 'wt_b', 'wt_new'], null)).toEqual({
      worktrees: { wt_a: 'Alpha', wt_b: 'Beta' },
    });
  });

  it('keeps scopes separate and reports nothing when nothing is known', () => {
    const cached = [[key(['wt_a'], 'org_1'), { worktrees: { wt_a: 'Org alpha' } }]] as const;
    expect(getCachedWorktreeDetails(cached, ['wt_a'], null)).toBeUndefined();
    expect(getCachedWorktreeDetails(cached, ['wt_a'], 'org_1')).toEqual({
      worktrees: { wt_a: 'Org alpha' },
    });
  });
});

describe('getLoadingWorktreeIds', () => {
  const batches = [['wt_a', 'wt_new']];

  it('marks only worktrees missing from placeholder details as loading', () => {
    expect(
      getLoadingWorktreeIds(
        [{ data: { worktrees: { wt_a: 'Alpha' } }, isPending: false, isPlaceholderData: true }],
        batches
      )
    ).toEqual(['wt_new']);
  });

  it('marks the whole batch while nothing is known and nothing once settled', () => {
    expect(getLoadingWorktreeIds([{ isPending: true, isPlaceholderData: false }], batches)).toEqual(
      ['wt_a', 'wt_new']
    );
    // A settled response that omits a worktree means it has no details, not that it is loading.
    expect(
      getLoadingWorktreeIds(
        [{ data: { worktrees: { wt_a: 'Alpha' } }, isPending: false, isPlaceholderData: false }],
        batches
      )
    ).toEqual([]);
  });
});
