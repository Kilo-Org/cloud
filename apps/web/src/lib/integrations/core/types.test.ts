import { describe, expect, it } from '@jest/globals';
import { findRepositoryIdByFullName } from './types';
import type { PlatformRepository } from '@kilocode/db/schema-types';

const repositories: PlatformRepository[] = [
  { id: 1, name: 'cloud', full_name: 'kilocode/cloud', private: true },
  { id: 2, name: 'extension', full_name: 'kilocode/extension', private: false },
];

describe('findRepositoryIdByFullName', () => {
  it('returns the matching repository id', () => {
    expect(findRepositoryIdByFullName(repositories, 'kilocode/cloud')).toBe(1);
  });

  it('matches case-insensitively', () => {
    expect(findRepositoryIdByFullName(repositories, 'KiloCode/Cloud')).toBe(1);
  });

  it('returns null when there is no match', () => {
    expect(findRepositoryIdByFullName(repositories, 'kilocode/missing')).toBeNull();
  });

  it('returns null for a null repository list', () => {
    expect(findRepositoryIdByFullName(null, 'kilocode/cloud')).toBeNull();
  });

  it('returns null for an empty repository list', () => {
    expect(findRepositoryIdByFullName([], 'kilocode/cloud')).toBeNull();
  });
});
