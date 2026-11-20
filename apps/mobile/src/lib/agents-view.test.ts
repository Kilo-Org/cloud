import { describe, expect, it } from 'vitest';

import { parseAgentsViewParam } from './agents-view';

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
    expect(parseAgentsViewParam([])).toBe('sessions');
  });
});
