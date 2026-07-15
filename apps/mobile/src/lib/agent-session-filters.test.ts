import { describe, expect, it } from 'vitest';

import {
  createDefaultAgentSessionFilters,
  parseStoredAgentSessionFilters,
} from './agent-session-filters';

describe('agent session filters', () => {
  it('defaults Active now on for a new install', () => {
    expect(createDefaultAgentSessionFilters()).toEqual({
      activeNow: true,
      platformFilter: [],
      projectFilter: [],
    });
  });

  it('migrates an older stored value with Active now enabled', () => {
    expect(
      parseStoredAgentSessionFilters(
        JSON.stringify({ platformFilter: ['cli'], projectFilter: ['git@example/repo.git'] })
      )
    ).toEqual({
      activeNow: true,
      platformFilter: ['cli'],
      projectFilter: ['git@example/repo.git'],
    });
  });

  it('preserves an explicit disabled value', () => {
    expect(
      parseStoredAgentSessionFilters(
        JSON.stringify({ activeNow: false, platformFilter: [], projectFilter: [] })
      )
    ).toEqual({ activeNow: false, platformFilter: [], projectFilter: [] });
  });

  it.each([null, '', 'null', '[]', '{bad json'])('rejects invalid persisted input %j', raw => {
    expect(parseStoredAgentSessionFilters(raw)).toBeNull();
  });
});
