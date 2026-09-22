import { describe, expect, it } from 'vitest';

import { isPlaceholderSessionTitle, resolveSessionDisplayTitle } from './session-display-title';

describe('isPlaceholderSessionTitle', () => {
  it('treats null, undefined and blank titles as placeholders', () => {
    expect(isPlaceholderSessionTitle(null)).toBe(true);
    expect(isPlaceholderSessionTitle(undefined)).toBe(true);
    expect(isPlaceholderSessionTitle('')).toBe(true);
    expect(isPlaceholderSessionTitle('   ')).toBe(true);
  });

  it('treats both machine placeholder forms as placeholders', () => {
    expect(isPlaceholderSessionTitle('New session - 2026-09-22T04:17:22.503Z')).toBe(true);
    expect(isPlaceholderSessionTitle('Child session - 2026-09-22T04:17:22.503Z')).toBe(true);
  });

  it('treats a real title as user copy', () => {
    expect(isPlaceholderSessionTitle('New session - my plan')).toBe(false);
    expect(isPlaceholderSessionTitle('Refactor the parser')).toBe(false);
  });
});

describe('resolveSessionDisplayTitle', () => {
  const fallback = 'Session';

  it('returns the fallback for null and undefined', () => {
    expect(resolveSessionDisplayTitle(null, fallback)).toBe(fallback);
    expect(resolveSessionDisplayTitle(undefined, fallback)).toBe(fallback);
  });

  it('returns the fallback for empty and whitespace-only titles', () => {
    expect(resolveSessionDisplayTitle('', fallback)).toBe(fallback);
    expect(resolveSessionDisplayTitle('   ', fallback)).toBe(fallback);
  });

  it('returns the fallback for both machine placeholder forms', () => {
    expect(resolveSessionDisplayTitle('New session - 2026-09-22T04:17:22.503Z', fallback)).toBe(
      fallback
    );
    expect(resolveSessionDisplayTitle('Child session - 2026-09-22T04:17:22.503Z', fallback)).toBe(
      fallback
    );
  });

  it('returns a real title verbatim', () => {
    expect(resolveSessionDisplayTitle('New session - my plan', fallback)).toBe(
      'New session - my plan'
    );
  });

  it('trims leading and trailing whitespace on a real title', () => {
    expect(resolveSessionDisplayTitle('  Refactor the parser  ', fallback)).toBe(
      'Refactor the parser'
    );
  });
});
