import { describe, expect, it, vi } from 'vitest';

// The map persists through the account metadata store; this suite covers the
// map's own rules, so the store is a stub that never touches the disk.
vi.mock('@/lib/hooks/secure-store-preference', () => ({
  createSecureStorePreference: () => ({
    preload: () => {},
    get: () => ({}),
    getRequested: () => ({}),
    set: () => {},
    subscribe: () => () => {},
    clear: () => {},
  }),
}));

import {
  MAX_STORED_ENVIRONMENT_CHOICES,
  parseStoredEnvironmentChoice,
  withEnvironmentChoice,
  withoutEnvironmentChoice,
} from './environment-choice';

function choices(count: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`personal|github|repo-${index}`, `env-${index}`])
  );
}

describe('withEnvironmentChoice', () => {
  it('records the pick against its repository', () => {
    expect(withEnvironmentChoice({}, 'personal|github|a/b', 'env-1')).toEqual({
      'personal|github|a/b': 'env-1',
    });
  });

  it('moves a re-picked repository to the most recent position', () => {
    const stored = { 'personal|github|a/b': 'env-1', 'personal|github|c/d': 'env-2' };

    const next = withEnvironmentChoice(stored, 'personal|github|a/b', 'env-3');

    expect(Object.keys(next)).toEqual(['personal|github|c/d', 'personal|github|a/b']);
    expect(next['personal|github|a/b']).toBe('env-3');
  });

  it('keeps the most recent repositories and drops the oldest past the cap', () => {
    const next = withEnvironmentChoice(
      choices(MAX_STORED_ENVIRONMENT_CHOICES),
      'new|repo',
      'env-new'
    );

    expect(Object.keys(next)).toHaveLength(MAX_STORED_ENVIRONMENT_CHOICES);
    expect(Object.hasOwn(next, 'new|repo')).toBe(true);
    expect(Object.hasOwn(next, 'personal|github|repo-0')).toBe(false);
    expect(Object.hasOwn(next, 'personal|github|repo-1')).toBe(true);
  });

  it('keeps every entry under the cap', () => {
    const next = withEnvironmentChoice(choices(3), 'new|repo', 'env-new');

    expect(Object.keys(next)).toHaveLength(4);
  });
});

describe('withoutEnvironmentChoice', () => {
  it('drops only the named repository', () => {
    const stored = { 'personal|github|a/b': 'env-1', 'personal|github|c/d': 'env-2' };

    expect(withoutEnvironmentChoice(stored, 'personal|github|a/b')).toEqual({
      'personal|github|c/d': 'env-2',
    });
  });

  it('returns the map unchanged when the key is absent', () => {
    const stored = { 'personal|github|a/b': 'env-1' };

    expect(withoutEnvironmentChoice(stored, 'personal|github|c/d')).toEqual(stored);
  });
});

describe('parseStoredEnvironmentChoice', () => {
  it('reads the persisted map', () => {
    expect(parseStoredEnvironmentChoice('{"personal|github|a/b":"env-1"}')).toEqual({
      'personal|github|a/b': 'env-1',
    });
  });

  it('drops entries that are not environment ids', () => {
    expect(parseStoredEnvironmentChoice('{"a":"env-1","b":7,"c":null}')).toEqual({ a: 'env-1' });
  });

  it('starts empty for a missing or unreadable value', () => {
    expect(parseStoredEnvironmentChoice(null)).toEqual({});
    expect(parseStoredEnvironmentChoice('not json')).toEqual({});
    expect(parseStoredEnvironmentChoice('["env-1"]')).toEqual({});
  });
});
