import { describe, expect, it } from 'vitest';

import { displaySessionTitle } from './session-title';

describe('displaySessionTitle', () => {
  it('hides a backend default session title so the surface can show its own copy', () => {
    expect(displaySessionTitle('New session - 2026-09-20T08:10:35.172Z')).toBeUndefined();
    expect(displaySessionTitle('Child session - 2026-09-20T08:10:35.172Z')).toBeUndefined();
  });

  it('keeps a real session title', () => {
    expect(displaySessionTitle('Refactor the billing webhook')).toBe(
      'Refactor the billing webhook'
    );
  });

  it('treats a missing or empty title as untitled', () => {
    expect(displaySessionTitle(undefined)).toBeUndefined();
    expect(displaySessionTitle(null)).toBeUndefined();
    expect(displaySessionTitle('')).toBeUndefined();
  });

  it('keeps a title that merely looks similar to the default pattern', () => {
    expect(displaySessionTitle('New session - today')).toBe('New session - today');
  });
});
