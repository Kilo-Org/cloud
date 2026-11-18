import { resolveSessionBranch } from './session-context-display';

describe('resolveSessionBranch', () => {
  it('shows the assigned branch as soon as metadata is available', () => {
    expect(
      resolveSessionBranch({
        scope: { displayedKiloSessionId: 'ses_a', displayedWorktreeId: null },
        metadata: { kiloSessionId: 'ses_a', branch: 'kilo/assigned' },
      })
    ).toBe('kilo/assigned');
  });

  it('ignores metadata that belongs to a different displayed chat', () => {
    const scope = { displayedKiloSessionId: 'ses_b', displayedWorktreeId: null };
    const metadata = { kiloSessionId: 'ses_a', branch: 'kilo/other' };

    expect(resolveSessionBranch({ scope, metadata })).toBeNull();
  });

  it('ignores branch metadata scoped to a different worktree', () => {
    expect(
      resolveSessionBranch({
        scope: { displayedKiloSessionId: null, displayedWorktreeId: 'wt_1' },
        metadata: { kiloSessionId: 'ses_a', worktreeId: 'wt_2', branch: 'kilo/other' },
      })
    ).toBeNull();
  });

  it('matches worktree scope when no chat is selected', () => {
    expect(
      resolveSessionBranch({
        scope: { displayedKiloSessionId: null, displayedWorktreeId: 'wt_1' },
        metadata: { kiloSessionId: 'ses_a', worktreeId: 'wt_1', branch: 'kilo/assigned' },
      })
    ).toBe('kilo/assigned');
  });

  it('shows no branch while metadata is missing', () => {
    const scope = { displayedKiloSessionId: 'ses_a', displayedWorktreeId: null };

    expect(resolveSessionBranch({ scope, metadata: null })).toBeNull();
    expect(
      resolveSessionBranch({
        scope,
        metadata: { kiloSessionId: 'ses_a', branch: null },
      })
    ).toBeNull();
  });

  it('never fabricates a default branch when no assignment is known', () => {
    const scope = { displayedKiloSessionId: 'ses_a', displayedWorktreeId: null };

    expect(resolveSessionBranch({ scope, metadata: null })).toBeNull();
    expect(
      resolveSessionBranch({
        scope,
        metadata: { kiloSessionId: 'ses_a', branch: '   ' },
      })
    ).toBeNull();
    expect(
      resolveSessionBranch({
        scope: { displayedKiloSessionId: null, displayedWorktreeId: null },
        metadata: null,
      })
    ).toBeNull();
  });
});
