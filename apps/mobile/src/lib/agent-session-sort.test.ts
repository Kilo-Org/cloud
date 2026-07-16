import { describe, expect, it } from 'vitest';

import {
  AGENT_SESSION_SORT_OPTIONS,
  type AgentSessionSortBy,
  DEFAULT_AGENT_SESSION_SORT,
  getAgentSessionTimestamp,
  parseAgentSessionSortBy,
} from './agent-session-sort';

describe('AGENT_SESSION_SORT_OPTIONS', () => {
  it('lists every supported sort field exactly once', () => {
    expect(AGENT_SESSION_SORT_OPTIONS).toEqual(['updated_at', 'created_at']);
  });
});

describe('DEFAULT_AGENT_SESSION_SORT', () => {
  it('defaults to updated_at so existing behavior is preserved', () => {
    expect(DEFAULT_AGENT_SESSION_SORT).toBe('updated_at');
  });
});

describe('parseAgentSessionSortBy', () => {
  it('accepts every option', () => {
    expect(parseAgentSessionSortBy('updated_at')).toBe<AgentSessionSortBy>('updated_at');
    expect(parseAgentSessionSortBy('created_at')).toBe<AgentSessionSortBy>('created_at');
  });

  it('defaults to updated_at for missing, empty, or non-string values', () => {
    expect(parseAgentSessionSortBy(undefined)).toBe('updated_at');
    expect(parseAgentSessionSortBy(null)).toBe('updated_at');
    expect(parseAgentSessionSortBy('')).toBe('updated_at');
    expect(parseAgentSessionSortBy(42)).toBe('updated_at');
    expect(parseAgentSessionSortBy({})).toBe('updated_at');
  });

  it('defaults to updated_at for unknown or legacy sort values', () => {
    expect(parseAgentSessionSortBy('title')).toBe('updated_at');
    expect(parseAgentSessionSortBy('updatedAt')).toBe('updated_at');
    expect(parseAgentSessionSortBy('createdAt')).toBe('updated_at');
  });
});

describe('getAgentSessionTimestamp', () => {
  it('returns updated_at verbatim when sort is updated_at', () => {
    expect(
      getAgentSessionTimestamp(
        { created_at: '2024-01-02T00:00:00.000Z', updated_at: '2024-06-01T00:00:00.000Z' },
        'updated_at'
      )
    ).toBe('2024-06-01T00:00:00.000Z');
  });

  it('returns created_at verbatim when sort is created_at', () => {
    expect(
      getAgentSessionTimestamp(
        { created_at: '2024-01-02T00:00:00.000Z', updated_at: '2024-06-01T00:00:00.000Z' },
        'created_at'
      )
    ).toBe('2024-01-02T00:00:00.000Z');
  });

  it('falls back to updated_at when sort is anything else', () => {
    expect(
      getAgentSessionTimestamp(
        { created_at: '2024-01-02T00:00:00.000Z', updated_at: '2024-06-01T00:00:00.000Z' },
        'title' as unknown as AgentSessionSortBy
      )
    ).toBe('2024-06-01T00:00:00.000Z');
  });
});
