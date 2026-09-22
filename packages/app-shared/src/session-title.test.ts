import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SESSION_TITLE_PATTERN,
  displaySessionTitle,
  isDefaultSessionTitle,
  sessionTitleRenameSeed,
} from './session-title';

const NEW_SESSION_TITLE = 'New session - 2026-09-22T01:09:45.623Z';
const CHILD_SESSION_TITLE = 'Child session - 2026-09-22T01:09:45.623Z';

describe('isDefaultSessionTitle', () => {
  it('treats the backend machine titles as default', () => {
    expect(isDefaultSessionTitle(NEW_SESSION_TITLE)).toBe(true);
    expect(isDefaultSessionTitle(CHILD_SESSION_TITLE)).toBe(true);
    expect(DEFAULT_SESSION_TITLE_PATTERN.test(NEW_SESSION_TITLE)).toBe(true);
  });

  it('treats a chosen name as a real title', () => {
    expect(isDefaultSessionTitle('Fix login bug')).toBe(false);
  });

  it('treats a phrase-starting name as a real title', () => {
    // The pattern is anchored to the full machine shape, not the prefix.
    expect(isDefaultSessionTitle('New session - implementation plan')).toBe(false);
  });

  it('treats a non-ISO suffix as a real title', () => {
    expect(isDefaultSessionTitle('New session - 2026-09-22')).toBe(false);
    expect(isDefaultSessionTitle('New session - 2026-09-22T01:09:45Z')).toBe(false);
    expect(isDefaultSessionTitle('New session - 2026-09-22T01:09:45.623+00:00')).toBe(false);
  });

  it('treats blank, null, and undefined as default', () => {
    expect(isDefaultSessionTitle('')).toBe(true);
    expect(isDefaultSessionTitle('   ')).toBe(true);
    expect(isDefaultSessionTitle(null)).toBe(true);
    expect(isDefaultSessionTitle(undefined)).toBe(true);
  });
});

describe('displaySessionTitle', () => {
  it('returns the fallback for a default or blank title', () => {
    expect(displaySessionTitle(NEW_SESSION_TITLE, 'Session')).toBe('Session');
    expect(displaySessionTitle('', 'Session')).toBe('Session');
    expect(displaySessionTitle(null, 'Session')).toBe('Session');
    expect(displaySessionTitle(undefined, 'Session')).toBe('Session');
  });

  it('returns the title when the user chose one', () => {
    expect(displaySessionTitle('Fix login bug', 'Session')).toBe('Fix login bug');
    expect(displaySessionTitle('New session - implementation plan', 'Session')).toBe(
      'New session - implementation plan'
    );
  });
});

describe('sessionTitleRenameSeed', () => {
  it('opens the field empty for a default or blank title', () => {
    expect(sessionTitleRenameSeed(NEW_SESSION_TITLE)).toBe('');
    expect(sessionTitleRenameSeed(CHILD_SESSION_TITLE)).toBe('');
    expect(sessionTitleRenameSeed('')).toBe('');
    expect(sessionTitleRenameSeed('   ')).toBe('');
    expect(sessionTitleRenameSeed(null)).toBe('');
    expect(sessionTitleRenameSeed(undefined)).toBe('');
  });

  it('seeds the field with the trimmed chosen name', () => {
    expect(sessionTitleRenameSeed('Fix login bug')).toBe('Fix login bug');
    expect(sessionTitleRenameSeed('  Fix login bug  ')).toBe('Fix login bug');
  });
});
