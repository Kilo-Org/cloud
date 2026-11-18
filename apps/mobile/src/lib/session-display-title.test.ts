import { describe, expect, it } from 'vitest';

import { sessionDisplayTitle } from './session-display-title';

describe('sessionDisplayTitle', () => {
  it('returns a real title unchanged', () => {
    expect(sessionDisplayTitle('Fix the flaky test')).toBe('Fix the flaky test');
    expect(sessionDisplayTitle('Implementation plan')).toBe('Implementation plan');
  });

  it('trims surrounding whitespace from a real title', () => {
    expect(sessionDisplayTitle('  Fix the flaky test  ')).toBe('Fix the flaky test');
    expect(sessionDisplayTitle('  Implementation plan  ')).toBe('Implementation plan');
  });

  it('treats the backend placeholder as no title', () => {
    expect(sessionDisplayTitle('New session - 2026-09-22T01:09:45.623Z')).toBeUndefined();
    expect(sessionDisplayTitle('Child session - 2026-09-22T01:09:45.623Z')).toBeUndefined();
    expect(sessionDisplayTitle('New session - 2026-09-22T16:37:00.000Z')).toBeUndefined();
  });

  it('treats a placeholder with surrounding whitespace as no title', () => {
    expect(sessionDisplayTitle('  New session - 2026-09-22T01:09:45.623Z  ')).toBeUndefined();
  });

  it('treats null, undefined, and blank titles as no title', () => {
    expect(sessionDisplayTitle(null)).toBeUndefined();
    expect(sessionDisplayTitle(undefined)).toBeUndefined();
    expect(sessionDisplayTitle('')).toBeUndefined();
    expect(sessionDisplayTitle('   ')).toBeUndefined();
  });

  it('keeps a title that only resembles the placeholder', () => {
    // Not the exact shape the backend writes: a different separator, no
    // milliseconds, or a name after the prefix is a title a person wrote.
    expect(sessionDisplayTitle('New session - planning')).toBe('New session - planning');
    expect(sessionDisplayTitle('New session - implementation plan')).toBe(
      'New session - implementation plan'
    );
    expect(sessionDisplayTitle('New session plan for the login redirect')).toBe(
      'New session plan for the login redirect'
    );
    expect(sessionDisplayTitle('New session - next week')).toBe('New session - next week');
    expect(sessionDisplayTitle('New session - 2026-09-22T01:09:45.623Z notes')).toBe(
      'New session - 2026-09-22T01:09:45.623Z notes'
    );
    expect(sessionDisplayTitle('New session - 2026-09-22T01:09:45Z')).toBe(
      'New session - 2026-09-22T01:09:45Z'
    );
  });
});
