import { describe, expect, it } from 'vitest';

import { readableSessionTitle } from './session-title';

describe('readableSessionTitle', () => {
  it.each([null, undefined, '', '   '])('treats %j as no title', value => {
    expect(readableSessionTitle(value)).toBeNull();
  });

  it.each(['New session - 2026-09-22T01:09:45.623Z', 'Child session - 2026-09-22T01:09:45.623Z'])(
    'treats the worker placeholder %s as no title',
    value => {
      expect(readableSessionTitle(value)).toBeNull();
    }
  );

  it('keeps a real title', () => {
    expect(readableSessionTitle('Fix login bug')).toBe('Fix login bug');
  });

  it('trims surrounding whitespace', () => {
    expect(readableSessionTitle('  Fix login bug  ')).toBe('Fix login bug');
  });

  it('keeps a title that only looks like the placeholder', () => {
    expect(readableSessionTitle('New session')).toBe('New session');
  });

  it('keeps a placeholder-shaped title with a partial timestamp', () => {
    expect(readableSessionTitle('New session - 2026-09-22T01:09:45Z')).toBe(
      'New session - 2026-09-22T01:09:45Z'
    );
  });
});
