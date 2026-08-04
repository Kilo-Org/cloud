import { describe, expect, it, vi } from 'vitest';

import {
  getGitHubInstallReturnOutcome,
  type GitHubInstallReturnOutcome,
  parseGitHubReturnParams,
  setGitHubInstallReturnOutcome,
  subscribeToGitHubInstallReturnOutcome,
} from './github-install-return';

describe('github-install-return', () => {
  it('parseGitHubReturnParams returns success on github_install=success', () => {
    expect(parseGitHubReturnParams('?github_install=success')).toEqual({ kind: 'success' });
  });

  it('parseGitHubReturnParams returns pending on github_pending_approval=true', () => {
    expect(parseGitHubReturnParams('?github_pending_approval=true')).toEqual({ kind: 'pending' });
  });

  it('parseGitHubReturnParams returns error with code', () => {
    expect(parseGitHubReturnParams('?error=install_state_user_mismatch')).toEqual({
      kind: 'error',
      code: 'install_state_user_mismatch',
    });
  });

  it('parseGitHubReturnParams returns null for irrelevant params', () => {
    expect(parseGitHubReturnParams('?foo=bar')).toBeNull();
    expect(parseGitHubReturnParams('')).toBeNull();
  });

  it('parseGitHubReturnParams returns success when both github_install and error present', () => {
    // github_install takes priority (checked first).
    expect(parseGitHubReturnParams('?github_install=success&error=something')).toEqual({
      kind: 'success',
    });
  });

  it('get-and-clear clears the slot after read', () => {
    const outcome: GitHubInstallReturnOutcome = { kind: 'success' };
    setGitHubInstallReturnOutcome(outcome);
    expect(getGitHubInstallReturnOutcome()).toEqual(outcome);
    // Second read returns null — slot is cleared.
    expect(getGitHubInstallReturnOutcome()).toBeNull();
  });

  it('set null outcome yields null from get', () => {
    setGitHubInstallReturnOutcome(null);
    expect(getGitHubInstallReturnOutcome()).toBeNull();
  });

  it('parseGitHubReturnParams returns error for all four plan error codes', () => {
    expect(parseGitHubReturnParams('?error=install_state_user_mismatch')?.kind).toBe('error');
    expect(parseGitHubReturnParams('?error=not_installation_admin')?.kind).toBe('error');
    expect(parseGitHubReturnParams('?error=installation_already_claimed')?.kind).toBe('error');
    expect(parseGitHubReturnParams('?error=installation_failed')?.kind).toBe('error');
  });

  it('parseGitHubReturnParams returns error with code for pending_setup_failed', () => {
    const outcome = parseGitHubReturnParams('?error=pending_setup_failed');
    expect(outcome).toEqual({ kind: 'error', code: 'pending_setup_failed' });
  });

  it('parseGitHubReturnParams returns pending when both pending_approval and error present', () => {
    // pending is checked before error.
    const outcome = parseGitHubReturnParams('?github_pending_approval=true&error=some_error');
    expect(outcome).toEqual({ kind: 'pending' });
  });

  it('get-and-clear clears error slot after read', () => {
    const outcome: GitHubInstallReturnOutcome = {
      kind: 'error',
      code: 'installation_failed',
    };
    setGitHubInstallReturnOutcome(outcome);
    expect(getGitHubInstallReturnOutcome()).toEqual(outcome);
    expect(getGitHubInstallReturnOutcome()).toBeNull();
  });

  it('notifies a mounted Agents tab about a warm return', () => {
    const listener = vi.fn(() => {
      getGitHubInstallReturnOutcome();
    });
    const unsubscribe = subscribeToGitHubInstallReturnOutcome(listener);

    setGitHubInstallReturnOutcome({ kind: 'success' });

    expect(listener).toHaveBeenCalledTimes(1);
    // Outcome is consumed by the listener — a second read returns null.
    expect(getGitHubInstallReturnOutcome()).toBeNull();
    unsubscribe();
  });
});
