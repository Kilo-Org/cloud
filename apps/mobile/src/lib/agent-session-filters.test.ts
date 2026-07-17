import { describe, expect, it } from 'vitest';

import {
  type AgentSessionFilters,
  clearAgentSessionNarrowingFilters,
  createDefaultAgentSessionFilters,
  parseStoredAgentSessionFilters,
} from './agent-session-filters';

describe('createDefaultAgentSessionFilters', () => {
  it('returns empty narrowing filters and the default sort', () => {
    expect(createDefaultAgentSessionFilters()).toEqual({
      platformFilter: [],
      projectFilter: [],
      sortBy: 'updated_at',
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
      sortBy: 'updated_at',
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
      sortBy: 'updated_at',
    });
  });

  it('accepts a stored sortBy value', () => {
    const raw = JSON.stringify({
      platformFilter: [],
      projectFilter: [],
      sortBy: 'created_at',
    });
    expect(parseStoredAgentSessionFilters(raw)?.sortBy).toBe('created_at');
  });

  it('defaults sortBy to updated_at for missing, malformed, or unknown values', () => {
    expect(
      parseStoredAgentSessionFilters(JSON.stringify({ platformFilter: [], projectFilter: [] }))
        ?.sortBy
    ).toBe('updated_at');
    expect(
      parseStoredAgentSessionFilters(
        JSON.stringify({ platformFilter: [], projectFilter: [], sortBy: 'title' })
      )?.sortBy
    ).toBe('updated_at');
    expect(
      parseStoredAgentSessionFilters(
        JSON.stringify({ platformFilter: [], projectFilter: [], sortBy: 42 })
      )?.sortBy
    ).toBe('updated_at');
  });
});

describe('clearAgentSessionNarrowingFilters', () => {
  const current: AgentSessionFilters = {
    platformFilter: ['cli'],
    projectFilter: ['https://github.com/foo/bar'],
    sortBy: 'created_at',
  };

  it('resets platform and project filters but preserves sortBy', () => {
    expect(clearAgentSessionNarrowingFilters(current)).toEqual({
      platformFilter: [],
      projectFilter: [],
      sortBy: 'created_at',
    });
  });

  it('does not mutate the input', () => {
    const snapshot: AgentSessionFilters = {
      ...current,
      platformFilter: [...current.platformFilter],
    };
    clearAgentSessionNarrowingFilters(current);
    expect(current).toEqual(snapshot);
  });
});
