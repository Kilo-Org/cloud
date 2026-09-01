import { describe, expect, it } from 'vitest';

import {
  countActiveSessionFilters,
  createDefaultAgentSessionFilters,
  parseStoredAgentSessionFilters,
} from './agent-session-filters';

describe('createDefaultAgentSessionFilters', () => {
  it('returns empty narrowing filters', () => {
    expect(createDefaultAgentSessionFilters()).toEqual({
      platformFilter: [],
      projectFilter: [],
    });
  });
});

describe('parseStoredAgentSessionFilters', () => {
  it('returns null for invalid JSON', () => {
    expect(parseStoredAgentSessionFilters('not json')).toBeNull();
  });

  it('returns null for non-object JSON', () => {
    expect(parseStoredAgentSessionFilters('null')).toBeNull();
    expect(parseStoredAgentSessionFilters('42')).toBeNull();
    expect(parseStoredAgentSessionFilters('"hi"')).toBeNull();
    expect(parseStoredAgentSessionFilters('[1,2,3]')).toBeNull();
  });

  it('tolerantly parses platform and project arrays', () => {
    const raw = JSON.stringify({
      platformFilter: ['cli', 'cloud-agent'],
      projectFilter: ['https://github.com/foo/bar'],
    });
    expect(parseStoredAgentSessionFilters(raw)).toEqual({
      platformFilter: ['cli', 'cloud-agent'],
      projectFilter: ['https://github.com/foo/bar'],
    });
  });

  it('drops non-string entries from array filters', () => {
    const raw = JSON.stringify({
      platformFilter: ['cli', 42, null, 'extension'],
      projectFilter: [{}, 'https://x', 'y'],
    });
    expect(parseStoredAgentSessionFilters(raw)).toEqual({
      platformFilter: ['cli', 'extension'],
      projectFilter: ['https://x', 'y'],
    });
  });
});

describe('countActiveSessionFilters', () => {
  it('counts both narrowing dimensions', () => {
    expect(countActiveSessionFilters(createDefaultAgentSessionFilters())).toBe(0);
    expect(
      countActiveSessionFilters({
        platformFilter: ['cli', 'slack'],
        projectFilter: ['https://github.com/foo/bar'],
      })
    ).toBe(3);
  });
});

it('ignores a legacy stored sortBy field', () => {
  expect(
    parseStoredAgentSessionFilters(
      JSON.stringify({ platformFilter: ['cli'], projectFilter: [], sortBy: 'created_at' })
    )
  ).toEqual({ platformFilter: ['cli'], projectFilter: [] });
});
