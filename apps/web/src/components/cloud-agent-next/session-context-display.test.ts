import { resolveSessionBranchDisplay } from './session-context-display';

describe('resolveSessionBranchDisplay', () => {
  it('keeps the assigned branch visible while the session is still preparing', () => {
    expect(
      resolveSessionBranchDisplay({
        scope: { displayedKiloSessionId: 'ses_a', displayedWorktreeId: null },
        metadata: { kiloSessionId: 'ses_a', branch: 'kilo/assigned' },
        isPreparing: true,
      })
    ).toEqual({ kind: 'branch', branch: 'kilo/assigned' });
  });

  it('ignores metadata that belongs to a different displayed chat', () => {
    const scope = { displayedKiloSessionId: 'ses_b', displayedWorktreeId: null };
    const metadata = { kiloSessionId: 'ses_a', branch: 'kilo/other' };

    expect(resolveSessionBranchDisplay({ scope, metadata, isPreparing: false })).toEqual({
      kind: 'unavailable',
    });
    expect(resolveSessionBranchDisplay({ scope, metadata, isPreparing: true })).toEqual({
      kind: 'assigning',
    });
  });

  it('ignores branch metadata scoped to a different worktree', () => {
    expect(
      resolveSessionBranchDisplay({
        scope: { displayedKiloSessionId: null, displayedWorktreeId: 'wt_1' },
        metadata: { kiloSessionId: 'ses_a', worktreeId: 'wt_2', branch: 'kilo/other' },
        isPreparing: false,
      })
    ).toEqual({ kind: 'unavailable' });
  });

  it('matches worktree scope when no chat is selected', () => {
    expect(
      resolveSessionBranchDisplay({
        scope: { displayedKiloSessionId: null, displayedWorktreeId: 'wt_1' },
        metadata: { kiloSessionId: 'ses_a', worktreeId: 'wt_1', branch: 'kilo/assigned' },
        isPreparing: true,
      })
    ).toEqual({ kind: 'branch', branch: 'kilo/assigned' });
  });

  it('shows an honest assigning state while recovery metadata is still missing', () => {
    const scope = { displayedKiloSessionId: 'ses_a', displayedWorktreeId: null };

    expect(resolveSessionBranchDisplay({ scope, metadata: null, isPreparing: true })).toEqual({
      kind: 'assigning',
    });
    expect(
      resolveSessionBranchDisplay({
        scope,
        metadata: { kiloSessionId: 'ses_a', branch: null },
        isPreparing: true,
      })
    ).toEqual({ kind: 'assigning' });
  });

  it('never fabricates a default branch when no assignment is known', () => {
    const scope = { displayedKiloSessionId: 'ses_a', displayedWorktreeId: null };

    expect(resolveSessionBranchDisplay({ scope, metadata: null, isPreparing: false })).toEqual({
      kind: 'unavailable',
    });
    expect(
      resolveSessionBranchDisplay({
        scope,
        metadata: { kiloSessionId: 'ses_a', branch: '   ' },
        isPreparing: false,
      })
    ).toEqual({ kind: 'unavailable' });
    expect(
      resolveSessionBranchDisplay({
        scope: { displayedKiloSessionId: null, displayedWorktreeId: null },
        metadata: null,
        isPreparing: true,
      })
    ).toEqual({ kind: 'unavailable' });
  });
});
