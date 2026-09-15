import { describe, expect, it } from 'vitest';

import {
  parseStoredRunOnDestination,
  resolvePersistedRunOn,
  shouldRestorePersistedRunOn,
} from './run-on-destination';

const CLI = { connectionId: 'cli-1', name: 'MacBook' };
const REMOTE = { connectionId: 'remote-1', name: 'VM' };

describe('parseStoredRunOnDestination', () => {
  it('treats missing or empty storage as Cloud Agent', () => {
    expect(parseStoredRunOnDestination(null)).toBeNull();
    expect(parseStoredRunOnDestination('')).toBeNull();
  });

  it('returns a stored connection id', () => {
    expect(parseStoredRunOnDestination('cli-1')).toBe('cli-1');
  });
});

describe('resolvePersistedRunOn', () => {
  it('defaults to Cloud Agent when nothing is stored', () => {
    expect(resolvePersistedRunOn(null, [CLI])).toBeNull();
  });

  it('returns the live row when the stored id is in the list', () => {
    expect(resolvePersistedRunOn('cli-1', [REMOTE, CLI])).toBe(CLI);
  });

  it('falls back to Cloud Agent when the stored id is gone', () => {
    expect(resolvePersistedRunOn('cli-1', [REMOTE])).toBeNull();
    expect(resolvePersistedRunOn('cli-1', [])).toBeNull();
  });
});

describe('shouldRestorePersistedRunOn', () => {
  it('restores the stored preference for every ordinary entry', () => {
    expect(shouldRestorePersistedRunOn(undefined)).toBe(true);
    expect(shouldRestorePersistedRunOn('')).toBe(true);
    expect(shouldRestorePersistedRunOn('cli-1')).toBe(true);
  });

  it('skips the restore when the tour asks for Cloud Agent', () => {
    expect(shouldRestorePersistedRunOn('cloud')).toBe(false);
    expect(shouldRestorePersistedRunOn(['cloud'])).toBe(false);
  });
});
