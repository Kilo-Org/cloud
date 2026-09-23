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

  it('counts an empty project filter as zero', () => {
    expect(countActiveSessionFilters(createDefaultAgentSessionFilters())).toBe(0);
  });

  it('counts one project option as one', () => {
    expect(
      countActiveSessionFilters({
        platformFilter: [],
        projectFilter: ['https://github.com/org/repo.git'],
      })
    ).toBe(1);
  });

  it('counts one merged project option once across its git-URL aliases', () => {
    expect(
      countActiveSessionFilters({
        platformFilter: [],
        projectFilter: ['https://github.com/org/repo.git', 'git@github.com:org/repo.git'],
      })
    ).toBe(1);
  });

  it('counts two distinct projects as two', () => {
    expect(
      countActiveSessionFilters({
        platformFilter: [],
        projectFilter: ['https://github.com/org/a', 'https://github.com/org/b'],
      })
    ).toBe(2);
  });

  it('counts a persisted platform bucket and its variant as one checked row', () => {
    expect(
      countActiveSessionFilters({
        platformFilter: ['cloud-agent', 'cloud-agent-web'],
        projectFilter: [],
      })
    ).toBe(1);
    expect(
      countActiveSessionFilters({
        platformFilter: ['extension', 'vscode', 'agent-manager'],
        projectFilter: [],
      })
    ).toBe(1);
  });

  it('counts distinct platform buckets separately', () => {
    expect(countActiveSessionFilters({ platformFilter: ['cli', 'slack'], projectFilter: [] })).toBe(
      2
    );
  });

  it('counts an unknown platform as its own row', () => {
    expect(countActiveSessionFilters({ platformFilter: ['jetbrains'], projectFilter: [] })).toBe(1);
  });
});

it('ignores a legacy stored sortBy field', () => {
  expect(
    parseStoredAgentSessionFilters(
      JSON.stringify({ platformFilter: ['cli'], projectFilter: [], sortBy: 'created_at' })
    )
  ).toEqual({ platformFilter: ['cli'], projectFilter: [] });
});
