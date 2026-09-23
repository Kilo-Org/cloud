import { describe, expect, it } from 'vitest';

import { resolveSessionDisplayTitle } from './session-title';

describe('resolveSessionDisplayTitle', () => {
  it('keeps a real title unchanged', () => {
    expect(resolveSessionDisplayTitle('Fix the login redirect')).toBe('Fix the login redirect');
  });

  it('trims surrounding whitespace from a real title', () => {
    expect(resolveSessionDisplayTitle('  Fix the login redirect  ')).toBe('Fix the login redirect');
  });

  it('drops the server creation-default placeholder for a top-level session', () => {
    // The server writes `New session - ${new Date().toISOString()}` at
    // creation and session-ingest only replaces it after the first message.
    // It is an internal marker, never a user-visible title.
    expect(resolveSessionDisplayTitle('New session - 2026-09-21T15:44:47.176Z')).toBeUndefined();
  });

  it('drops the server creation-default placeholder for a child session', () => {
    expect(resolveSessionDisplayTitle('Child session - 2026-09-21T15:44:47.176Z')).toBeUndefined();
  });

  it('keeps a real title that merely starts with "New session"', () => {
    expect(resolveSessionDisplayTitle('New session plan for the login redirect')).toBe(
      'New session plan for the login redirect'
    );
    // Same prefix, but not the exact ISO-8601 shape the server stamps.
    expect(resolveSessionDisplayTitle('New session - next week')).toBe('New session - next week');
  });

  it('returns undefined for a missing, blank, or empty title', () => {
    expect(resolveSessionDisplayTitle(undefined)).toBeUndefined();
    expect(resolveSessionDisplayTitle(null)).toBeUndefined();
    expect(resolveSessionDisplayTitle('')).toBeUndefined();
    expect(resolveSessionDisplayTitle('   ')).toBeUndefined();
  });
});
