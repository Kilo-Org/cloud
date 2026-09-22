import { describe, expect, it } from 'vitest';

import { isPlaceholderSessionTitle, resolveSessionDisplayTitle } from './session-display-title';

describe('isPlaceholderSessionTitle', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['new-session placeholder', 'New session - 2026-09-22T04:17:22.503Z'],
    ['child-session placeholder', 'Child session - 2026-09-22T04:17:22.503Z'],
  ])('is true for %s', (_label, title) => {
    expect(isPlaceholderSessionTitle(title)).toBe(true);
  });

  it.each([
    ['a real title', 'Fix the login bug'],
    ['a title that merely starts like a placeholder', 'New session - my plan'],
    ['a real title with surrounding whitespace', '  Fix the login bug  '],
  ])('is false for %s', (_label, title) => {
    expect(isPlaceholderSessionTitle(title)).toBe(false);
  });
});

describe('resolveSessionDisplayTitle', () => {
  const fallback = 'Session';

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['new-session placeholder', 'New session - 2026-09-22T04:17:22.503Z'],
    ['child-session placeholder', 'Child session - 2026-09-22T04:17:22.503Z'],
  ])('returns the fallback for %s', (_label, title) => {
    expect(resolveSessionDisplayTitle(title, fallback)).toBe(fallback);
  });

  it('returns a real title verbatim', () => {
    expect(resolveSessionDisplayTitle('Fix the login bug', fallback)).toBe('Fix the login bug');
  });

  it('trims whitespace around a real title', () => {
    expect(resolveSessionDisplayTitle('  Fix the login bug  ', fallback)).toBe('Fix the login bug');
  });

  it('keeps a title that merely starts like a placeholder', () => {
    expect(resolveSessionDisplayTitle('New session - my plan', fallback)).toBe(
      'New session - my plan'
    );
  });
});
