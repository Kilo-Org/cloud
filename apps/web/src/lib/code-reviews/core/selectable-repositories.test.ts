import { describe, expect, it } from '@jest/globals';
import {
  buildAllowedRepositoryFullNames,
  buildSelectableRepositories,
} from './selectable-repositories';

const fetched = [{ id: 1, name: 'a', fullName: 'org/a', private: false }];
const manual = [
  // Duplicate of a fetched repo (by id) — dropped so it isn't listed twice.
  { id: 1, name: 'a', full_name: 'org/a', private: false },
  { id: 2, name: 'b', full_name: 'org/b', private: true },
];

describe('buildSelectableRepositories', () => {
  it('maps fetched repos and appends only non-duplicate manual entries', () => {
    const result = buildSelectableRepositories(fetched, manual);
    expect(result.map(repo => repo.full_name)).toEqual(['org/a', 'org/b']);
  });
});

describe('buildAllowedRepositoryFullNames', () => {
  it('returns the deduped set of allowed full names', () => {
    const allowed = buildAllowedRepositoryFullNames(fetched, manual);
    expect(allowed.has('org/a')).toBe(true);
    expect(allowed.has('org/b')).toBe(true);
    expect(allowed.has('org/not-listed')).toBe(false);
    expect(allowed.size).toBe(2);
  });
});
