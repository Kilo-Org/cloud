import { describe, expect, it } from 'vitest';

import { isDefaultSessionTitle, resolveSessionDisplayTitle } from './session-title';

describe('isDefaultSessionTitle', () => {
  it('recognises the server creation-default placeholder', () => {
    expect(isDefaultSessionTitle('New session - 2026-09-21T15:44:47.176Z')).toBe(true);
    expect(isDefaultSessionTitle('Child session - 2026-09-21T15:44:47.176Z')).toBe(true);
  });

  it('treats absent input as default', () => {
    expect(isDefaultSessionTitle(null)).toBe(true);
    expect(isDefaultSessionTitle(undefined)).toBe(true);
  });

  it('does not treat a real title as default', () => {
    expect(isDefaultSessionTitle('Fix login')).toBe(false);
    expect(isDefaultSessionTitle('New session planning')).toBe(false);
  });
});

describe('resolveSessionDisplayTitle', () => {
  it('resolves the creation-default placeholder to undefined', () => {
    expect(resolveSessionDisplayTitle('New session - 2026-09-21T15:44:47.176Z')).toBeUndefined();
    expect(resolveSessionDisplayTitle('Child session - 2026-09-21T15:44:47.176Z')).toBeUndefined();
  });

  it('keeps a real title that merely starts with "New session"', () => {
    expect(resolveSessionDisplayTitle('New session table design')).toBe('New session table design');
  });

  it('resolves blank, null and undefined input to undefined', () => {
    expect(resolveSessionDisplayTitle(null)).toBeUndefined();
    expect(resolveSessionDisplayTitle(undefined)).toBeUndefined();
    expect(resolveSessionDisplayTitle('   ')).toBeUndefined();
  });

  it('trims a real title', () => {
    expect(resolveSessionDisplayTitle('  Fix login  ')).toBe('Fix login');
  });
});
