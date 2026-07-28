import { describe, expect, it } from 'vitest';

import {
  type ScopeEntryView,
  selectScopeEntryView,
  type SelectScopeEntryViewInput,
} from './scope-entry-render';

const base: SelectScopeEntryViewInput = {
  isLoading: false,
  isError: false,
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

  it('does not return a blank/redirect outcome for the disabled case', () => {
    const result = viewFor({ isEnabled: false });
    expect(result).toBe('disabled-settings');
    expect(result).not.toBe('loading');
    expect(result).not.toBe('error');
    expect(result).not.toBe('dashboard');
  });
});
