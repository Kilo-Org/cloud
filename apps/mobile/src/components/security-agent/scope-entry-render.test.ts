import { describe, expect, it } from 'vitest';

import {
  type ScopeEntryLoadFailure,
  type ScopeEntryView,
  selectScopeEntryLoadFailure,
  type SelectScopeEntryLoadFailureInput,
  selectScopeEntryView,
  type SelectScopeEntryViewInput,
} from './scope-entry-render';

const base: SelectScopeEntryViewInput = {
  isLoading: false,
  isError: false,
  isDenied: false,
  isGithubStatusResolved: true,
  hasIntegration: true,
  hasPermissions: true,
  isEnabled: true,
};

function viewFor(patch: Partial<SelectScopeEntryViewInput>): ScopeEntryView {
  return selectScopeEntryView({ ...base, ...patch });
}

describe('selectScopeEntryView', () => {
  it('returns loading while any dependent query is loading', () => {
    expect(viewFor({ isLoading: true })).toBe('loading');
  });

  it('returns error when not loading and any query errored', () => {
    expect(viewFor({ isError: true })).toBe('error');
  });

  it('returns loading before error when both flags are true', () => {
    expect(selectScopeEntryView({ ...base, isLoading: true, isError: true })).toBe('loading');
  });

  it('returns denied when access is lost', () => {
    expect(viewFor({ isDenied: true })).toBe('denied');
  });

  it('returns denied before error, the setup gates and the dashboard', () => {
    expect(viewFor({ isDenied: true, isError: true })).toBe('denied');
    expect(viewFor({ isDenied: true, hasIntegration: false, hasPermissions: false })).toBe(
      'denied'
    );
    expect(viewFor({ isDenied: true })).not.toBe('dashboard');
  });

  it('returns loading before denied', () => {
    expect(selectScopeEntryView({ ...base, isLoading: true, isDenied: true })).toBe('loading');
  });

  it('returns connect-github when integrated is missing', () => {
    expect(viewFor({ hasIntegration: false })).toBe('connect-github');
  });

  it('returns reauthorize when integration exists but permissions are missing', () => {
    expect(viewFor({ hasPermissions: false })).toBe('reauthorize');
  });

  it('returns connect-github before reauthorize when both are missing', () => {
    expect(selectScopeEntryView({ ...base, hasIntegration: false, hasPermissions: false })).toBe(
      'connect-github'
    );
  });

  it('returns disabled-settings when connected but disabled', () => {
    expect(viewFor({ isEnabled: false })).toBe('disabled-settings');
  });

  it('returns dashboard when connected and enabled', () => {
    expect(viewFor({ isEnabled: true })).toBe('dashboard');
  });

  it.each(['pending', 'failed'])(
    'returns dashboard for an enabled scope whose GitHub status is still %s',
    () => {
      // The config read already decided the destination; only the connect /
      // re-authorize choice needs the status, so an unread one must not hold the
      // enabled entry on a setup gate or the error screen.
      expect(
        viewFor({ isGithubStatusResolved: false, hasIntegration: false, hasPermissions: false })
      ).toBe('dashboard');
    }
  );

  it('keeps the error screen when the GitHub status is unread and the scope is not enabled', () => {
    // Only the enabled destination is known from config alone. Connect vs
    // re-authorize needs the status, so the failure stays fatal there.
    expect(
      viewFor({
        isGithubStatusResolved: false,
        isError: true,
        isEnabled: false,
        hasIntegration: false,
        hasPermissions: false,
      })
    ).toBe('error');
  });

  it('keeps a denied scope denied even when the GitHub status is unread', () => {
    expect(viewFor({ isGithubStatusResolved: false, isDenied: true })).toBe('denied');
  });

  it('does not return a blank/redirect outcome for the disabled case', () => {
    const result = viewFor({ isEnabled: false });
    expect(result).toBe('disabled-settings');
    expect(result).not.toBe('loading');
    expect(result).not.toBe('error');
    expect(result).not.toBe('dashboard');
  });
});

/** A tRPC client rejection, as `readTrpcErrorField` reads it. */
function serverError(code: string): Error {
  return Object.assign(new Error('boom'), { data: { code, message: 'boom' } });
}

const CONNECTION_DESCRIPTION = 'organization.boundary.loadErrorMessage';
const RETRY_DESCRIPTION = 'securityAgent.scopeEntry.retryFailed';

function failureFor(patch: Partial<SelectScopeEntryLoadFailureInput>): ScopeEntryLoadFailure {
  return selectScopeEntryLoadFailure({
    errors: [],
    isPaused: false,
    connectivity: 'online',
    lastAttemptFailed: false,
    ...patch,
  });
}

describe('selectScopeEntryLoadFailure', () => {
  it('names the connection when the failed read never reached the server', () => {
    // A fetch rejection (timeout, refused, cut) carries no tRPC code: NetInfo
    // may still report online, and the system wording would blame the app.
    expect(failureFor({ errors: [new TypeError('Network request failed')] })).toEqual({
      variant: 'offline',
      descriptionKey: CONNECTION_DESCRIPTION,
    });
  });

  it('names the connection on a confirmed-offline device even for a coded error', () => {
    expect(
      failureFor({ errors: [serverError('INTERNAL_SERVER_ERROR')], connectivity: 'offline' })
    ).toEqual({ variant: 'offline', descriptionKey: CONNECTION_DESCRIPTION });
  });

  it('names the connection for a read paused by the online manager', () => {
    expect(failureFor({ isPaused: true })).toEqual({
      variant: 'offline',
      descriptionKey: CONNECTION_DESCRIPTION,
    });
  });

  it('keeps the server wording when a failed read answered with a code', () => {
    expect(failureFor({ errors: [serverError('INTERNAL_SERVER_ERROR')] })).toEqual({
      variant: 'server',
      descriptionKey: null,
    });
  });

  it('keeps the server wording when one read answered and another never did', () => {
    // Some server answered, so the app's own end is a real suspect.
    expect(
      failureFor({
        errors: [serverError('INTERNAL_SERVER_ERROR'), new TypeError('Network request failed')],
      })
    ).toEqual({ variant: 'server', descriptionKey: null });
  });

  it('keeps the server wording after a failed retry of a coded error', () => {
    // The "still could not load" line names the connection, which a 500 is not.
    expect(
      failureFor({ errors: [serverError('INTERNAL_SERVER_ERROR')], lastAttemptFailed: true })
    ).toEqual({ variant: 'server', descriptionKey: null });
  });

  it('distinguishes a failed retry of a connection failure', () => {
    expect(
      failureFor({
        errors: [new TypeError('Network request failed')],
        lastAttemptFailed: true,
      })
    ).toEqual({ variant: 'offline', descriptionKey: RETRY_DESCRIPTION });
  });

  it('does not claim the connection without a failure to classify', () => {
    expect(failureFor({})).toEqual({ variant: 'server', descriptionKey: null });
  });
});
