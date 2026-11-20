import { describe, expect, it } from 'vitest';

import { type AgentsView, agentsViewParam, parseAgentsViewParam } from './agents-view';

describe('parseAgentsViewParam', () => {
  it('selects To-dos for the one value that names it', () => {
    expect(parseAgentsViewParam('todos')).toBe('todos');
  });

  it('keeps Sessions for an absent, empty or unknown value', () => {
    expect(parseAgentsViewParam(undefined)).toBe('sessions');
    expect(parseAgentsViewParam('')).toBe('sessions');
    expect(parseAgentsViewParam('todos-list')).toBe('sessions');
    expect(parseAgentsViewParam('TODOS')).toBe('sessions');
  });

  it('reads the first entry of a repeated parameter, as a query string does', () => {
    expect(parseAgentsViewParam(['todos', 'sessions'])).toBe('todos');
    expect(parseAgentsViewParam(['sessions', 'todos'])).toBe('sessions');
  });
});

describe('agentsViewParam', () => {
  it('names To-dos and leaves Sessions to the default', () => {
    expect(agentsViewParam('todos')).toBe('todos');
    expect(agentsViewParam('sessions')).toBeUndefined();
  });

  it('round-trips every view', () => {
    const views: readonly AgentsView[] = ['sessions', 'todos'];
    for (const view of views) {
      const written = agentsViewParam(view);
      // A written value is what a link carries; Sessions writes nothing, so
      // the absent value stands in for it on the way back.
      expect(parseAgentsViewParam(written)).toBe(view);
    }
  });
});
