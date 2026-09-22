import { describe, expect, it } from 'vitest';

import { sessionDisplayTitle } from './session-display-title';

const FALLBACK = 'Session';

describe('sessionDisplayTitle', () => {
  it.each(['New session - 2026-09-22T16:26:40.799Z', 'Child session - 2026-09-22T16:26:40.799Z'])(
    'replaces the backend machine placeholder %s with the fallback',
    title => {
      expect(sessionDisplayTitle(title, FALLBACK)).toBe(FALLBACK);
    }
  );

  it.each([null, undefined, ''])('falls back for a blank title (%s)', title => {
    expect(sessionDisplayTitle(title, FALLBACK)).toBe(FALLBACK);
  });

  it('keeps a real name verbatim', () => {
    expect(sessionDisplayTitle('Fix login', FALLBACK)).toBe('Fix login');
  });

  it('keeps a near-miss that is not the backend placeholder', () => {
    expect(sessionDisplayTitle('New session - 2026-09-22', FALLBACK)).toBe(
      'New session - 2026-09-22'
    );
  });
});
