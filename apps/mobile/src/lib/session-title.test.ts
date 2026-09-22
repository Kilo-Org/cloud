import { describe, expect, it } from 'vitest';

import { normalizeSessionTitle } from './session-title';

describe('normalizeSessionTitle', () => {
  it('keeps a real session title unchanged', () => {
    expect(normalizeSessionTitle('Fix the session header')).toBe('Fix the session header');
  });

  it('drops a generated "New session" placeholder title', () => {
    expect(normalizeSessionTitle('New session - 2026-09-22T02:05:22.778Z')).toBeUndefined();
  });

  it('drops a generated "Child session" placeholder title', () => {
    expect(normalizeSessionTitle('Child session - 2025-01-02T03:04:05.006Z')).toBeUndefined();
  });

  it('drops null and blank titles', () => {
    expect(normalizeSessionTitle(null)).toBeUndefined();
    expect(normalizeSessionTitle(undefined)).toBeUndefined();
    expect(normalizeSessionTitle('')).toBeUndefined();
    expect(normalizeSessionTitle('   ')).toBeUndefined();
  });

  it('keeps a title that merely resembles a placeholder', () => {
    expect(normalizeSessionTitle('New session - weekly review')).toBe(
      'New session - weekly review'
    );
    expect(normalizeSessionTitle('New session - 2026-09-22T02:05:22.778Z notes')).toBe(
      'New session - 2026-09-22T02:05:22.778Z notes'
    );
    expect(normalizeSessionTitle('New session - 2026-09-22T02:05:22Z')).toBe(
      'New session - 2026-09-22T02:05:22Z'
    );
  });
});
