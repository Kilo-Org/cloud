import { describe, expect, it } from 'vitest';

import { MAX_RESUME_OLDER_LOADS, parseResumeAnchor, planResumeScroll } from '@/lib/session-resume';

describe('parseResumeAnchor', () => {
  it('returns the trimmed first element of a repeated param', () => {
    expect(parseResumeAnchor('  msg_1  ')).toBe('msg_1');
    expect(parseResumeAnchor(['msg_1', 'msg_2'])).toBe('msg_1');
  });

  it('returns null for missing, empty and whitespace-only values', () => {
    expect(parseResumeAnchor(undefined)).toBeNull();
    expect(parseResumeAnchor('')).toBeNull();
    expect(parseResumeAnchor('   ')).toBeNull();
    expect(parseResumeAnchor([])).toBeNull();
  });
});

describe('planResumeScroll', () => {
  const base = {
    anchorIds: ['msg_a', null, 'msg_b'],
    hasOlderMessages: false,
    olderLoadAttempts: 0,
  };

  it('scrolls to the anchor row index', () => {
    expect(planResumeScroll({ ...base, anchorMessageId: 'msg_b' })).toEqual({
      kind: 'scroll',
      index: 2,
    });
  });

  it('scrolls to index 0 when the anchor is the first row', () => {
    expect(planResumeScroll({ ...base, anchorMessageId: 'msg_a' })).toEqual({
      kind: 'scroll',
      index: 0,
    });
  });

  it('loads older pages while the anchor is absent and a cursor remains', () => {
    expect(
      planResumeScroll({
        ...base,
        anchorMessageId: 'msg_older',
        hasOlderMessages: true,
        olderLoadAttempts: MAX_RESUME_OLDER_LOADS - 1,
      })
    ).toEqual({ kind: 'load-older' });
  });

  it('stops loading older pages at the bound', () => {
    expect(
      planResumeScroll({
        ...base,
        anchorMessageId: 'msg_older',
        hasOlderMessages: true,
        olderLoadAttempts: MAX_RESUME_OLDER_LOADS,
      })
    ).toEqual({ kind: 'none' });
  });

  it('never exceeds the hard bound even when the caller raises it', () => {
    expect(
      planResumeScroll({
        ...base,
        anchorMessageId: 'msg_older',
        hasOlderMessages: true,
        olderLoadAttempts: MAX_RESUME_OLDER_LOADS,
        maxOlderLoads: 100,
      })
    ).toEqual({ kind: 'none' });
  });

  it('returns none for an unknown anchor when no older history exists', () => {
    expect(
      planResumeScroll({
        ...base,
        anchorMessageId: 'msg_unknown',
        hasOlderMessages: false,
      })
    ).toEqual({ kind: 'none' });
  });

  it('returns none when no anchor is given, even with older history', () => {
    expect(
      planResumeScroll({
        ...base,
        anchorMessageId: null,
        hasOlderMessages: true,
      })
    ).toEqual({ kind: 'none' });
  });

  it('ignores a blank anchor like an absent one', () => {
    expect(planResumeScroll({ ...base, anchorMessageId: '   ' })).toEqual({ kind: 'none' });
  });
});
